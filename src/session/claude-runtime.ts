import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv } from "./agent-env.js";
import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { capturePane, clearInput, hasSession, newSession, sendKey, sendText, sessionNameFor } from "./tmux.js";
import { withPaneLock } from "./pane-lock.js";
import { detectPaneState, decideSubmitFollowup, isReadyForPrompt } from "./pane-state.js";
import { writeAgentSettings } from "./profile.js";
import { ensureFolderTrusted } from "./trust.js";
import { markDelivering, markDelivered, markFailed, requeue } from "../queue/index.js";
import { recordInbound } from "../memory/conversation.js";
import { firstMessagePreamble } from "./goals.js";
import type { Runtime, QueuedItem } from "./runtime.js";
import { frameForDelivery } from "./delivery.js";
import { EFFORT_LEVELS } from "./effort.js";

/**
 * Claude runtime — the default provider. Each agent runs a persistent `claude` TUI in tmux that we
 * inject prompts into and read back via pane state. This module owns that whole path (launch + the
 * hard-won send/confirm/retry delivery); the deliverer loop just hands it one item at a time.
 */
const logger = log("session");

// Tunables (ported from v1's hard-won values).
const CHUNK = 180; // chars per send-keys -l burst
const SETTLE_CHUNK_MS = 30; // between chunks
const SETTLE_BEFORE_ENTER_MS = 150; // let bracketed-paste finish before Enter
const SUBMIT_RETRY_MAX = 4; // retry-Enter attempts after the first send
const SUBMIT_RETRY_POLL_MS = 1000; // wait between confirm samples
const READY_SAMPLE_GAP_MS = 250; // double-sample idle gap
const MAX_DELIVERY_ATTEMPTS = 5; // give up + mark failed after this many

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Agents whose tmux session was just (re)created and still needs its memory preamble on the next
// delivery (see launchClaude + deliverClaude). Keyed to SESSION freshness, NOT engine lifetime: our
// sessions are decoupled from the engine (theoffice-tmux, separate cgroup), so an engine restart leaves
// live sessions untouched and must NOT re-prime them, while a dashboard-restarted agent (genuinely fresh
// session) MUST be primed. launchClaude adds an id only when it actually creates a new session.
const needsPrime = new Set<string>();

/**
 * Record where an agent should reply for a channel-sourced message. The `office-say`
 * helper reads this file so the agent can just run `office-say "..."` without knowing
 * the Slack channel id. Written right before delivery.
 */
function writeReplyContext(cfg: EngineConfig, agentId: string, channel: string): void {
  try {
    writeFileSync(join(cfg.paths.agentsDir, agentId, ".reply-context"), channel);
  } catch {
    /* best-effort */
  }
}

/**
 * Double-sampled readiness: capture twice with a small gap; ready only if BOTH
 * frames classify idle. Catches the one-frame footer gap right after a submit.
 */
async function isReady(socket: string, session: string): Promise<boolean> {
  const a = capturePane(socket, session);
  if (a == null || detectPaneState(a) !== "idle") return false;
  await sleep(READY_SAMPLE_GAP_MS);
  const b = capturePane(socket, session);
  return b != null && detectPaneState(b) === "idle";
}

export interface DeliveryResult {
  ok: boolean;
  reason?: "not-ready" | "wedged" | "submit-give-up" | "no-session" | "send-failed" | "dirty-pane";
}

/** Lines to assume a pre-existing draft might span when we have no way to know. */
const PRE_CLEAR_LINES = 40;
/** How many clear-then-verify rounds before we declare the pane dirty. */
const CLEAR_VERIFY_ROUNDS = 3;
/** Settle time after sending C-u before capturing, so we read the re-rendered pane not a transient one. */
const CLEAR_SETTLE_MS = 250;

/**
 * Clear a parked draft and CONFIRM it is gone, because a blind clear is what let residue survive and
 * be submitted later by an unrelated delivery (kanban b4802f1d). Returns false if the box still holds
 * text after every round — the caller must then refuse to type rather than stack more on top.
 */
async function clearDraftVerified(socket: string, session: string, lines: number): Promise<boolean> {
  for (let round = 0; round < CLEAR_VERIFY_ROUNDS; round++) {
    clearInput(socket, session, lines);
    // Let the TUI actually process the keys and re-render. Without this we capture mid-render and
    // read a transient state rather than the settled one.
    await sleep(CLEAR_SETTLE_MS);
    const pane = capturePane(socket, session);
    if (pane == null) return false; // cannot see the pane => cannot claim it is clean
    // ONLY an explicitly idle pane counts as clean. The first version asked `!== "typing"`, which
    // silently accepted "busy", "unknown" and "error" as proof of cleanliness — and after typing
    // thousands of chars the pane is ALWAYS mid-render, i.e. "busy". That is why 12 of 12 clears
    // "verified clean" on 2026-08-01 while residue survived and was submitted behind an owner
    // message. Treating cannot-tell as fine is the same mistake this whole fix exists to prevent;
    // I made it inside the fix for it.
    if (isReadyForPrompt(pane)) return true;
  }
  return false;
}

