import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db/index.js";
import { saveMemory } from "./store.js";
import { recallForPrompt } from "./recall.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-recall-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("recallForPrompt — bounded session-start preamble", () => {
  it("returns empty when the agent has no memory", () => {
    expect(recallForPrompt("ghost", "anything")).toBe("");
  });

  it("caps the total preamble to a few KB even with a memory-heavy agent", () => {
    // 80 hot + warm memories at 500 chars each = ~40KB of raw content — the exact overload case.
    for (let i = 0; i < 40; i++) saveMemory({ agentId: "heavy", category: "hot", content: `H${i}-${"x".repeat(500)}` });
    for (let i = 0; i < 40; i++) saveMemory({ agentId: "heavy", category: "warm", content: `W${i}-${"y".repeat(500)}` });

    const out = recallForPrompt("heavy", "");
    expect(out.length).toBeLessThan(6500); // hard cap (~6KB) + small header/footer, never 40KB
    expect(out).toContain("[Your memory");
    expect(out).toContain("more memories not shown"); // truncation is disclosed, not silent
  });

  it("prioritizes hot over warm when the budget is tight", () => {
    // Fill the budget entirely with hot so warm is pushed out — hot is active work, must win the space.
    for (let i = 0; i < 30; i++) saveMemory({ agentId: "prio", category: "hot", content: `HOT${i}-${"a".repeat(450)}` });
    saveMemory({ agentId: "prio", category: "warm", content: "WARM-should-be-dropped" });

    const out = recallForPrompt("prio", "");
    expect(out).toContain("HOT0");
    expect(out).not.toContain("WARM-should-be-dropped");
  });

  it("surfaces a small agent's memory fully and untruncated", () => {
    saveMemory({ agentId: "small", category: "hot", content: "active task A" });
    saveMemory({ agentId: "small", category: "warm", content: "owner prefers X" });

    const out = recallForPrompt("small", "");
    expect(out).toContain("active task A");
    expect(out).toContain("owner prefers X");
    expect(out).not.toContain("more memories not shown");
  });
});
