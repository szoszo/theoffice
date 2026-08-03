import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Locks the 2026-08-01 message-corruption bug (kanban d6ada913).
 *
 * Prompts are typed into the pane in CHUNK-sized send-keys bursts. `sendText` used to be declared
 * `void` and DISCARDED tmux's return code, so a chunk whose send-keys failed (wedged pane, or the
 * 10s spawnSync timeout added in 70f98a7) went unnoticed: the loop carried on to the next chunk,
 * pressed Enter, and SUBMITTED a prompt with a ~180-char hole punched out of the middle — then
 * marked it delivered.
 *
 * Found live: marveen msg 8752 reached darryl's pane with the footer spliced mid-sentence. The DB
 * copy was intact; the missing span measured ~178 chars = exactly one CHUNK. The deleted text was
 * "build it. Ping me only if you need a decision." — an explicit authorisation silently removed
 * from an inter-agent instruction.
 *
 * The invariant that must never regress: A PARTIALLY-TYPED PROMPT IS NEVER SUBMITTED. On a failed
 * chunk we clear the draft and fail the delivery, so the queue requeues it (deliverClaude requeues
 * every reason except "wedged") and the message is retried whole rather than delivered corrupt.
 */

const h = vi.hoisted(() => ({
  sent: [] as string[],
  keys: [] as string[],
  clears: 0,
  /** 0-based index of the chunk whose send-keys should fail; -1 = all succeed. */
  failChunkAt: -1,
  /** How many ATTEMPTS at that chunk fail before it lands. Infinity = it never lands. */
  failTimes: Number.POSITIVE_INFINITY,
  /** Attempts made at the failing chunk, so a retry is distinguishable from a fresh chunk. */
  attemptsAtFail: 0,
  chunkCount: 0,
  paneState: "idle" as string,
  /** What the pane reports AFTER a chunk fails — live, it is mid-render i.e. "busy". */
  paneStateAfterFail: null as string | null,
  /** Whether the input box can be SEEN to be empty after clearing. */
  boxEmpty: true,
  /** What the box reports after a chunk fails — live, large residue is UNVERIFIABLE. */
  boxEmptyAfterFail: null as boolean | null,
  clearLines: [] as number[],
}));

vi.mock("./tmux.js", () => ({
  sessionNameFor: (id: string) => `agent-${id}`,
  hasSession: () => true,
  capturePane: () => "PANE",
  newSession: () => true,
  sendText: (_socket: string, _name: string, text: string) => {
    // A retry re-sends the SAME chunk, so failure is keyed to the chunk POSITION and the attempt
    // count at it — the position only advances once the chunk actually lands.
    if (h.chunkCount === h.failChunkAt && h.attemptsAtFail < h.failTimes) {
      h.attemptsAtFail++;
      if (h.paneStateAfterFail != null) h.paneState = h.paneStateAfterFail;
      if (h.boxEmptyAfterFail != null) h.boxEmpty = h.boxEmptyAfterFail;
      return false; // tmux returned non-zero / timed out
    }
    h.chunkCount++;
    h.sent.push(text);
    return true;
  },
  sendKey: (_socket: string, _name: string, key: string) => {
    h.keys.push(key);
    return true;
  },
  clearInput: (_socket: string, _name: string, lines?: number) => {
    h.clears++;
    h.clearLines.push(lines ?? 1);
  },
}));
vi.mock("./pane-state.js", () => ({
  // Controllable: "idle" means the clear worked; "typing" means a draft is still parked.
  detectPaneState: () => h.paneState,
  isReadyForPrompt: () => h.paneState === "idle",
  // The clear-verify now demands PROVABLE emptiness: a box that cannot be seen is never "empty".
  // h.boxEmpty models that directly rather than via the pane's classification. The runtime reads a
  // STYLED capture so it can tell residue from Claude's dim ghost hint (see
  // ghost-placeholder-delivery.test.ts, which exercises the real reader against live pane bytes);
  // these chunk-integrity cases care only about the empty/not-empty verdict, so the flag drives it.
  inputBoxProvablyEmptyStyled: () => h.boxEmpty,
  stripPaneStyling: (s: string) => s, // pane fixtures here carry no escapes
  decideSubmitFollowup: () => "done",
}));

import { deliverPrompt } from "./claude-runtime.js";

/** Long enough to span several 180-char chunks. */
const PROMPT = "abcdefghij".repeat(75); // 750 chars -> 5 chunks
/** Newline-heavy, like a real bus message: a single C-u cannot clear this. */
const MULTILINE = ("line of text here\n").repeat(60);
const injected = () => h.sent.join("");

