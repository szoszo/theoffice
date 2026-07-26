import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv } from "./agent-env.js";
import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { newSession } from "./tmux.js";
import { writeAgentSettings } from "./profile.js";
import { markDelivering, markDelivered, markFailed, requeue, requeueNoPenalty, MAX_DELIVERY_ATTEMPTS } from "../queue/index.js";
import { recordInbound } from "../memory/conversation.js";
import type { Runtime, QueuedItem } from "./runtime.js";
import { frameForDelivery } from "./delivery.js";

/**
 * Codex runtime path (Pete-on-Codex pilot). A `runtime: "codex"` agent does NOT run a persistent TUI
 * we inject into; instead each queued prompt is one `codex exec --json` subprocess, and completion is
 * the structured `turn.completed` event (validated by the spike) — far more robust than scraping a TUI.
 *
 * The tmux session for a codex agent is just an idle HOLDER so the agent shows "running" and the
 * lifecycle/reaper see it; the real work runs in the exec subprocess, not the pane. office-say + the
 * dashboard curl work inside the exec via the same .reply-context + OFFICE_* env as the claude path —
 * fully model-agnostic.
 *
 * This whole module is inert until an agent's runtime flag is flipped to "codex" (the gated cutover).
 */
const logger = log("codex");
// On a ChatGPT usage cap (rolling 5h / weekly window, SHARED with the owner's own ChatGPT/Codex use) we
// hold delivery rather than burn retries: the cap is transient, so we wait then try again. 15 min is gentle
// and will succeed once the window rolls. If codex ever surfaces an exact reset time we can honor it here.
const USAGE_BACKOFF_MS = 15 * 60_000;
// Heuristic match on codex output for "you hit a usage/rate limit" across stdout JSON + stderr text.
const USAGE_LIMIT_RE =
  /usage limit|rate limit|too many requests|quota|\b429\b|try again later|limit reached|reached your .*limit|you (?:have|'ve) hit/i;
// P0#1 watchdog: codex exec has NO turn timeout of its own — a hung turn would hold inFlight forever and
// silently wedge the agent. Hard-kill the subprocess after this long; the kill routes through the normal
// terminal handler as a no-penalty requeue (our kill, not the message's fault).
const TURN_TIMEOUT_MS = 13 * 60_000;

export type CodexOutcome = "delivered" | "backoff" | "failed" | "requeue";

/**
 * Pure decision for a finished codex turn — factored out so the (exit code, completion, usage-cap,
 * attempts) -> outcome mapping is table-testable without spawning anything.
 *  - clean exit WITH turn.completed            -> delivered
 *  - usage/rate cap seen                        -> backoff (hold + requeueNoPenalty, no attempt burned)
 *  - otherwise, budget exhausted                -> failed
 *  - otherwise                                  -> requeue (bounded retry)
 */
export function decideCodexOutcome(o: {
  code: number | null;
  sawCompleted: boolean;
  sawUsageLimit: boolean;
  attempts: number;
  maxAttempts?: number;
}): CodexOutcome {
  if (o.code === 0 && o.sawCompleted) return "delivered";
  if (o.sawUsageLimit) return "backoff";
  return o.attempts >= (o.maxAttempts ?? MAX_DELIVERY_ATTEMPTS) ? "failed" : "requeue";
}

// agents with a codex exec currently running -> skip new delivery for them until it finishes
const inFlight = new Set<string>();
// agentId -> epoch ms until which we hold delivery after hitting a usage cap (transient back-off)
const cooldownUntil = new Map<string, number>();

export function isCodexBusy(agentId: string): boolean {
  if (inFlight.has(agentId)) return true;
  const until = cooldownUntil.get(agentId);
  if (until && Date.now() < until) return true; // in usage-cap back-off -> leave items queued, no attempt burned
  return false;
}

function codexEnv(cfg: EngineConfig, agent: AgentDef): Record<string, string> {
  // Shared builder: applies the agent's .env FIRST, then the engine's reserved keys overwrite it, so a
  // stray .env line (PATH=/HOME=/OFFICE_PORT=) can't break office-say or redirect the agent. See agent-env.ts.
  return buildAgentEnv(cfg, agent);
}

/**
 * Launch an idle tmux HOLDER for a codex agent (so it reads as "running" + the reaper keeps it).
 * The actual turns run as `codex exec` subprocesses against agent.dir, not in this pane.
 */
export function launchCodexHolder(cfg: EngineConfig, agent: AgentDef): boolean {
  const session = `agent-${agent.id}`;
  // benign idle process; never accepts injected input — codex work is the exec subprocess
  const command = ["bash", "-lc", "echo 'codex holder (work runs via codex exec)'; exec sleep infinity"];
  writeAgentSettings(cfg, agent); // keep the security profile regen parity with the claude path
  const ok = newSession(cfg.tmux.socket, session, { cwd: agent.dir, command, env: codexEnv(cfg, agent) });
  logger.info({ agent: agent.id, session, ok }, ok ? "launched codex holder" : "codex holder skipped (exists?)");
  return ok;
}

/**
 * Deliver one prompt to a codex agent: spawn `codex exec --json` async, key completion off the
 * `turn.completed` event, then mark the queue item delivered. NON-BLOCKING — returns immediately and
 * tracks in-flight so the deliverer loop is never stalled for other agents.
 */
export function deliverCodexPrompt(cfg: EngineConfig, agent: AgentDef, item: QueuedItem): void {
  if (inFlight.has(agent.id)) return;

  const env = codexEnv(cfg, agent);
  if (item.source === "channel" && item.reply_channel) {
    env.OFFICE_REPLY_CHANNEL = item.reply_channel;
    try {
      writeFileSync(join(agent.dir, ".reply-context"), item.reply_channel);
    } catch {
      /* best-effort */
    }
  }
  const prompt = frameForDelivery(item);
  // unattended posture, same spirit as claude's --dangerously-skip-permissions (the box is the boundary):
  // no approval prompts, no sandbox restriction so the agent can office-say / git / write the vault.
  const args = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt];

  // Codex P3 spawn-safety: claim in-flight + charge the attempt ONLY after the subprocess actually spawned.
  // If spawn() throws synchronously (bad PATH, ENOMEM) we must NOT leave inFlight set (that would wedge the
  // agent "busy" forever); charge an attempt and requeue with the normal bounded budget instead.
  let child;
  try {
    // CRITICAL: stdin = /dev/null (EOF), NOT an open pipe. `codex exec` reads stdin for "additional input"
    // after the positional prompt; node's default stdio leaves stdin open, so codex blocks forever (futex
    // wait, no session, no turn). "ignore" gives immediate EOF. (Root cause of the first cutover hang, 2026-06-12.)
    child = spawn("codex", args, { cwd: agent.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    markDelivering(item.id); // charge an attempt so the failure budget bounds a persistent spawn fault
    const why = `codex spawn threw: ${String((err as Error).message ?? err)}`;
    if (item.attempts >= MAX_DELIVERY_ATTEMPTS) markFailed(item.id, why);
    else requeue(item.id);
    logger.error({ id: item.id, agent: agent.id, why }, "codex spawn threw -> requeued (inFlight NOT held)");
    return;
  }

  inFlight.add(agent.id);
  markDelivering(item.id);

  let sawCompleted = false;
  let sawUsageLimit = false;
  let buf = "";
  let settled = false; // latch: 'error' is usually FOLLOWED by 'close' — book the terminal outcome exactly once
  let timedOut = false;

  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, TURN_TIMEOUT_MS);

  // One terminal handler for both 'close' and 'error'. settled-latch -> runs once; clears the watchdog and
  // releases inFlight on EVERY path so the agent can never get stuck busy.
  const finish = (code: number | null, errMsg?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    inFlight.delete(agent.id);

    if (timedOut) {
      // our kill, not the message's fault -> refund the attempt and retry next tick
      requeueNoPenalty(item.id);
      logger.warn({ id: item.id, agent: agent.id, timeoutMin: TURN_TIMEOUT_MS / 60_000 }, "codex turn watchdog timeout -> killed + requeued (no attempt charged)");
      return;
    }
    const outcome = decideCodexOutcome({ code, sawCompleted, sawUsageLimit, attempts: item.attempts });
    if (outcome === "delivered") {
      markDelivered(item.id);
      recordInbound(item.agent_id, item.reply_channel, item.prompt);
      logger.info({ id: item.id, agent: agent.id }, "codex prompt delivered (turn.completed)");
    } else if (outcome === "backoff") {
      cooldownUntil.set(agent.id, Date.now() + USAGE_BACKOFF_MS);
      requeueNoPenalty(item.id);
      logger.warn({ id: item.id, agent: agent.id, code, backoffMin: USAGE_BACKOFF_MS / 60_000 }, "codex usage cap -> holding (no attempt charged)");
    } else if (outcome === "failed") {
      markFailed(item.id, errMsg ?? `exit ${code}, turn.completed=${sawCompleted}`);
      logger.warn({ id: item.id, agent: agent.id, code }, "codex delivery failed (max attempts)");
    } else {
      requeue(item.id);
      logger.warn({ id: item.id, agent: agent.id, code }, "codex exec not clean -> requeued");
    }
  };

  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        if (JSON.parse(line)?.type === "turn.completed") sawCompleted = true;
      } catch {
        /* non-JSON line, ignore */
      }
      if (USAGE_LIMIT_RE.test(line)) sawUsageLimit = true; // error events sometimes ride on stdout
    }
  });
  // codex surfaces auth/limit errors on stderr too
  child.stderr.on("data", (d: Buffer) => {
    if (USAGE_LIMIT_RE.test(d.toString())) sawUsageLimit = true;
  });

  child.on("close", (code) => finish(code));
  child.on("error", (err) => finish(null, `spawn error: ${String((err as Error).message ?? err)}`));
}

export const codexRuntime: Runtime = {
  id: "codex",
  label: "OpenAI Codex (GPT-5.5)",
  // Codex uses the signed-in ChatGPT account's model, not a per-launch flag, so no selectable list.
  models: [],
  efforts: [],
  launch: launchCodexHolder,
  isBusy: isCodexBusy,
  deliver: deliverCodexPrompt,
};
