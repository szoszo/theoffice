import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Locks the present/absent/UNKNOWN distinction (prerequisite for kanban aba29f60).
 *
 * `hasSession` answers a boolean, so "tmux says the session is gone" and "we could not ask tmux"
 * both arrive as `false`. That is the safe reading when gating delivery — don't deliver if unsure —
 * and the dangerous one for orphan-requeue, where `false` would mean "the agent died, re-send its
 * messages". A tmux call SIGKILLed by TMUX_TIMEOUT_MS returns code -1; if that read as "dead" we
 * would re-deliver messages to an agent that is alive and mid-turn. That is the automated,
 * fleet-wide version of the duplicate-delivery bug hit by hand on 2026-08-01.
 *
 * Exit codes are tmux ground truth, verified on this box: 0 = session exists, 1 = it does not.
 */

const h = vi.hoisted(() => ({
  result: { status: 0, stdout: "", stderr: "" } as {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: NodeJS.ErrnoException;
  },
  spawnCount: 0,
}));

vi.mock("node:child_process", () => ({ spawnSync: () => { h.spawnCount++; return h.result; } }));

import { sessionState, hasSession, sessionInstance, clearInput } from "./tmux.js";

beforeEach(() => {
  h.result = { status: 0, stdout: "", stderr: "" };
});

describe("sessionState — present / absent / unknown are three different answers", () => {
  it("exit 0 -> present", () => {
    h.result = { status: 0, stdout: "", stderr: "" };
    expect(sessionState("s", "agent-x")).toBe("present");
    expect(hasSession("s", "agent-x")).toBe(true);
  });

  it("exit 1 -> absent (tmux confirmed there is no such session)", () => {
    h.result = { status: 1, stdout: "", stderr: "can't find session: agent-x" };
    expect(sessionState("s", "agent-x")).toBe("absent");
    expect(hasSession("s", "agent-x")).toBe(false);
  });

  it("a TIMED-OUT call is UNKNOWN, not absent — the whole point", () => {
    const err: NodeJS.ErrnoException = new Error("ETIMEDOUT");
    err.code = "ETIMEDOUT";
    h.result = { status: null, stdout: "", stderr: "", error: err }; // spawnSync timeout shape
    expect(sessionState("s", "agent-x")).toBe("unknown");
    expect(hasSession("s", "agent-x")).toBe(false); // still false: safe for delivery gating
  });

  it("a spawn failure (no status) is UNKNOWN, not absent", () => {
    h.result = { status: null, stdout: "", stderr: "" };
    expect(sessionState("s", "agent-x")).toBe("unknown");
  });

  it("hasSession stays a CONFIRMED-present check — unchanged behaviour for existing callers", () => {
    for (const status of [1, null, 2, -1]) {
      h.result = { status: status as number | null, stdout: "", stderr: "" };
      expect(hasSession("s", "agent-x")).toBe(false);
    }
  });

  it("the load-bearing invariant: 'could not ask' is NEVER spelled the same as 'confirmed dead'", () => {
    h.result = { status: 1, stdout: "", stderr: "" };
    const dead = sessionState("s", "agent-x");
    const err: NodeJS.ErrnoException = new Error("ETIMEDOUT");
    err.code = "ETIMEDOUT";
    h.result = { status: null, stdout: "", stderr: "", error: err };
    const cannotTell = sessionState("s", "agent-x");
    expect(dead).not.toBe(cannotTell);
    // and only one of them may ever authorise a requeue
    expect(dead).toBe("absent");
  });
});

describe("sessionInstance — identity, not mere existence", () => {
  const LS = (rows: string[]) => ({ status: 0, stdout: rows.join("\n") + "\n", stderr: "" });

  it("returns the instance ref for a present session", () => {
    h.result = LS(["agent-darryl\t$57:1785230052", "agent-marveen\t$58:1785577079"]);
    expect(sessionInstance("s", "agent-marveen")).toEqual({ state: "present", ref: "$58:1785577079" });
  });

  it("a name that is simply not listed is ABSENT (list-sessions cannot invent a row)", () => {
    h.result = LS(["agent-darryl\t$57:1785230052"]);
    expect(sessionInstance("s", "agent-gone")).toEqual({ state: "absent", ref: null });
  });

  it("no server (exit 1) means every session is genuinely gone -> absent", () => {
    h.result = { status: 1, stdout: "", stderr: "no server running" };
    expect(sessionInstance("s", "agent-x")).toEqual({ state: "absent", ref: null });
  });

  it("a timed-out call is UNKNOWN — never absent, so it can never authorise a requeue", () => {
    const err: NodeJS.ErrnoException = new Error("ETIMEDOUT");
    err.code = "ETIMEDOUT";
    h.result = { status: null, stdout: "", stderr: "", error: err };
    expect(sessionInstance("s", "agent-x")).toEqual({ state: "unknown", ref: null });
  });

  it("a relaunched agent yields a DIFFERENT ref — the 9766 case that existence checks miss", () => {
    h.result = LS(["agent-marveen\t$58:1785577079"]);
    const after = sessionInstance("s", "agent-marveen");
    expect(after.state).toBe("present");
    expect(after.ref).not.toBe("$41:1785500000"); // the pre-OOM instance
  });

  it("present but with an unusable ref is UNKNOWN, not a guessed identity", () => {
    h.result = LS(["agent-x\t:"]); // the shape display-message would have produced for a dead session
    expect(sessionInstance("s", "agent-x")).toEqual({ state: "unknown", ref: null });
  });
});

describe("clearInput — one C-u cannot clear a multi-line draft (kanban b4802f1d)", () => {
  it("issues MORE THAN ONE send-keys when told the draft spans several lines", () => {
    h.result = { status: 0, stdout: "", stderr: "" };
    const before = h.spawnCount;
    clearInput("s", "agent-x", 12);
    expect(h.spawnCount - before).toBeGreaterThan(12);
  });

  it("still clears at least once when given no line count", () => {
    const before = h.spawnCount;
    clearInput("s", "agent-x");
    expect(h.spawnCount - before).toBeGreaterThanOrEqual(2);
  });
});
