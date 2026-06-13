import { describe, it, expect } from "vitest";
import type { AgentDef } from "../types.js";
import { getRuntime, runtimeFor, isKnownRuntime, listRuntimes, DEFAULT_RUNTIME } from "./runtime.js";

const agent = (runtime?: string): AgentDef => ({
  id: "x",
  displayName: "X",
  dir: "/tmp/x",
  enabled: true,
  runtime,
});

describe("runtime registry", () => {
  it("ships claude + codex as registered providers", () => {
    const ids = listRuntimes().map((r) => r.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
  });

  it("defaults unset/unknown runtimes to claude (safe revert semantics)", () => {
    expect(getRuntime(undefined).id).toBe(DEFAULT_RUNTIME);
    expect(getRuntime("nope").id).toBe(DEFAULT_RUNTIME);
    expect(DEFAULT_RUNTIME).toBe("claude");
  });

  it("resolves a known runtime by id", () => {
    expect(getRuntime("codex").id).toBe("codex");
    expect(runtimeFor(agent("codex")).id).toBe("codex");
    expect(runtimeFor(agent()).id).toBe("claude");
  });

  it("isKnownRuntime gates only registered ids", () => {
    expect(isKnownRuntime("claude")).toBe(true);
    expect(isKnownRuntime("codex")).toBe(true);
    expect(isKnownRuntime("gemini")).toBe(false);
    expect(isKnownRuntime(undefined)).toBe(false);
  });

  it("advertises claude --model ids and no per-launch model for codex", () => {
    expect(getRuntime("claude").models.length).toBeGreaterThan(0);
    expect(getRuntime("codex").models.length).toBe(0);
  });

  it("claude readiness is decided live (isBusy always false), not via a tracked flag", () => {
    expect(getRuntime("claude").isBusy("x")).toBe(false);
  });
});
