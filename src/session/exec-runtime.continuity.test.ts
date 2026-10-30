import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/** Drives the real codex/gemini deliver() with a faked child + faked session store: checks the CLI args
 *  (model, effort, resume) and what is booked afterwards (usage, thread id, reset on a failed resume). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}
let child: FakeChild;
const spawnMock = vi.fn(() => (child = new FakeChild()));
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
const q = { markDelivering: vi.fn(), markDelivered: vi.fn(), markFailed: vi.fn(), requeue: vi.fn(), requeueNoPenalty: vi.fn(), MAX_DELIVERY_ATTEMPTS: 5 };
vi.mock("../queue/index.js", () => q);
vi.mock("../memory/conversation.js", () => ({ recordInbound: vi.fn() }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));
const alertSpy = vi.fn();
const store = {
  sessionToResume: vi.fn((): string | null => null),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  recordUsage: vi.fn(),
  alertConfigFailure: alertSpy,
};
vi.mock("./exec-sessions.js", async (orig) => ({ ...(await orig<typeof import("./exec-sessions.js")>()), ...store }));

const { deliverCodexPrompt } = await import("./codex-runtime.js");
const { deliverGeminiPrompt } = await import("./gemini-runtime.js");

const cfg = { mainAgentId: "zeus", owner: { timezone: "UTC" }, paths: { tenantRoot: "/t" }, web: { port: 3430 } } as never;
let n = 0;
const agent = (extra: object = {}) => ({ id: `ct-${++n}`, dir: "/tmp/does-not-exist", ...extra }) as never;
const item = (a: { id: string }) => ({ id: 1, agent_id: a.id, source: "manual", prompt: "hi", reply_channel: null, attempts: 0 }) as never;
const argsOf = () => (spawnMock.mock.calls.at(-1) as unknown as unknown[])[1] as string[];

beforeEach(() => {
  spawnMock.mockClear();
  for (const f of [...Object.values(q), ...Object.values(store)]) (f as { mockClear?: () => void }).mockClear?.();
  store.sessionToResume.mockReturnValue(null);
});

describe("codex continuity + flags", () => {
  it("first turn: plain exec with -m and reasoning effort", () => {
    const a = agent({ model: "gpt-5.4", effort: "high" });
    deliverCodexPrompt(cfg, a, item(a as { id: string }));
    const args = argsOf();
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.4");
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it("effort 'max' (not a codex level) is not passed", () => {
    const a = agent({ effort: "max" });
    deliverCodexPrompt(cfg, a, item(a as { id: string }));
    expect(argsOf().join(" ")).not.toContain("model_reasoning_effort");
  });

  it("with a stored thread: exec resume <id> <prompt>", () => {
    store.sessionToResume.mockReturnValue("thread-1");
    const a = agent();
    deliverCodexPrompt(cfg, a, item(a as { id: string }));
    const args = argsOf();
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.at(-2)).toBe("thread-1");
    expect(args.at(-1)).toContain("hi");
  });

  it("books the thread id and usage from the event stream on delivery", () => {
    const a = agent() as { id: string };
    deliverCodexPrompt(cfg, a as never, item(a));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "thread.started", thread_id: "T9" }) + "\n"));
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 2 } }) + "\n"),
    );
    child.emit("close", 0);
    expect(store.recordUsage).toHaveBeenCalledWith(a.id, "T9", { input: 60, output: 7, cacheRead: 40, thinking: 2 });
    expect(store.saveSession).toHaveBeenCalledWith(a.id, "codex", "T9", 0, 0); // no rollout file -> unmeasured, not the summed usage
  });

  it("a failed resume resets the conversation and retries without charging an attempt", () => {
    store.sessionToResume.mockReturnValue("stale");
    const a = agent() as { id: string };
    deliverCodexPrompt(cfg, a as never, item(a));
    child.emit("close", 1);
    expect(store.clearSession).toHaveBeenCalledWith(a.id);
    expect(q.requeueNoPenalty).toHaveBeenCalledTimes(1);
    expect(q.requeue).not.toHaveBeenCalled();
  });
});

describe("gemini continuity + flags", () => {
  it("passes --output-format json, --effort and --conversation", () => {
    store.sessionToResume.mockReturnValue("conv-1");
    const a = agent({ effort: "xhigh" });
    deliverGeminiPrompt(cfg, a, item(a as { id: string }));
    const args = argsOf();
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-1");
    expect(args.indexOf("--print")).toBeGreaterThan(args.indexOf("--conversation")); // flags before the prompt
  });

  it("no stored conversation -> no --conversation flag", () => {
    const a = agent();
    deliverGeminiPrompt(cfg, a, item(a as { id: string }));
    expect(argsOf()).not.toContain("--conversation");
  });

  it("books usage + conversation id from the json on stdout", () => {
    const a = agent() as { id: string };
    deliverGeminiPrompt(cfg, a as never, item(a));
    child.stdout.emit("data", Buffer.from('{"conversation_id":"C7","status":"SUCCESS","usage":{"input_tokens":5,"output_tokens":2,"thinking_tokens":1,"cache_read_tokens":0}}'));
    child.emit("close", 0);
    expect(store.saveSession).toHaveBeenCalledWith(a.id, "gemini", "C7", 0, 0); // no conversation db -> unmeasured
    expect(q.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("a failed resume resets the conversation, no attempt charged", () => {
    store.sessionToResume.mockReturnValue("stale");
    const a = agent() as { id: string };
    deliverGeminiPrompt(cfg, a as never, item(a));
    child.emit("close", 1);
    expect(store.clearSession).toHaveBeenCalledWith(a.id);
    expect(q.requeueNoPenalty).toHaveBeenCalledTimes(1);
  });
});

describe("gemini --effort vs --model (agy refuses the combination)", () => {
  it("a pinned model gets NO --effort", () => {
    const a = agent({ model: "gemini-3.8-flash-high", effort: "high" });
    deliverGeminiPrompt(cfg, a, item(a as { id: string }));
    expect(argsOf()).toContain("--model");
    expect(argsOf()).not.toContain("--effort");
  });
  it("no pinned model -> --effort is passed", () => {
    const a = agent({ effort: "low" });
    deliverGeminiPrompt(cfg, a, item(a as { id: string }));
    expect(argsOf()).not.toContain("--model");
    expect(argsOf()[argsOf().indexOf("--effort") + 1]).toBe("low");
  });
});

describe("deterministic config errors fail once and alert", () => {
  it("gemini: exit 1 + status ERROR 'conflicts with --effort' -> failed at attempt 0, no requeue, alert", () => {
    const a = agent({ model: "x" }) as { id: string };
    deliverGeminiPrompt(cfg, a as never, item(a));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ conversation_id: "", status: "ERROR", error: 'invalid model selection (--model "x"): --model x conflicts with --effort=low' })));
    child.emit("close", 1);
    expect(q.markFailed).toHaveBeenCalledTimes(1);
    expect(q.requeue).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith("zeus", a.id, "gemini", 1, expect.stringContaining("conflicts with"));
  });
  it("gemini: a transient exit 1 (no config text) still retries", () => {
    const a = agent() as { id: string };
    deliverGeminiPrompt(cfg, a as never, item(a));
    child.stdout.emit("data", Buffer.from('{"status":"ERROR","error":"upstream 503"}'));
    child.emit("close", 1);
    expect(q.requeue).toHaveBeenCalledTimes(1);
    expect(q.markFailed).not.toHaveBeenCalled();
  });
  it("codex: an error event naming an unknown model fails once and alerts", () => {
    const a = agent({ model: "gpt-9" }) as { id: string };
    deliverCodexPrompt(cfg, a as never, item(a));
    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "error", message: "The model `gpt-9` does not exist" }) + "\n"));
    child.emit("close", 1);
    expect(q.markFailed).toHaveBeenCalledTimes(1);
    expect(q.requeue).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalled();
  });
});
