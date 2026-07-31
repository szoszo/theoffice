import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Locks the 2026-07-31 incident: a delivery burst that STARTS with "-" was handed to
 * `tmux send-keys -l <text>` with no option terminator, so tmux read the text as a flag and rejected
 * the whole burst ("command send-keys: invalid flag"). Because the chunker slices at a fixed width,
 * whether a chunk starts with "-" is a pure function of the prompt content: the same bytes failed at
 * the same offset on every retry, delivery aborted forever, and the half-typed prompt piled up in the
 * agent's input box. The agent received nothing for two hours while the queue reported delivery
 * attempts.
 *
 * The invariant: sendText must pass "--" before the payload so tmux stops parsing options. Asserting
 * on argv (not on a boolean) is deliberate — a refactor that drops the terminator has to turn this red.
 */

const spawnSyncMock = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
vi.mock("node:child_process", () => ({ spawnSync: (...a: unknown[]) => spawnSyncMock(...a) }));

const { sendText } = await import("./tmux.js");

function argvOfLastCall(): string[] {
  const call = spawnSyncMock.mock.calls.at(-1) as unknown as [string, string[], unknown];
  return call[1];
}

describe("sendText option-terminator", () => {
  beforeEach(() => spawnSyncMock.mockClear());

  it("terminates option parsing before the payload", () => {
    sendText("theoffice", "agent-x", "plain text");
    const argv = argvOfLastCall();
    const dashDash = argv.indexOf("--");
    expect(dashDash).toBeGreaterThan(-1);
    // the payload is the last arg, and it comes AFTER the terminator
    expect(argv.at(-1)).toBe("plain text");
    expect(dashDash).toBe(argv.length - 2);
  });

  it("passes a hyphen-leading burst through as payload, not as a flag", () => {
    // exactly the shape that wedged the fleet: a memory-preamble bullet at a chunk boundary
    const burst = "- (hot) HOLLAND KONYVELO MEGVAN (2026-07-31): Horvath Agnes";
    sendText("theoffice", "agent-x", burst);
    const argv = argvOfLastCall();
    expect(argv.at(-1)).toBe(burst);
    expect(argv[argv.indexOf("--") + 1]).toBe(burst);
  });

  it("still reports tmux rejection to the caller", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "invalid flag" });
    expect(sendText("theoffice", "agent-x", "-whatever")).toBe(false);
  });
});
