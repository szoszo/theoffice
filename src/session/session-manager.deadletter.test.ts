import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression net for the 2026-08-24 fleet freeze: messages addressed to a NON-AGENT id (a misrouted bus
 * message to an infra sender like drift-detector / oomwatch / owner-watchdog) used to sit queued forever
 * because the deliverer `continue`d past them. Since listQueued() is a fleet-wide, id-ordered window with a
 * LIMIT, a pile of these low-id undeliverable rows permanently filled the window and starved every real
 * agent (window ceiling id 15267 vs lowest real item id 15268). The deliverer must dead-letter them.
 */

const deliver = vi.fn();
const markFailed = vi.fn();
const fakeRuntime = { isBusy: () => false, deliver };

// A queued item per source: two for non-agents (must be dead-lettered), one for a real-but-DOWN agent
// (must be left queued), one for a real RUNNING agent (must be delivered).
const items = [
  { id: 10, agent_id: "drift-detector", source: "bus", prompt: "x", reply_channel: null, reply_user: null, attempts: 0 },
  { id: 11, agent_id: "oomwatch", source: "bus", prompt: "x", reply_channel: null, reply_user: null, attempts: 0 },
  { id: 12, agent_id: "downagent", source: "scheduler", prompt: "x", reply_channel: null, reply_user: null, attempts: 0 },
  { id: 13, agent_id: "darryl", source: "bus", prompt: "x", reply_channel: null, reply_user: null, attempts: 0 },
];

vi.mock("./tmux.js", () => ({
  // downagent is a real roster agent that is not currently running; darryl is running.
  hasSession: (_socket: string, session: string) => session === "agent-darryl",
  sessionNameFor: (id: string) => `agent-${id}`,
}));
vi.mock("../queue/index.js", () => ({
  listQueued: () => items,
  markFailed: (...a: unknown[]) => markFailed(...a),
}));
vi.mock("../agents.js", () => ({
  loadAgents: () => [
    { id: "darryl", dir: "/tmp/darryl", enabled: true },
    { id: "downagent", dir: "/tmp/downagent", enabled: true },
  ],
}));
vi.mock("./runtime.js", () => ({ runtimeFor: () => fakeRuntime }));

const { startDeliverer } = await import("./session-manager.js");
const cfg = { tmux: { socket: "test" } } as never;

beforeEach(() => {
  vi.useFakeTimers();
  deliver.mockReset();
  markFailed.mockReset();
  deliver.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("deliverer dead-letters non-agent rows (fleet-freeze guard)", () => {
  it("fails rows addressed to ids not in the roster, keeps real-but-down queued, delivers the running agent", async () => {
    const stop = startDeliverer(cfg);
    try {
      await vi.advanceTimersByTimeAsync(2000);

      // both non-agent rows dead-lettered
      const failedIds = markFailed.mock.calls.map((c) => c[0]).sort();
      expect(failedIds).toEqual([10, 11]);
      // the real-but-down agent (downagent) was NOT failed and NOT delivered — left queued
      expect(markFailed.mock.calls.map((c) => c[0])).not.toContain(12);
      expect(deliver.mock.calls.some((c) => c[2]?.agent_id === "downagent")).toBe(false);
      // the running real agent WAS delivered
      expect(deliver.mock.calls.some((c) => c[2]?.agent_id === "darryl")).toBe(true);
    } finally {
      stop();
    }
  });
});

describe("deliverer never dead-letters against an empty roster", () => {
  it("leaves unmatched rows queued when loadAgents returns nothing (transient read failure)", async () => {
    vi.resetModules();
    vi.doMock("../agents.js", () => ({ loadAgents: () => [] }));
    const { startDeliverer: freshDeliverer } = await import("./session-manager.js");
    const stop = freshDeliverer(cfg);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(markFailed).not.toHaveBeenCalled();
    } finally {
      stop();
      vi.doUnmock("../agents.js");
      vi.resetModules();
    }
  });
});