/**
 * Idempotent delivery of one prompt into an agent's pure `claude` session.
 * Safe to re-call: it clears any stray draft first and confirms the submit
 * landed before returning ok. This single function replaces v1's scattered
 * send / stuck-input / idle-submit machinery.
 */
export async function deliverPrompt(socket: string, session: string, prompt: string): Promise<DeliveryResult> {
  if (!hasSession(socket, session)) return { ok: false, reason: "no-session" };

  const pre = capturePane(socket, session);
  if (pre == null) return { ok: false, reason: "not-ready" };
  const state = detectPaneState(pre);
  if (state === "error") return { ok: false, reason: "wedged" };
  // Remove a stray draft before sending. VERIFIED, not fire-and-forget: an uncleared multi-line draft
  // gets our text appended to it and submitted as one merged prompt (kanban b4802f1d). We do not know
  // how many lines a pre-existing draft has, so clear generously and confirm.
  if (state === "typing" && !(await clearDraftVerified(socket, session, PRE_CLEAR_LINES))) {
    logger.error({ session }, "a parked draft could not be cleared — refusing to type behind it");
    return { ok: false, reason: "dirty-pane" };
  }
  if (state === "busy" || state === "unknown") return { ok: false, reason: "not-ready" };

  // Type the prompt in literal chunks. A chunk that tmux rejects (wedged pane, or the TMUX_TIMEOUT_MS
  // kill) MUST abort the whole delivery: carrying on would leave a CHUNK-sized hole in the middle of the
  // message, and the Enter below would then submit the mutilated text and mark it delivered. That is
  // exactly how an inter-agent authorisation was silently deleted on 2026-08-01 (kanban d6ada913).
  // Clear the partial draft and fail — deliverClaude requeues every reason except "wedged", so the
  // message is retried WHOLE instead of arriving corrupt.
  for (let i = 0; i < prompt.length; i += CHUNK) {
    if (!sendText(socket, session, prompt.slice(i, i + CHUNK))) {
      // Refusing to submit is NOT enough: whatever we already typed stays parked in the input box and
      // the next delivery to press Enter submits it (kanban b4802f1d — six aborted copies plus an
      // owner message arrived as one prompt). Clear what we typed and VERIFY the box is actually empty.
      const linesTyped = (prompt.slice(0, i).match(/\n/g) ?? []).length;
      const clean = await clearDraftVerified(socket, session, linesTyped);
      const at = { session, atChar: i, promptLen: prompt.length, linesTyped };
      if (!clean) {
        logger.error(at, "send-keys chunk failed AND the partial draft could not be cleared — pane is DIRTY; residue may be submitted by the next delivery");
        return { ok: false, reason: "dirty-pane" };
      }
      logger.warn(at, "send-keys chunk failed mid-prompt — draft cleared and verified, delivery aborted (message NOT submitted)");
      return { ok: false, reason: "send-failed" };
    }
    if (i + CHUNK < prompt.length) await sleep(SETTLE_CHUNK_MS);
  }
  await sleep(SETTLE_BEFORE_ENTER_MS);
  sendKey(socket, session, "Enter");

  // confirm the submit actually landed; retry Enter within a bounded budget
  const hint = prompt.slice(0, Math.min(prompt.length, 40));
  for (let attempt = 0; attempt <= SUBMIT_RETRY_MAX; attempt++) {
    await sleep(SUBMIT_RETRY_POLL_MS);
    const pane = capturePane(socket, session);
    const action = decideSubmitFollowup(pane, hint, attempt, SUBMIT_RETRY_MAX);
    if (action === "done") return { ok: true };
    if (action === "give-up") return { ok: false, reason: "submit-give-up" };
    sendKey(socket, session, "Enter");
  }
  return { ok: false, reason: "submit-give-up" };
}

/**
 * Launch a PURE `claude` session for an agent (NO channel plugin inside — the
 * Slack channel is external). Env is command-scoped so it never leaks to siblings.
 */
