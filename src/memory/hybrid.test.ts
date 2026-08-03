import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { saveMemory, searchMemories, searchMemoriesHybrid } from "./store.js";
import { encodeEmbedding } from "./embeddings.js";

/**
 * The ON-DEMAND search path, GET /api/memories?q=.
 *
 * This is the one agents actually call when they go looking for something — the recall preamble even
 * tells them to ("search your memory for specifics"). It was still keyword-only after the recall work,
 * so the automatic slice understood meaning while the deliberate search did not. Same half-done shape.
 */
let dir: string;
const V = (s: number) => Array.from({ length: 768 }, (_, i) => (Math.floor(i / 96) === s % 8 ? 1 : 0));
const noEmbedder = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no embedder"); }));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-hybrid-"));
  openDb(join(dir, "test.db"));
  noEmbedder(); // keep saveMemory's fire-and-forget from overwriting the seeded vectors
  const id = saveMemory({ agentId: "h", content: "the eviction undertaking before a notary", category: "cold" });
  getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(encodeEmbedding(V(2)), id);
  saveMemory({ agentId: "h", content: "invoice INV-2026-0042 for the listing", category: "cold" });
});
afterAll(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
afterEach(noEmbedder);

describe("searchMemoriesHybrid", () => {
  it("finds by MEANING when the words do not match at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(2) }) })));
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "kilakoltatas", limit: 5 });
    expect(rows.some((r) => r.content.includes("eviction undertaking"))).toBe(true);
  });

  it("still finds an exact string vectors are bad at, like an invoice number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(7) }) })));
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "INV-2026-0042", limit: 5 });
    expect(rows.some((r) => r.content.includes("INV-2026-0042"))).toBe(true);
  });

  it("embedder down -> exactly the keyword result, never an error", async () => {
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "invoice", limit: 5 });
    expect(rows.map((r) => r.id)).toEqual(searchMemories({ agentId: "h", q: "invoice", limit: 5 }).map((r) => r.id));
  });

  it("respects the limit and never duplicates a row across both paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(2) }) })));
    const rows = await searchMemoriesHybrid({ agentId: "h", q: "eviction", limit: 2 });
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});
