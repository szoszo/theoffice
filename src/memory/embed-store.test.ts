import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { saveMemory, attachEmbedding, countEmbeddings } from "./store.js";

/**
 * Saving a memory must NEVER depend on Ollama being up. The vector is an enhancement; the memory is
 * the asset. These tests pin that contract, because the failure mode we are fixing (2026-08-03) was
 * exactly a silent gap between "memory saved" and "memory searchable by meaning".
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-embed-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

const embeddingOf = (id: number) =>
  (getDb().prepare("SELECT embedding FROM memories WHERE id = ?").get(id) as { embedding: string | null }).embedding;

describe("attachEmbedding", () => {
  it("writes the vector onto the row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: Array(768).fill(0.5) }) })));
    const id = saveMemory({ agentId: "a", content: "the flat on Baker Street" });
    expect(await attachEmbedding(id, "the flat on Baker Street")).toBe(true);
    expect(JSON.parse(embeddingOf(id)!)).toHaveLength(768);
  });

  it("Ollama down -> returns false and LEAVES THE MEMORY INTACT, unvectorized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const id = saveMemory({ agentId: "a", content: "saved while ollama was down" });
    expect(await attachEmbedding(id, "saved while ollama was down")).toBe(false);
    expect(embeddingOf(id)).toBeNull();
    // the row itself must still be there and searchable by keyword
    const row = getDb().prepare("SELECT content FROM memories WHERE id = ?").get(id) as { content: string };
    expect(row.content).toBe("saved while ollama was down");
  });

});

describe("saveMemory never blocks on the embedder", () => {
  it("returns an id even when Ollama hangs past any sane timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // never resolves
    const t0 = Date.now();
    const id = saveMemory({ agentId: "a", content: "hang test" });
    expect(id).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(1000); // synchronous, not awaiting the model
  });
});

describe("countEmbeddings — the observability that was missing", () => {
  it("reports total vs embedded so the gap can never go unnoticed again", async () => {
    const c = countEmbeddings();
    expect(c.total).toBeGreaterThan(0);
    expect(c.embedded).toBeGreaterThanOrEqual(1);
    expect(c.missing).toBe(c.total - c.embedded);
  });

  it("counts wrong-dimension vectors separately, so a dead one cannot hide inside 'covered'", () => {
    // Legacy rows, or anything written before the dimension check existed, could hold a vector of the
    // wrong length. It reads cosine 0 against everything, so it is dead weight that LOOKS like coverage.
    const id = saveMemory({ agentId: "dim", content: "row with a legacy short vector" });
    getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify([1, 2, 3]), id);
    const c = countEmbeddings();
    expect(c.wrongDim).toBeGreaterThanOrEqual(1);
    expect(c.usable).toBe(c.embedded - c.wrongDim);
  });
});

describe("attachEmbedding reports what actually happened", () => {
  it("a row that does not exist returns false, not a false success", async () => {
    // Cosmetic but it is a truth claim: returning true for a zero-row UPDATE would let a caller
    // believe a vector landed when nothing was written.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: Array(768).fill(0.2) }) })));
    expect(await attachEmbedding(999_999, "nonexistent row")).toBe(false);
  });
});
