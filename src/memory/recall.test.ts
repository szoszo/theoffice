import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
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

  it("hot LEADS and takes the most space, but can no longer eliminate warm entirely", () => {
    // POLICY CHANGED 2026-08-03, deliberately. This used to assert warm was dropped completely when hot
    // filled the budget. Production showed what that costs: marveen, darryl and cfo were waking with 8
    // hot memories and ZERO warm, so an agent recalled its active work and none of the owner's stable
    // preferences or project context. Warm now has a guaranteed floor. Hot still leads, appears first
    // and gets the largest share; it simply cannot starve the tier that holds "how the owner wants
    // things done".
    for (let i = 0; i < 30; i++) saveMemory({ agentId: "prio", category: "hot", content: `HOT${i}-${"a".repeat(450)}` });
    saveMemory({ agentId: "prio", category: "warm", content: "WARM-stable-fact" });

    const out = recallForPrompt("prio", "");
    expect(out).toContain("HOT0");
    expect(out).toContain("WARM-stable-fact");
    expect(out.indexOf("HOT0")).toBeLessThan(out.indexOf("WARM-stable-fact")); // hot still reads first
    expect((out.match(/- \(hot\)/g) ?? []).length).toBeGreaterThan((out.match(/- \(warm\)/g) ?? []).length);
  });

  it("surfaces a small agent's memory fully and untruncated", () => {
    saveMemory({ agentId: "small", category: "hot", content: "active task A" });
    saveMemory({ agentId: "small", category: "warm", content: "owner prefers X" });

    const out = recallForPrompt("small", "");
    expect(out).toContain("active task A");
    expect(out).toContain("owner prefers X");
    expect(out).not.toContain("more memories not shown");
  });

  it("REGRESSION (#13/#14): a hot memory survives even when >200 NEWER cold/shared memories exist", () => {
    // The bug: the old always-fetch took the 200 most-recent rows of ANY tier, so newer history evicted
    // hot/warm entirely. Save one hot, THEN 250 newer cold/shared — the hot must still surface.
    const hotId = saveMemory({ agentId: "crowd", category: "hot", content: "CRITICAL-hot-active-task" });
    // make the hot strictly OLDER than the noise (created_at is second-granularity, so pin it explicitly —
    // otherwise same-second ties make the eviction order undefined and the test loses its teeth).
    getDb().prepare(`UPDATE memories SET created_at = 1000 WHERE id = ?`).run(hotId);
    for (let i = 0; i < 250; i++)
      saveMemory({ agentId: "crowd", category: i % 2 ? "cold" : "shared", content: `noise-${i}` });

    const out = recallForPrompt("crowd", ""); // no prompt -> only the always-bundle (hot+warm)
    expect(out).toContain("CRITICAL-hot-active-task"); // never crowded out by newer cold/shared
  });

  it("topical cold/shared matches the prompt and rides alongside the always-bundle", () => {
    saveMemory({ agentId: "topic", category: "hot", content: "current sprint work" });
    saveMemory({ agentId: "topic", category: "cold", content: "the pangolin migration runbook from last year" });
    saveMemory({ agentId: "topic", category: "warm", content: "unrelated stable fact" });

    const out = recallForPrompt("topic", "how did the pangolin migration go");
    expect(out).toContain("current sprint work"); // always-bundle present
    expect(out).toContain("pangolin migration runbook"); // cold matched by FTS on the prompt
  });
});