beforeEach(() => {
  h.sent.length = 0;
  h.keys.length = 0;
  h.clears = 0;
  h.chunkCount = 0;
  h.failChunkAt = -1;
  h.failTimes = Number.POSITIVE_INFINITY;
  h.attemptsAtFail = 0;
  h.paneState = "idle";
  h.paneStateAfterFail = null;
  h.boxEmpty = true;
  h.boxEmptyAfterFail = null;
  h.clearLines.length = 0;
});

describe("deliverPrompt — a partially-typed prompt is never submitted", () => {
  it("does NOT press Enter when a mid-sequence chunk fails", async () => {
    h.failChunkAt = 2; // fail the third chunk, mid-prompt
    const res = await deliverPrompt("test", "agent-x", PROMPT);

    expect(h.keys).not.toContain("Enter"); // the corruption: Enter used to be pressed anyway
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("send-failed");
  });

  it("clears the partial draft so the next attempt starts clean", async () => {
    h.failChunkAt = 1;
    await deliverPrompt("test", "agent-x", PROMPT);
    expect(h.clears).toBeGreaterThan(0);
  });

  it("stops typing at the failed chunk instead of punching a hole and continuing", async () => {
    h.failChunkAt = 1;
    await deliverPrompt("test", "agent-x", PROMPT);
    // Only the chunks BEFORE the failure were typed — no later chunk sneaks in after the gap.
    expect(injected()).toBe(PROMPT.slice(0, 180));
  });

  it("fails with a reason the caller REQUEUES (not 'wedged', which marks failed permanently)", async () => {
    h.failChunkAt = 0;
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.reason).not.toBe("wedged");
    expect(res.ok).toBe(false);
  });

  it("happy path unchanged: every chunk lands, the FULL prompt is injected, Enter is pressed", async () => {
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(injected()).toBe(PROMPT); // byte-for-byte, no hole
    expect(h.keys).toContain("Enter");
    expect(res.ok).toBe(true);
  });

  it("whenever Enter IS pressed, the whole prompt was typed (the load-bearing invariant)", async () => {
    for (const failAt of [-1, 0, 1, 3]) {
      h.sent.length = 0;
      h.keys.length = 0;
      h.chunkCount = 0;
      h.failChunkAt = failAt;
      await deliverPrompt("test", "agent-x", PROMPT);
      if (h.keys.includes("Enter")) expect(injected()).toBe(PROMPT);
    }
  });
});

describe("aborting must leave the pane CLEAN, not merely unsubmitted (kanban b4802f1d)", () => {
  it("tells clearInput HOW MANY LINES it typed — a 1-line clear cannot clear a multi-line draft", async () => {
    // The live failure: 13-line prompt, single C-u, ~12 lines survived every abort.
    h.failChunkAt = 3; // fail partway through a newline-heavy prompt
    await deliverPrompt("test", "agent-x", MULTILINE);
    expect(h.clearLines.length).toBeGreaterThan(0);
    expect(Math.max(...h.clearLines)).toBeGreaterThan(1); // counted the newlines actually typed
  });

  it("passes a line count matching the newlines it actually typed, not a constant", async () => {
    h.failChunkAt = 3;
    await deliverPrompt("test", "agent-x", MULTILINE);
    const typedLines = (MULTILINE.slice(0, 3 * 180).match(/\n/g) ?? []).length;
    expect(h.clearLines[0]).toBe(typedLines);
  });

  it("reports 'dirty-pane' (not 'send-failed') when the draft CANNOT be cleared", async () => {
    h.failChunkAt = 2;
    h.boxEmptyAfterFail = false; // every verify still sees parked text
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("dirty-pane");
  });

  it("still never presses Enter when the pane is left dirty", async () => {
    h.failChunkAt = 2;
    h.boxEmptyAfterFail = false;
    await deliverPrompt("test", "agent-x", PROMPT);
    expect(h.keys).not.toContain("Enter");
  });

  it("refuses to type BEHIND a pre-existing draft it cannot clear", async () => {
    h.paneState = "typing"; // parked draft before we even start
    h.boxEmpty = false; // ...and the clear can never prove it gone
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.reason).toBe("dirty-pane");
    expect(h.sent.join("")).toBe(""); // nothing typed on top of the residue
    expect(h.keys).not.toContain("Enter");
  });

  it("gives up after a bounded number of verify rounds instead of clearing forever", async () => {
    h.failChunkAt = 1;
    h.boxEmptyAfterFail = false;
    await deliverPrompt("test", "agent-x", PROMPT);
    expect(h.clears).toBeLessThanOrEqual(5); // CLEAR_VERIFY_ROUNDS, not unbounded
  });
});

