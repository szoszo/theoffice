import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Control memory recall + the shared cap so we can prove the COMBINED preamble stays within budget.
// Everything the hoisted vi.mock factory touches must live inside vi.hoisted (the factory is lifted to top).
const h = vi.hoisted(() => ({ cap: 6000, recall: "" }));
vi.mock("../memory/recall.js", () => ({
  PREAMBLE_MAX_CHARS: h.cap,
  recallForPrompt: () => h.recall,
  recallForPromptAsync: async (...a: unknown[]) => (() => h.recall)(...(a as [])),
}));
const CAP = 6000;
const recallMock = { set value(v: string) { h.recall = v; } };

import { goalsForPrompt, firstMessagePreamble } from "./goals.js";

const cfg = (r: string): any => ({ paths: { tenantRoot: r } });

describe("goalsForPrompt (operator goals layer, issue #21 §3)", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goals-"));
    recallMock.value = "";
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns '' when GOALS.md is absent (pure no-op for tenants that don't use it)", async () => {
    expect(goalsForPrompt(cfg(root))).toBe("");
  });

  it("returns '' for an empty / whitespace-only GOALS.md", async () => {
    writeFileSync(join(root, "GOALS.md"), "   \n\n  ");
    expect(goalsForPrompt(cfg(root))).toBe("");
  });

  it("frames the goals under a prioritize-against header and preserves the content", async () => {
    writeFileSync(join(root, "GOALS.md"), "- Ship K-Ops migration\n- Owner health never slips");
    const out = goalsForPrompt(cfg(root));
    expect(out).toMatch(/^OPERATOR GOALS/);
    expect(out).toContain("Ship K-Ops migration");
    expect(out).toContain("Owner health never slips");
  });

  it("respects the absolute cap on an oversized GOALS.md (truncates with a marker)", async () => {
    writeFileSync(join(root, "GOALS.md"), "x".repeat(6000));
    const out = goalsForPrompt(cfg(root));
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out).toContain("(truncated)");
  });

  it("YIELDS (returns '') when the given budget leaves no room for a meaningful block", async () => {
    writeFileSync(join(root, "GOALS.md"), "- a real goal");
    expect(goalsForPrompt(cfg(root), 30)).toBe(""); // 30 < header + 20 -> yield to memory
  });

  it("never exceeds the budget it was given", async () => {
    writeFileSync(join(root, "GOALS.md"), "y".repeat(2000));
    expect(goalsForPrompt(cfg(root), 300).length).toBeLessThanOrEqual(300);
  });
});

describe("firstMessagePreamble — goals + memory share ONE pane-inject cap", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "goals-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // The one way this feature could regress the pane-inject: near-cap memory + a full GOALS.md must NOT
  // push the combined preamble over the cap. Memory keeps its budget; goals truncates into the remainder.
  it("GUARDRAIL: near-cap memory + full GOALS.md -> combined <= cap, memory intact, goals truncated", async () => {
    recallMock.value = "M".repeat(5200); // memory takes most of the budget
    writeFileSync(join(root, "GOALS.md"), "G".repeat(3000)); // a full goals file
    const pre = await firstMessagePreamble(cfg(root), "agent-x", "hi");
    expect(pre.length).toBeLessThanOrEqual(CAP); // combined stays within the cap
    expect(pre).toContain("M".repeat(5200)); // memory NOT starved — its full block is present
    expect(pre).toContain("OPERATOR GOALS"); // goals still made it in...
    expect(pre).toContain("(truncated)"); // ...but truncated into the leftover space
  });

  it("EXTREME: memory nearly fills the cap -> goals yields entirely, memory intact, combined <= cap", async () => {
    recallMock.value = "M".repeat(5960);
    writeFileSync(join(root, "GOALS.md"), "G".repeat(2000));
    const pre = await firstMessagePreamble(cfg(root), "agent-x", "hi");
    expect(pre.length).toBeLessThanOrEqual(CAP);
    expect(pre).toBe("M".repeat(5960)); // only memory — goals had no room and yielded
  });

  it("with room: BOTH goals (framing, on top) and memory, combined <= cap", async () => {
    recallMock.value = "some memory";
    writeFileSync(join(root, "GOALS.md"), "- ship it");
    const pre = await firstMessagePreamble(cfg(root), "agent-x", "hi");
    expect(pre).toMatch(/^OPERATOR GOALS/); // goals framed at the top
    expect(pre).toContain("ship it");
    expect(pre).toContain("some memory");
    expect(pre.length).toBeLessThanOrEqual(CAP);
  });

  it("no memory + no GOALS.md -> '' (nothing injected)", async () => {
    recallMock.value = "";
    expect(await firstMessagePreamble(cfg(root), "agent-x", "hi")).toBe("");
  });
});
