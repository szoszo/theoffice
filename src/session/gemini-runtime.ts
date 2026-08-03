import { spawn } from "node:child_process";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv } from "./agent-env.js";
import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { newSession } from "./tmux.js";
import { writeAgentSettings } from "./profile.js";
import { linkTenantSkills } from "./skills-link.js";
import { markDelivering, markDelivered, markFailed, requeue, requeueNoPenalty, MAX_DELIVERY_ATTEMPTS } from "../queue/index.js";
import { recordInbound } from "../memory/conversation.js";
import type { Runtime, QueuedItem } from "./runtime.js";
import { frameForDelivery } from "./delivery.js";

/**
 * Gemini runtime — drives an agent on Google's Antigravity CLI (`agy`), the successor to the Gemini CLI
 * (Google sunsets Gemini CLI consumer access on 2026-06-18; Antigravity is the surviving path for a
 * Google AI Pro/Ultra subscription). Modelled on the codex runtime: a `runtime: "gemini"` agent does NOT
 * run a persistent TUI we inject into — each queued prompt is one `agy --print` subprocess and completion
 * is the process exiting cleanly (code 0). Antigravity's print mode emits the final answer as plain text
 * rather than a structured turn event, so completion is keyed off the exit code, not a JSON marker.
 *
 * The tmux session for a gemini agent is just an idle HOLDER so the agent reads as "running" and the
 * reaper keeps it; the real work runs in the `agy` subprocess. office-say + the dashboard curl work
 * inside the exec via the same .reply-context + OFFICE_* env as the claude/codex paths — model-agnostic.
 *
 * Inert until an agent's runtime flag is flipped to "gemini" (the gated cutover). Auth is the owner's
 * one-time `agy` sign-in (browser/SSH device-style URL) against their subscription account.
 */
const logger = log("gemini");
// On a subscription usage cap (Antigravity's rolling window, shared with the owner's own Antigravity use)
// hold delivery rather than burn retries: the cap is transient, so we wait then try again.
const USAGE_BACKOFF_MS = 15 * 60_000;
// Heuristic match for "you hit a usage/rate/quota limit" across stdout + stderr.
const USAGE_LIMIT_RE =
  /usage limit|rate limit|too many requests|quota|\b429\b|try again later|limit reached|reached your .*limit|resource exhausted/i;
// `agy --print` waits up to --print-timeout (default 5m). Give the turn generous headroom before we kill it.
const PRINT_TIMEOUT = "10m";
// P0#1 watchdog: belt-and-suspenders above agy's own --print-timeout in case the CLI itself wedges and
// never honors it. Hard-kill the subprocess; the kill routes through the terminal handler as a no-penalty
// requeue (our kill, not the message's fault). Kept above PRINT_TIMEOUT so agy self-times-out first normally.
const TURN_TIMEOUT_MS = 13 * 60_000;

export type GeminiOutcome = "delivered" | "backoff" | "failed" | "requeue";

/**
 * Pure decision for a finished gemini turn — completion is keyed off a clean exit (no structured event).
 * Factored out so (exit code, usage-cap, attempts) -> outcome is table-testable without spawning.
 */
export function decideGeminiOutcome(o: {
  code: number | null;
  sawUsageLimit: boolean;
  attempts: number;
  maxAttempts?: number;
}): GeminiOutcome {
  if (o.code === 0) return "delivered";
  if (o.sawUsageLimit) return "backoff";
  return o.attempts >= (o.maxAttempts ?? MAX_DELIVERY_ATTEMPTS) ? "failed" : "requeue";
}

// agents with an `agy` exec currently running -> skip new delivery for them until it finishes
const inFlight = new Set<string>();
// agentId -> epoch ms until which we hold delivery after hitting a usage cap (transient back-off)
const cooldownUntil = new Map<string, number>();

export function isGeminiBusy(agentId: string): boolean {
  if (inFlight.has(agentId)) return true;
  const until = cooldownUntil.get(agentId);
  if (until && Date.now() < until) return true; // in usage-cap back-off -> leave items queued, no attempt burned
  return false;
}

function geminiEnv(cfg: EngineConfig, agent: AgentDef): Record<string, string> {
  // Shared builder: applies the agent's .env FIRST, then the engine's reserved keys overwrite it, so a
  // stray .env line (PATH=/HOME=/OFFICE_PORT=) can't break office-say or redirect the agent. See agent-env.ts.
  return buildAgentEnv(cfg, agent);
}

/**
 * Launch an idle tmux HOLDER for a gemini agent (so it reads as "running" + the reaper keeps it).
 * The actual turns run as `agy --print` subprocesses against agent.dir, not in this pane.
 */
export function launchGeminiHolder(cfg: EngineConfig, agent: AgentDef): boolean {
  const session = `agent-${agent.id}`;
  const command = ["bash", "-lc", "echo 'gemini holder (work runs via agy --print)'; exec sleep infinity"];
  writeAgentSettings(cfg, agent); // keep the security profile regen parity with the claude/codex paths
  linkTenantSkills(cfg.paths.skillsDir, agent.dir); // parity with the claude path
  // Antigravity's `agy` reads its persona/instructions from AGENTS.md, NOT CLAUDE.md (verified live
  // 2026-06-15: without this, agy thinks it's a generic "Antigravity" assistant and ignores the agent's
  // role + the office-say reply protocol). Expose the agent's CLAUDE.md as AGENTS.md via a relative
  // symlink so there's a single source of truth. Idempotent: EEXIST is the normal steady state.
  try {
    symlinkSync("CLAUDE.md", join(agent.dir, "AGENTS.md"));
  } catch {
    /* already linked (EEXIST) or fs without symlinks — best-effort */
  }
  const ok = newSession(cfg.tmux.socket, session, { cwd: agent.dir, command, env: geminiEnv(cfg, agent) });
  logger.info({ agent: agent.id, session, ok }, ok ? "launched gemini holder" : "gemini holder skipped (exists?)");
  return ok;
}