describe("the clear-verify demands PROVABLE emptiness (regression: 24/24 false 'clean')", () => {
  it("a box that cannot be SEEN to be empty is NOT proof the draft was cleared", async () => {
    // The live regression: large residue makes the input box taller than the captured pane, so its
    // top separator scrolls off, liveInputBox returns null, and detectPaneState calls that "idle".
    // The bigger the mess, the cleaner it looked — 24 of 24 clears "verified" this way.
    h.failChunkAt = 2;
    h.boxEmptyAfterFail = false;
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.reason).toBe("dirty-pane");
  });

  it("a provably EMPTY box lets the abort report a clean send-failed", async () => {
    h.failChunkAt = 2;
    h.boxEmptyAfterFail = true;
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.reason).toBe("send-failed");
  });

  it("never presses Enter when emptiness could not be proven", async () => {
    h.failChunkAt = 2;
    h.boxEmptyAfterFail = false;
    await deliverPrompt("test", "agent-x", PROMPT);
    expect(h.keys).not.toContain("Enter");
  });
});

describe("pre-send guard must ask PROVABLE EMPTINESS, not the classifier (Michael's audit)", () => {
  it("residue classified as IDLE still triggers a clear — the gap that skipped it entirely", async () => {
    // The exact live scenario: a tall parked draft makes liveInputBox return null, so detectPaneState
    // answers "idle" — NOT "typing". The old guard keyed on state === "typing", so in the one case
    // that caused all three incidents it never even attempted a clear and typed behind the residue.
    h.paneState = "idle";
    h.boxEmpty = false; // residue present, and the clear can never prove it gone
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.reason).toBe("dirty-pane");
    expect(h.clears).toBeGreaterThan(0); // it TRIED to clear rather than skipping
    expect(h.sent.join("")).toBe(""); // and typed nothing on top of the residue
    expect(h.keys).not.toContain("Enter");
  });

  it("a provably empty box proceeds normally with no clearing at all", async () => {
    h.paneState = "idle";
    h.boxEmpty = true;
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.ok).toBe(true);
    expect(h.clears).toBe(0); // no pointless C-u into a clean pane
    expect(injected()).toBe(PROMPT);
  });

  it("a BUSY pane returns not-ready WITHOUT sending C-u into a working agent", async () => {
    h.paneState = "busy";
    h.boxEmpty = false; // would otherwise trigger a clear
    const res = await deliverPrompt("test", "agent-x", PROMPT);
    expect(res.reason).toBe("not-ready");
    expect(h.clears).toBe(0); // busy check runs FIRST, deliberately
  });
});

/**
 * Ported from the parallel fork (Iustinianus, 9027d63) during the 2026-08-03 consolidation.
 *
 * Our abort path was already the stricter one — it clears the draft and VERIFIES the box is empty,
 * distinguishing send-failed from dirty-pane. What it lacked was a retry: a chunk rejected because
 * tmux was momentarily busy (or hit the spawnSync timeout) aborted a whole delivery that would have
 * succeeded on the next attempt. Requeueing works, but it costs a round trip and, on a message that
 * keeps hitting a busy pane, can look like an agent going deaf.
 *
 * The distinction that makes retrying safe: a TRANSIENT rejection clears on its own, a DETERMINISTIC
 * one never does. The known deterministic case — a chunk starting with "-" being parsed as a tmux
 * flag — is fixed at the source by the `--` terminator (also theirs, 2979d89), so a bounded retry
 * here cannot mask it.
 */
describe("a transient chunk rejection is retried before the delivery is abandoned", () => {
  it("a chunk that fails once and then lands delivers the WHOLE prompt, not a hole", async () => {
    h.failChunkAt = 2;
    h.failTimes = 1; // transient: the retry succeeds
    const res = await deliverPrompt("test", "agent-x", PROMPT);

    expect(res.ok).toBe(true);
    expect(injected()).toBe(PROMPT); // every byte, in order
    expect(h.keys).toContain("Enter");
  });

  it("retries are BOUNDED — a chunk that never lands still aborts rather than looping forever", async () => {
    h.failChunkAt = 2;
    h.failTimes = Number.POSITIVE_INFINITY;
    const res = await deliverPrompt("test", "agent-x", PROMPT);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("send-failed");
    expect(h.keys).not.toContain("Enter");
    expect(h.attemptsAtFail).toBeLessThanOrEqual(6); // bounded, not unbounded
  });

  it("the retry does not re-type what already landed (no duplicated chunk)", async () => {
    // Retrying the FAILED burst is correct; re-typing the prompt from the start would duplicate
    // everything before the failure inside the input box.
    h.failChunkAt = 1;
    h.failTimes = 2;
    await deliverPrompt("test", "agent-x", PROMPT);
    expect(injected()).toBe(PROMPT);
  });
});