function launchClaude(cfg: EngineConfig, agent: AgentDef): boolean {
  const session = sessionNameFor(agent.id);
  const command = ["claude", "--dangerously-skip-permissions"];
  if (agent.model) command.push("--model", agent.model);
  // Effort is pinned the same way as the model. Both flags override whatever is in the SHARED
  // ~/.claude/settings.json (all agents run on one HOME, because the credentials live there), which
  // is exactly why a pinned value survives restarts and can't be knocked over by another agent's
  // switch — /effort and /model also write themselves into that file as a default.
  if (agent.effort) command.push("--effort", agent.effort);
  // Shared env builder: applies the agent's .env FIRST, then the engine's reserved keys overwrite it, so a
  // stray .env line (PATH=/HOME=/OFFICE_PORT=) can't break office-say or redirect the agent. See agent-env.ts.
  const env = buildAgentEnv(cfg, agent);
  // regenerate the agent's security profile (connector + filesystem deny) before launch
  writeAgentSettings(cfg, agent);
  // pre-accept Claude's folder-trust gate; otherwise a fresh pane blocks on the
  // interactive "trust this folder?" prompt forever and never reaches idle, so
  // the deliverer can never hand it a message (and --dangerously-skip-permissions
  // does NOT bypass that prompt). Idempotent.
  ensureFolderTrusted(agent.dir);
  const ok = newSession(cfg.tmux.socket, session, { cwd: agent.dir, command, env });
  // Only a genuinely NEW session needs priming. ok=false means the session already existed (e.g. an
  // engine restart while the decoupled tmux server kept it alive) — it already holds its context, so we
  // must NOT re-prime it. A dashboard restart (killSession then here) yields ok=true -> primes the fresh one.
  if (ok) needsPrime.add(agent.id);
  logger.info({ agent: agent.id, session, ok }, ok ? "launched agent" : "launch skipped (exists?)");
  return ok;
}

/**
 * Deliver one item into a claude agent's pane: gate on live readiness (leave queued if not ready, no
 * attempt burned), then inject + confirm, marking the queue item on the outcome.
 */
async function deliverClaude(cfg: EngineConfig, agent: AgentDef, item: QueuedItem): Promise<void> {
  const socket = cfg.tmux.socket;
  const session = sessionNameFor(item.agent_id);
  if (!(await isReady(socket, session))) return; // busy/typing/wedged -> retry next tick, no attempt burned

  if (item.source === "channel" && item.reply_channel) {
    writeReplyContext(cfg, item.agent_id, item.reply_channel);
  }
  markDelivering(item.id);
  // The first message to a FRESHLY-CREATED session gets a recalled-memory preamble (bounded; hot+warm
  // first, then topical cold/shared) so a blank session doesn't start contextless; later messages skip it
  // because the live session still holds the context. `needsPrime` is set by launchClaude only when it
  // actually creates a new session, so this fires on reboot/dashboard-restart but NOT on an engine restart
  // that left the session alive.
  let text = frameForDelivery(item);
  const prime = needsPrime.has(item.agent_id);
  if (prime) {
    try {
      // Operator goals (framing) + recalled memory, assembled WITHIN one pane-inject budget so the
      // combined preamble never overloads the send-keys path. Best-effort; missing bits are no-ops. See goals.ts.
      const pre = firstMessagePreamble(cfg, item.agent_id, item.prompt);
      if (pre) text = `${pre}\n\n${text}`;
    } catch (err) {
      logger.warn({ agent: item.agent_id, err }, "first-message preamble failed (delivering without)");
    }
  }
  const res = await withPaneLock(session, () => deliverPrompt(socket, session, text));
  if (res.ok) {
    needsPrime.delete(item.agent_id);
    markDelivered(item.id);
    recordInbound(item.agent_id, item.reply_channel, item.prompt);
    logger.info({ id: item.id, agent: item.agent_id, source: item.source, primed: prime }, "delivered");
  } else if (res.reason === "wedged") {
    markFailed(item.id, "session wedged (thinking-block error)");
    logger.warn({ id: item.id, agent: item.agent_id }, "agent wedged — needs reset");
  } else if (item.attempts >= MAX_DELIVERY_ATTEMPTS) {
    markFailed(item.id, res.reason ?? "unknown");
    logger.warn({ id: item.id, agent: item.agent_id, reason: res.reason }, "delivery failed (max attempts)");
  } else {
    requeue(item.id);
  }
}

export const claudeRuntime: Runtime = {
  id: "claude",
  label: "Claude (Claude Code)",
  // Selectable --model ids, verified live against this account's /model menu (2026-07-26).
  // Opus 4.8 is no longer listed in that menu but stays here: `home` and `zeus` run on it and the
  // menu itself notes that previous model names remain usable via --model, which is how we launch.
  models: [
    "claude-opus-5",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
  ],
  efforts: EFFORT_LEVELS,
  launch: launchClaude,
  // Readiness for a persistent TUI is decided live inside deliver() via pane state, not a tracked flag.
  isBusy: () => false,
  deliver: deliverClaude,
};
