import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Locks FIX2: session-freshness priming. The recalled-memory preamble must be injected on the FIRST
 * delivery to a genuinely NEW session and never again, and an existing/surviving session (engine restart,
 * newSession=false) must NOT be primed. The load-bearing invariant is the INVERSION: an agent the launcher
 * never flagged defaults to do-NOT-prime, so a refactor can't silently regress to the old engine-lifetime
 * bug (where every engine restart re-primed live sessions).
 *
 * `needsPrime` is module-private and the logic runs through launchClaude/deliverClaude (tmux + pane), so we
 * drive the real code via the public claudeRuntime interface with tmux/pane/IO mocked, and observe whether
 * the preamble reaches the pane (spying on the injected send-keys text). recallForPrompt is stubbed to a
 * sentinel so the assertion is purely about the prime GATE, not recall content.
 */

const h = vi.hoisted(() => ({ sent: [] as string[], newSessionOk: true }));

vi.mock("./tmux.js", () => ({
  sessionNameFor: (id: string) => `agent-${id}`,
  newSession: () => h.newSessionOk, // controllable: true = fresh session created, false = already existed
  hasSession: () => true,
  capturePane: () => "PANE",
  sendText: (_socket: string, _name: string, text: string) => {
    h.sent.push(text);
  },
  sendKey: () => {},
  clearInput: () => {},
}));
vi.mock("./pane-state.js", () => ({
  detectPaneState: () => "idle", // always ready, so deliverClaude proceeds to injection
  decideSubmitFollowup: () => "done", // submit confirmed on the first check
}));
vi.mock("./profile.js", () => ({ writeAgentSettings: () => {} }));
vi.mock("./trust.js", () => ({ ensureFolderTrusted: () => {} }));
vi.mock("../queue/index.js", () => ({
  markDelivering: () => {},
  markDelivered: () => {},
  markFailed: () => {},
  requeue: () => {},
}));
vi.mock("../memory/conversation.js", () => ({ recordInbound: () => {} }));
vi.mock("../memory/recall.js", () => ({ recallForPrompt: () => "MEM_PREAMBLE_SENTINEL" }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

import { claudeRuntime } from "./claude-runtime.js";

const cfg = {
  tmux: { socket: "test" },
  owner: { timezone: "UTC" },
  paths: { tenantRoot: "/tmp", agentsDir: "/tmp" },
  web: { port: 0 },
} as unknown as Parameters<typeof claudeRuntime.launch>[0];

const agent = (id: string) => ({ id, displayName: id, dir: "/tmp", enabled: true }) as never;
const item = (id: string, n: number) =>
  ({ id: n, agent_id: id, source: "manual", prompt: "hello there", reply_channel: null, attempts: 0 }) as never;

/** Text injected into the pane during the current delivery (chunks concatenated). */
const injected = () => h.sent.join("");

beforeEach(() => {
  h.sent.length = 0;
});

describe("FIX2 — priming keyed to session freshness, not engine lifetime", () => {
  it("a NEW session (newSession=true) is primed once, then the flag clears", async () => {
    h.newSessionOk = true;
    expect(claudeRuntime.launch(cfg, agent("fresh"))).toBe(true); // launcher flags it for prime

    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("fresh"), item("fresh", 1));
    expect(injected()).toContain("MEM_PREAMBLE_SENTINEL"); // primed on first delivery
    expect(injected()).toContain("hello there");

    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("fresh"), item("fresh", 2));
    expect(injected()).not.toContain("MEM_PREAMBLE_SENTINEL"); // flag cleared -> no re-prime
    expect(injected()).toContain("hello there");
  }, 15000);

  it("a surviving session (newSession=false, e.g. engine restart) is NOT primed", async () => {
    h.newSessionOk = false;
    expect(claudeRuntime.launch(cfg, agent("survivor"))).toBe(false); // not flagged

    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("survivor"), item("survivor", 3));
    expect(injected()).not.toContain("MEM_PREAMBLE_SENTINEL");
    expect(injected()).toContain("hello there");
  }, 15000);

  it("the inversion guard: an agent never flagged defaults to do-NOT-prime", async () => {
    // No launch() at all for this agent — exactly the engine-restart-with-live-session shape. The old bug
    // would prime here (default = prime); the fixed default (empty needsPrime) must NOT.
    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("unflagged"), item("unflagged", 4));
    expect(injected()).not.toContain("MEM_PREAMBLE_SENTINEL");
    expect(injected()).toContain("hello there");
  }, 15000);
});