/**
 * Deliver one prompt to a gemini agent: spawn `agy --print` async, key completion off a clean exit, then
 * mark the queue item delivered. NON-BLOCKING — returns immediately and tracks in-flight so the deliverer
 * loop is never stalled for other agents.
 */
export function deliverGeminiPrompt(cfg: EngineConfig, agent: AgentDef, item: QueuedItem): void {
  if (inFlight.has(agent.id)) return;

  const env = geminiEnv(cfg, agent);
  if (item.source === "channel" && item.reply_channel) {
    env.OFFICE_REPLY_CHANNEL = item.reply_channel;
    try {
      writeFileSync(join(agent.dir, ".reply-context"), item.reply_channel);
    } catch {
      /* best-effort */
    }
  }
  const prompt = frameForDelivery(item);
  // Flags BEFORE the prompt value (Go flag parsing stops at the first non-flag arg). Model selection is
  // left to the agent's signed-in default unless agent.model overrides it. Unattended posture mirrors the
  // claude/codex paths: --dangerously-skip-permissions so the agent can office-say / git / write the vault.
  const args = ["--dangerously-skip-permissions", "--print-timeout", PRINT_TIMEOUT];
  if (agent.model && agent.model !== "default") args.push("--model", agent.model);
  args.push("--print", prompt);

  let sawUsageLimit = false;
  const scan = (s: string) => {
    if (USAGE_LIMIT_RE.test(s)) sawUsageLimit = true;
  };

  // Spawn-safety (mirrors codex): claim in-flight + charge the attempt ONLY after the subprocess spawned,
  // so a synchronous spawn() throw never wedges the agent "busy" forever.
  let child;
  try {
    // stdin = /dev/null (EOF) so `agy` never blocks waiting for interactive follow-up input (same trap the
    // codex path hit). stdout carries the printed answer; we only need the exit code for completion.
    child = spawn("agy", args, { cwd: agent.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    markDelivering(item.id); // charge an attempt so the failure budget bounds a persistent spawn fault
    const why = `gemini spawn threw: ${String((err as Error).message ?? err)}`;
    if (item.attempts >= MAX_DELIVERY_ATTEMPTS) markFailed(item.id, why);
    else requeue(item.id);
    logger.error({ id: item.id, agent: agent.id, why }, "gemini spawn threw -> requeued (inFlight NOT held)");
    return;
  }

  inFlight.add(agent.id);
  markDelivering(item.id);

  let settled = false; // 'error' is usually FOLLOWED by 'close' — book the terminal outcome exactly once
  let timedOut = false;

  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, TURN_TIMEOUT_MS);

  const finish = (code: number | null, errMsg?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    inFlight.delete(agent.id);

    if (timedOut) {
      requeueNoPenalty(item.id);
      logger.warn({ id: item.id, agent: agent.id, timeoutMin: TURN_TIMEOUT_MS / 60_000 }, "gemini turn watchdog timeout -> killed + requeued (no attempt charged)");
      return;
    }
    const outcome = decideGeminiOutcome({ code, sawUsageLimit, attempts: item.attempts });
    if (outcome === "delivered") {
      markDelivered(item.id);
      recordInbound(item.agent_id, item.reply_channel, item.prompt);
      logger.info({ id: item.id, agent: agent.id }, "gemini prompt delivered (clean exit)");
    } else if (outcome === "backoff") {
      cooldownUntil.set(agent.id, Date.now() + USAGE_BACKOFF_MS);
      requeueNoPenalty(item.id);
      logger.warn({ id: item.id, agent: agent.id, code, backoffMin: USAGE_BACKOFF_MS / 60_000 }, "gemini usage cap -> holding (no attempt charged)");
    } else if (outcome === "failed") {
      markFailed(item.id, errMsg ?? `exit ${code}`);
      logger.warn({ id: item.id, agent: agent.id, code }, "gemini delivery failed (max attempts)");
    } else {
      requeue(item.id);
      logger.warn({ id: item.id, agent: agent.id, code }, "gemini exec not clean -> requeued");
    }
  };

  child.stdout.on("data", (d: Buffer) => scan(d.toString()));
  child.stderr.on("data", (d: Buffer) => scan(d.toString()));
  child.on("close", (code) => finish(code));
  child.on("error", (err) => finish(null, `spawn error: ${String((err as Error).message ?? err)}`));
}

export const geminiRuntime: Runtime = {
  id: "gemini",
  label: "Google Antigravity (Gemini)",
  // Selectable `--model` values, exactly as `agy models` advertises them (verified live 2026-07-26).
  // These are SLUGS. An earlier revision carried human labels ("Gemini 3.1 Pro (High)"), which `agy`
  // does not recognise — it silently falls back to the account default, so the setting looked applied
  // but was not. The runtime.test.ts slug guard exists to stop that regressing.
  // Empty agent.model -> the provider/account default.
  models: [
    "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low",
    "gemini-3.5-flash-high",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ],
  efforts: [],
  launch: launchGeminiHolder,
  isBusy: isGeminiBusy,
  deliver: deliverGeminiPrompt,
};
