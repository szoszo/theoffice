import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Locks the 2026-08-02 ghost-placeholder outage (kanban cf693128).
 *
 * Claude Code v2.1.220 renders an EMPTY composer as `❯ ` plus a DIM (SGR 2) hint, and since v2.1.x
 * that hint is the agent's own last prompt — `❯ run the morning briefing now` on marveen,
 * `❯ approve the pending travel bookings` on pam. `tmux capture-pane -p` throws styling away, so the
 * pre-send guard saw a clean pane as a parked draft, tried to C-u away text that is chrome (which can
 * never work), and refused the delivery as dirty-pane. 144 refusals across marveen/darryl/dwight/pam
 * in one morning; an owner Slack message (inbound 9913) failed six attempts and never arrived.
 *
 * The invariant: DELIVERY MUST SURVIVE THE GHOST HINT, WITHOUT LOOSENING THE RESIDUE GUARD. This file
 * drives the REAL pane-state module against pane bytes captured off the live panes, and mocks only
 * tmux — so it fails if the runtime ever goes back to a plain capture, and equally if the styled
 * reading starts calling genuine residue empty.
 */

const ESC_SEP = "\x1b[38;5;244m" + "─".repeat(80);
const ESC_FOOTER =
  "\x1b[39m  \x1b[38;5;211m⏵⏵ bypass permissions on\x1b[38;5;246m (shift+tab to cycle) · ← for agents\x1b[39m";

/** Verbatim from `tmux capture-pane -e -t agent-pam` on 2026-08-02: an EMPTY composer. */
const GHOST_LINE = "\x1b[39m❯\xa0\x1b[2mapprove the pending travel bookings\x1b[0m";
/** The same words the agent really typed and never submitted: normal intensity, i.e. residue. */
const RESIDUE_LINE = "\x1b[39m❯\xa0approve the pending travel bookings";

const styledPane = (inner: string) =>
  ["\x1b[39m  ⎿  earlier turn output", ESC_SEP, inner, ESC_SEP, ESC_FOOTER].join("\n");

const h = vi.hoisted(() => ({
  sent: [] as string[],
  keys: [] as string[],
  clears: 0,
  /** Styled pane bytes tmux hands back. */
  pane: "",
  /** Every capturePane opts object, so the test can prove the runtime asked for escapes. */
  captureOpts: [] as unknown[],
}));

vi.mock("./tmux.js", () => ({
  sessionNameFor: (id: string) => `agent-${id}`,
  hasSession: () => true,
  newSession: () => true,
  capturePane: (_socket: string, _name: string, opts: Record<string, unknown> = {}) => {
    h.captureOpts.push(opts);
    // A plain capture is exactly the styled bytes with the escapes stripped — model that faithfully,
    // so a runtime that forgets `-e` sees precisely what wedged the fleet.
    return opts.escapes ? h.pane : h.pane.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
  },
  sendText: (_socket: string, _name: string, text: string) => {
    h.sent.push(text);
    return true;
  },
  sendKey: (_socket: string, _name: string, key: string) => {
    h.keys.push(key);
    return true;
  },
  clearInput: () => {
    h.clears++;
  },
}));

import { deliverPrompt } from "./claude-runtime.js";

const PROMPT = "here is the actual message the owner sent";

describe("ghost placeholder must not read as residue (2026-08-02 outage)", () => {
  beforeEach(() => {
    h.sent = [];
    h.keys = [];
    h.clears = 0;
    h.captureOpts = [];
    h.pane = styledPane(GHOST_LINE);
  });

  it("delivers into a pane whose composer holds only the dim ghost hint", async () => {
    const res = await deliverPrompt("test", "agent-pam", PROMPT);
    expect(res.ok).toBe(true);
    expect(h.sent.join("")).toBe(PROMPT);
    expect(h.keys).toContain("Enter");
  });

  it("sends no C-u at all — there is nothing to clear, and chrome cannot be cleared anyway", async () => {
    await deliverPrompt("test", "agent-pam", PROMPT);
    expect(h.clears).toBe(0);
  });

  it("asks tmux for the ESCAPES — a plain capture is what caused the outage", async () => {
    await deliverPrompt("test", "agent-pam", PROMPT);
    expect(h.captureOpts.length).toBeGreaterThan(0);
    for (const opts of h.captureOpts) expect((opts as { escapes?: boolean }).escapes).toBe(true);
  });

  it("STILL refuses when the very same words are real, normal-intensity residue", async () => {
    h.pane = styledPane(RESIDUE_LINE);
    const res = await deliverPrompt("test", "agent-pam", PROMPT);
    expect(res.reason).toBe("dirty-pane"); // clearInput is mocked, so the box never comes clean
    expect(h.clears).toBeGreaterThan(0); // and it genuinely tried
    expect(h.sent.join("")).toBe(""); // nothing typed on top of the residue
    expect(h.keys).not.toContain("Enter");
  });

  it("the ghost hint left by a LANDED submit is not mistaken for a stuck prompt", async () => {
    // Post-submit reality: the composer is empty and its dim hint is the prompt we just sent. Read
    // plain, that looks like the payload still parked in the box, so the confirm loop burned its
    // retries and returned submit-give-up — and the deliverer requeues on that, delivering twice.
    h.pane = styledPane(`\x1b[39m❯\xa0\x1b[2m${PROMPT}\x1b[0m`);
    const res = await deliverPrompt("test", "agent-pam", PROMPT);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(h.keys.filter((k) => k === "Enter")).toHaveLength(1); // one submit, no retry storm
  });
});
