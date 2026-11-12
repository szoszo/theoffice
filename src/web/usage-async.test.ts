import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/** computeUsageAsync must never take the engine down: a failing worker is a rejected promise or an inline fallback, a hung worker is cut off. */
class FakeWorker extends EventEmitter {
  static last: FakeWorker | null = null;
  terminated = false;
  constructor() { super(); FakeWorker.last = this; }
  terminate() { this.terminated = true; return Promise.resolve(0); }
}
vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));

// computeUsage throws when the inline fallback is asked to run, to prove the fallback itself is contained
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return { ...real, existsSync: (p: string) => (String(p).includes("__boom__") ? (() => { throw new Error("inline boom"); })() : real.existsSync(p)) };
});

const { computeUsageAsync } = await import("./usage.js");
const agent = (dir: string) => ({ id: "a", dir, runtime: "claude" }) as never;

beforeEach(() => { vi.useFakeTimers(); FakeWorker.last = null; });
afterEach(() => vi.useRealTimers());

describe("computeUsageAsync", () => {
  it("resolves the worker's answer, terminates it, and ignores a late exit/error (no double settle)", async () => {
    const p = computeUsageAsync([agent("/x")], 0);
    FakeWorker.last!.emit("message", [{ id: "a", output: 5 }]);
    await expect(p).resolves.toEqual([{ id: "a", output: 5 }]);
    expect(FakeWorker.last!.terminated).toBe(true);
    FakeWorker.last!.emit("exit", 0);
    FakeWorker.last!.emit("error", new Error("late"));
  });

  it("a worker that fails while computing REJECTS (handled) and does not recompute on the main thread", async () => {
    const p = computeUsageAsync([agent("/__boom__")], 0);
    FakeWorker.last!.emit("error", new Error("compute failed in worker"));
    await expect(p).rejects.toThrow("compute failed in worker"); // if it had recomputed inline, 'inline boom' would surface here
  });

  it("a worker that cannot START (module not found) falls back to computing inline", async () => {
    const p = computeUsageAsync([agent("/definitely/not/here")], 0);
    FakeWorker.last!.emit("error", Object.assign(new Error("cannot find module"), { code: "ERR_MODULE_NOT_FOUND" }));
    const r = await p;
    expect(r).toEqual([{ id: "a", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, turns: 0, tracked: true }]);
  });

  it("when even the inline fallback throws, the promise rejects instead of throwing inside an event callback", async () => {
    const p = computeUsageAsync([agent("/__boom__")], 0);
    FakeWorker.last!.emit("error", Object.assign(new Error("cannot find module"), { code: "ERR_MODULE_NOT_FOUND" }));
    await expect(p).rejects.toThrow("inline boom");
  });

  it("a worker that exits without answering rejects", async () => {
    const p = computeUsageAsync([agent("/x")], 0);
    FakeWorker.last!.emit("exit", 1);
    await expect(p).rejects.toThrow(/exited/);
  });

  it("a worker that never answers is terminated after the timeout and the promise rejects (nothing hangs forever)", async () => {
    const p = computeUsageAsync([agent("/x")], 0);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(121_000);
    await assertion;
    expect(FakeWorker.last!.terminated).toBe(true);
  });
});
