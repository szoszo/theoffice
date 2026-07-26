import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The launch flags are what make a pinned model/effort survive a restart: verified live that
 * `--effort max` wins over an `effortLevel: high` in the shared ~/.claude/settings.json (all agents
 * and the owner's own CLI share one HOME, because the credentials live there). This test locks in
 * that the flags are actually built from agent.json.
 */
const h = vi.hoisted(() => ({ command: [] as string[] }));

vi.mock("./tmux.js", () => ({
  sessionNameFor: (id: string) => `agent-${id}`,
  newSession: (_s: string, _n: string, opts: { command: string[] }) => {
    h.command = opts.command;
    return true;
  },
  hasSession: () => true,
  capturePane: () => "PANE",
  sendText: () => {},
  sendKey: () => {},
  clearInput: () => {},
}));
vi.mock("./pane-state.js", () => ({ detectPaneState: () => "idle", decideSubmitFollowup: () => "done" }));
vi.mock("./profile.js", () => ({ writeAgentSettings: () => {} }));
vi.mock("./trust.js", () => ({ ensureClaudeGatesAccepted: () => {} }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

import { claudeRuntime } from "./claude-runtime.js";
import type { AgentDef, EngineConfig } from "../types.js";

const cfg = {
  tmux: { socket: "s" },
  owner: { timezone: "Europe/Budapest" },
  paths: { tenantRoot: "/t", agentsDir: "/t/agents" },
  web: { port: 3430 },
} as unknown as EngineConfig;

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "x",
  displayName: "X",
  dir: "/tmp/x",
  enabled: true,
  ...over,
});

describe("launchClaude flags", () => {
  beforeEach(() => {
    h.command = [];
  });

  it("passes --effort when the agent pins one", () => {
    claudeRuntime.launch(cfg, agent({ effort: "xhigh" }));
    expect(h.command).toContain("--effort");
    expect(h.command[h.command.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("omits --effort entirely when unset, so the CLI default applies", () => {
    claudeRuntime.launch(cfg, agent());
    expect(h.command).not.toContain("--effort");
  });

  it("still passes --model, and both flags coexist", () => {
    claudeRuntime.launch(cfg, agent({ model: "claude-opus-5", effort: "max" }));
    expect(h.command[h.command.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(h.command[h.command.indexOf("--effort") + 1]).toBe("max");
  });
});
