import { hasSession, capturePane, sendText, sendKey } from "./tmux.js";
import { withPaneLock } from "./pane-lock.js";
import { detectPaneState } from "./pane-state.js";
import { log } from "../logger.js";

const logger = log("tune");

export type TuneKind = "model" | "effort";

export interface TuneResult {
  ok: boolean;
  reason?: "no-session" | "not-ready" | "rejected" | "no-ack";
  /** The pane's own wording, for surfacing to the owner unchanged. */
  message?: string;
}

export interface TuneTimings {
  /** How long to wait for the current turn to finish before giving up. */
  readyWaitMs?: number;
  readyPollMs?: number;
  /** How long to wait for the CLI to acknowledge the command. */
  ackWaitMs?: number;
  ackPollMs?: number;
  /** Pause between typing the command and pressing Enter. */
  settleMs?: number;
}

const DEFAULTS: Required<TuneTimings> = {
  readyWaitMs: 120_000,
  readyPollMs: 1_000,
  ackWaitMs: 8_000,
  ackPollMs: 400,
  settleMs: 500,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Acknowledgement wording, verified live against claude 2.1.220. */
const ACK_OK = [/Set effort level to /i, /Set model to /i];
// "Kept model as X" is what the CLI prints when the Switch model? confirmation is declined — treat it
// as a not-applied resolution (so a cancelled switch resolves instead of hanging to no-ack).
const ACK_BAD = [/Invalid argument: /i, /Model '.*' not found/i, /Kept model as /i];

/**
 * A CROSS-model `/model` switch invalidates the cached conversation, so Claude Code interrupts with an
 * interactive confirmation ("Switch model? ... 1. Yes, switch  2. No, go back") instead of acking
 * immediately. Left unanswered it STRANDS the pane — the agent can't take its next turn. We detect the
 * menu, confirm it, and (on timeout) cancel it so a no-ack never leaves an agent stuck on the prompt.
 */
const MODEL_SWITCH_MENU = /Switch model\?|Yes, switch/i;

const clean = (line: string) => line.replace(/^\s*⎿\s*/, "").trim();

/**
 * Find the CLI's reply to the command we just submitted.
 *
 * Scans from the BOTTOM up and returns the first line matching either an accept or a reject pattern,
 * whichever comes first. Direction matters: an earlier switch may still be scrolled into view, so
 * checking all-rejections-then-all-accepts (or vice versa) would let a stale line win over the fresh
 * one. The newest line is the lowest one.
 */
function matchAck(pane: string): { ok: boolean; message: string } | null {
  const lines = pane.split("\n").reverse();
  for (const line of lines) {
    for (const re of ACK_BAD) if (re.test(line)) return { ok: false, message: clean(line) };
    for (const re of ACK_OK) if (re.test(line)) return { ok: true, message: clean(line) };
  }
  return null;
}

/**
 * Switch a live agent's model or effort WITHOUT killing its tmux session, so it keeps its context.
 *
 * Waits for the pane to go idle first (finish the current turn, then switch), injects `/model <v>` or
 * `/effort <v>`, then READS THE ACKNOWLEDGEMENT BACK. The read-back is not optional: a command sent
 * while the pane is still busy is swallowed silently — no output, no error — so without it we would
 * report a success that never happened.
 *
 * The caller is expected to have already persisted the value to agent.json, so a `no-ack` here means
 * "not applied to the running session, but correct at next launch" rather than data loss.
 */
export async function applyTune(
  socket: string,
  session: string,
  kind: TuneKind,
  value: string,
  timings: TuneTimings = {},
): Promise<TuneResult> {
  const t = { ...DEFAULTS, ...timings };
  if (!hasSession(socket, session)) return { ok: false, reason: "no-session" };

  // wait for the current turn to finish rather than interleaving with it
  const readyDeadline = Date.now() + t.readyWaitMs;
  for (;;) {
    const pane = capturePane(socket, session);
    if (pane != null && detectPaneState(pane) === "idle") break;
    if (Date.now() >= readyDeadline) {
      logger.warn({ session, kind, value }, "pane never went idle — not tuning");
      return { ok: false, reason: "not-ready" };
    }
    await sleep(t.readyPollMs);
  }

  // Hold the pane-write lock across the keystroke burst AND the ack read-back, so a queued delivery for
  // the same agent cannot type into the pane mid-tune (which would corrupt the line and steal our ack).
  return withPaneLock(session, async () => {
    const before = capturePane(socket, session) ?? "";
    sendText(socket, session, `/${kind} ${value}`);
    await sleep(t.settleMs);
    sendKey(socket, session, "Enter");

    const ackDeadline = Date.now() + t.ackWaitMs;
    let menuConfirmed = false;
    for (;;) {
      await sleep(t.ackPollMs);
      const pane = capturePane(socket, session) ?? "";
      // A cross-model switch pops the "Switch model?" confirmation instead of acking. Confirm it ONCE
      // ("1. Yes, switch" is the default-highlighted option -> Enter selects it), then keep waiting for
      // the "Set model to" ack. Without this the pane stalls on the menu and the agent is stranded.
      if (!menuConfirmed && MODEL_SWITCH_MENU.test(pane)) {
        sendKey(socket, session, "Enter");
        menuConfirmed = true;
        continue;
      }
      if (pane !== before) {
        const ack = matchAck(pane);
        if (ack) {
          logger.info({ session, kind, value, ok: ack.ok }, "tune acknowledged");
          return ack.ok
            ? { ok: true, message: ack.message }
            : { ok: false, reason: "rejected", message: ack.message };
        }
      }
      if (Date.now() >= ackDeadline) {
        // NEVER strand the pane on the confirmation menu: if it's still up, decline it (Down -> "2. No,
        // go back" -> Enter) so the agent returns to its prior model and can take its next turn.
        if (MODEL_SWITCH_MENU.test(pane)) {
          sendKey(socket, session, "Down");
          await sleep(t.settleMs);
          sendKey(socket, session, "Enter");
          logger.warn({ session, kind, value }, "tune menu not resolved — cancelled to unstrand the pane");
          return { ok: false, reason: "no-ack" };
        }
        logger.warn({ session, kind, value }, "tune not acknowledged — swallowed?");
        return { ok: false, reason: "no-ack" };
      }
    }
  });
}
