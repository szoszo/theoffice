import { describe, it, expect, vi, afterEach } from "vitest";
import { cosineSimilarity, encodeEmbedding, decodeEmbedding, generateEmbedding } from "./embeddings.js";

/**
 * Memory vectors, added 2026-08-03.
 *
 * Context: the `embedding` column has existed since ClaudeClaw, but The Office runtime never wrote to
 * it. The last memory to get a vector was 2026-06-09, the day of the migration; the 2,375 saved since
 * have none, and the 647 that do are orphans imported from the old system. Recall still worked because
 * it runs on FTS keywords, so nothing looked broken — it just could not match by MEANING ("the flat"
 * never finds a memory that only says "the Baker Street unit").
 *
 * The load-bearing rule here: EMBEDDING FAILURE MUST NEVER COST A MEMORY. Ollama is a local service
 * that can be down, slow, or mid-restart. Saving the memory is the thing that matters; the vector is an
 * enhancement that can be backfilled later. So every function in this module degrades to null/0 rather
 * than throwing.
 */

afterEach(() => vi.unstubAllGlobals());

describe("cosineSimilarity", () => {
  it("identical vectors -> 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("orthogonal vectors -> 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("opposite vectors -> -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("scale does not matter, only direction", () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
  });

  it("mismatched lengths -> 0, never a throw or a NaN", () => {
    // A model change would silently alter the dimension. Ranking must degrade, not crash the recall path.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("zero or empty vectors -> 0, never a divide-by-zero NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("encode / decode", () => {
  it("round-trips a vector through the TEXT column", () => {
    const v = [0.0125, -0.9, 3];
    expect(decodeEmbedding(encodeEmbedding(v))).toEqual(v);
  });

  it("decodes junk to null instead of throwing", () => {
    // The column is TEXT and holds rows written by the OLD system. A single bad row must not take
    // down a search over 3,000 memories.
    expect(decodeEmbedding(null)).toBeNull();
    expect(decodeEmbedding("")).toBeNull();
    expect(decodeEmbedding("not json")).toBeNull();
    expect(decodeEmbedding('{"nope":1}')).toBeNull();
    expect(decodeEmbedding("[1,\"two\",3]")).toBeNull();
  });
});

describe("generateEmbedding — degrades, never throws", () => {
  it("returns the vector Ollama gives back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: [1, 2, 3] }) })));
    expect(await generateEmbedding("hello")).toEqual([1, 2, 3]);
  });

  it("Ollama down (fetch throws) -> null, no exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("non-OK response -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("malformed body -> null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: "not-an-array" }) })));
    expect(await generateEmbedding("hello")).toBeNull();
  });

  it("empty input is not sent to the model at all", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await generateEmbedding("   ")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("truncates very long content before sending", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ embedding: [1] }) }));
    vi.stubGlobal("fetch", f);
    await generateEmbedding("x".repeat(9000));
    const body = JSON.parse((f.mock.calls[0]![1] as { body: string }).body);
    expect(body.prompt.length).toBeLessThanOrEqual(2000);
  });
});
