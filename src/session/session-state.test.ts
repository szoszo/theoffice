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
}));

vi.mock("node:child_process", () => ({ spawnSync: () => h.result }));

import { sessionState, hasSession } from "./tmux.js";

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
