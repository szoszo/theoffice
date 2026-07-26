import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Live switching must be believed only when the pane says so. Observed on claude 2.1.220: a command
 * sent while the pane is still processing the previous one is swallowed with no output and no error,
 * so fire-and-forget would report a success that never happened.
 *
 * The pane mock flips to `ackPane` when Enter is pressed — that is the real sequence (the CLI prints
 * its acknowledgement only after submit), and it lets the swallowed-command case be modelled simply
 * by leaving ackPane identical to the idle pane.
 */
const h = vi.hoisted(() => ({
  pane: "idle-pane",
  ackPane: "idle-pane",
  // Optional sequence of panes returned on successive Enter presses (models submit -> menu -> ack).
  // When empty, Enter flips to ackPane as before, so existing single-step tests are unaffected.
  enterPanes: [] as string[],
  sent: [] as string[],
  keys: [] as string[],
  hasSession: true,
  state: "idle" as string,
}));

vi.mock("./tmux.js", () => ({
  hasSession: () => h.hasSession,
  capturePane: () => h.pane,
  sendText: (_s: string, _n: string, t: string) => {
    h.sent.push(t);
  },
  sendKey: (_s: string, _n: string, k: string) => {
    h.keys.push(k);
    if (k === "Enter") h.pane = h.enterPanes.length ? h.enterPanes.shift()! : h.ackPane;
  },
  clearInput: () => {},
}));
vi.mock("./pane-state.js", () => ({ detectPaneState: () => h.state }));

import { applyTune } from "./tune.js";

// Short timings so the not-ready / no-ack paths don't spend real seconds in the suite.
const fast = { readyWaitMs: 60, readyPollMs: 10, ackWaitMs: 80, ackPollMs: 10, settleMs: 1 };

beforeEach(() => {
  h.pane = "idle-pane";
  h.ackPane = "idle-pane";
  h.enterPanes = [];
  h.sent = [];
  h.keys = [];
  h.hasSession = true;
  h.state = "idle";
});

describe("applyTune", () => {
  it("injects the slash command and reports success on the CLI's acknowledgement", async () => {
    h.ackPane = "❯ /effort xhigh\n  ⎿  Set effort level to xhigh (saved as your default for new sessions)";
    const r = await applyTune("s", "agent-x", "effort", "xhigh", fast);
    expect(r.ok).toBe(true);
    expect(h.sent).toContain("/effort xhigh");
    expect(h.keys).toContain("Enter");
    expect(r.message).toContain("Set effort level to xhigh");
  });

  it("reports success for a model switch too", async () => {
    h.ackPane = "❯ /model claude-sonnet-5\n  ⎿  Set model to Sonnet 5 and saved as your default for new sessions";
    const r = await applyTune("s", "agent-x", "model", "claude-sonnet-5", fast);
    expect(r.ok).toBe(true);
    expect(h.sent).toContain("/model claude-sonnet-5");
  });

  it("surfaces an invalid effort verbatim instead of claiming success", async () => {
    h.ackPane =
      "❯ /effort banana\n  ⎿  Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto";
    const r = await applyTune("s", "agent-x", "effort", "banana", fast);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rejected");
    expect(r.message).toContain("Invalid argument: banana");
  });

  it("surfaces an unknown model verbatim", async () => {
    h.ackPane = "❯ /model nope\n  ⎿  Model 'nope' not found";
    const r = await applyTune("s", "agent-x", "model", "nope", fast);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rejected");
    expect(r.message).toContain("not found");
  });

  it("prefers the rejection over a stale success line further up the pane", async () => {
    // a previous successful switch is still scrolled into view; the NEW command failed
    h.ackPane =
      "  ⎿  Set effort level to high (saved as your default for new sessions)\n" +
      "❯ /effort banana\n  ⎿  Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto";
    const r = await applyTune("s", "agent-x", "effort", "banana", fast);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rejected");
  });

  it("reports no-ack rather than success when the command is swallowed", async () => {
    h.ackPane = "idle-pane"; // pane never changes — the swallowed-command case
    const r = await applyTune("s", "agent-x", "effort", "high", fast);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-ack");
  });

  it("refuses to inject into a busy pane instead of interleaving with the running turn", async () => {
    h.state = "busy";
    const r = await applyTune("s", "agent-x", "effort", "high", fast);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-ready");
    expect(h.sent).toHaveLength(0);
  });

  it("reports no-session when the agent is not running", async () => {
    h.hasSession = false;
    const r = await applyTune("s", "agent-x", "effort", "high", fast);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-session");
    expect(h.sent).toHaveLength(0);
  });

  // A REAL cross-model switch invalidates the cached conversation, so the CLI interrupts with a
  // "Switch model?" confirmation instead of acking. Pre-fix, applyTune couldn't answer it -> no-ack AND
  // the agent stranded on the menu. RED-FIRST: without the menu handling these two fail.
  it("confirms the cross-model 'Switch model?' menu and reports success (no wedge)", async () => {
    const menu =
      "❯ /model claude-haiku-4-5\n  Switch model? This conversation is cached for the current model.\n  ❯ 1. Yes, switch    2. No, go back";
    const ack = "  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions";
    h.enterPanes = [menu, ack]; // submit Enter -> menu; our confirm Enter -> ack
    const r = await applyTune("s", "agent-x", "model", "claude-haiku-4-5", fast);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Set model to Haiku 4.5");
    // two Enters proves the confirm keystroke fired (submit + confirm), not just the submit
    expect(h.keys.filter((k) => k === "Enter")).toHaveLength(2);
  });

  it("never strands the pane: a menu that never resolves is cancelled (Down -> No -> Enter)", async () => {
    const menu = "  Switch model? ...\n  ❯ 1. Yes, switch    2. No, go back";
    h.enterPanes = [menu]; // submit -> menu
    h.ackPane = menu; // every later Enter still shows the menu: the confirm "didn't take"
    const r = await applyTune("s", "agent-x", "model", "claude-haiku-4-5", fast);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-ack");
    // proves we declined the menu to free the pane instead of leaving the agent stuck on it
    expect(h.keys).toContain("Down");
  });
});
