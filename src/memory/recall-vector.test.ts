import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { saveMemory, searchMemoriesByVector } from "./store.js";
import { recallForPrompt, recallForPromptAsync, PREAMBLE_MAX_CHARS } from "./recall.js";
import { encodeEmbedding } from "./embeddings.js";

/**
 * Hybrid recall, 2026-08-03. The second half of the memory-vector work.
 *
 * WHY IT IS NEEDED, measured not assumed: over marveen's real 912-memory corpus, the FTS topical
 * search returned THE SAME irrelevant memory for five unrelated queries (blood pressure, the car,
 * silent job failures, the accountant, groceries). ftsQuery OR-joins every token including stopwords
 * ("my", "is", "the", "how"), so almost every row matches and the ORDER BY created_at DESC then just
 * returns the newest one. Keyword topical recall was effectively noise. Vectors scored the correct
 * memory in 4 of those 5 (the 5th, blood pressure, has no fleet memory to find, by privacy design).
 *
 * SAFETY PROPERTY, non-negotiable: this runs on the session-start prime path, which is pane-injected
 * through send-keys. If the embedder is slow or down, recall must degrade to exactly today's FTS
 * behaviour rather than delay or fail a delivery.
 */

let dir: string;
// Orthogonal by construction: each seed lights a distinct 96-wide band, so cos(V(a),V(b)) is 1 when
// a===b and 0 otherwise. A smooth function like Math.sin(seed + i*0.001) looks different but is highly
// correlated across seeds, which silently makes a discrimination test pass for the wrong reason.
const V = (seed: number) => Array.from({ length: 768 }, (_, i) => (Math.floor(i / 96) === seed % 8 ? 1 : 0));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-recallvec-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
// saveMemory now FIRES the embedder (fire-and-forget), and Ollama is genuinely running on this box.
// Left alone, that async write lands LATER and overwrites the deterministic vectors these tests seed,
// so assertions pass or fail on a race. Keep fetch failing by default for the whole file: the
// fire-and-forget then writes nothing, seeded vectors stand, and any test that wants a real response
// stubs its own. (Discovered the hard way: the sync tests passed only by beating the race.)
const noEmbedder = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no embedder in tests"); }));
beforeAll(noEmbedder);
afterEach(noEmbedder);

function seed(content: string, category: "hot" | "warm" | "cold" | "shared", vec?: number[], agent = "v") {
  const id = saveMemory({ agentId: agent, content, category });
  if (vec) getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(encodeEmbedding(vec), id);
  return id;
}

describe("searchMemoriesByVector", () => {
  beforeAll(() => {
    seed("the tenancy agreement joint liability clause", "cold", V(1));
    seed("completely unrelated gardening note", "cold", V(900));
    seed("a cold memory with no vector at all", "cold");
  });

  it("ranks by meaning and excludes anything below the floor", () => {
    const hits = searchMemoriesByVector({ agentId: "v", category: ["cold", "shared"], queryVector: V(1), limit: 5, floor: 0.9 });
    expect(hits[0]!.content).toContain("joint liability");
    expect(hits.some((h) => h.content.includes("gardening"))).toBe(false);
  });

  it("rows with no vector are simply absent, never a crash", () => {
    const hits = searchMemoriesByVector({ agentId: "v", category: ["cold"], queryVector: V(1), limit: 50, floor: -1 });
    expect(hits.some((h) => h.content.includes("no vector at all"))).toBe(false);
  });

  it("a stored WRONG-LENGTH vector scores 0 and cannot crash the ranking (Toby's gate)", () => {
    // decodeEmbedding is a pure parser by design, so a short vector reaches the ranker. Every consumer
    // must go through cosineSimilarity, which returns 0 on a length mismatch rather than raw-indexing.
    const id = seed("row carrying a legacy 3-element vector", "cold");
    getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify([1, 2, 3]), id);
    const hits = searchMemoriesByVector({ agentId: "v", category: ["cold"], queryVector: V(1), limit: 50, floor: 0.5 });
    expect(hits.some((h) => h.content.includes("legacy 3-element"))).toBe(false);
  });
});

describe("recallForPrompt — vectors are additive, never a regression", () => {
  beforeAll(() => {
    seed("ACTIVE: chase the lease signature", "hot");
    seed("STABLE: owner prefers short replies", "warm");
  });

  it("without a query vector it behaves exactly as before (FTS only)", () => {
    const a = recallForPrompt("v", "lease");
    const b = recallForPrompt("v", "lease", undefined);
    expect(a).toBe(b);
    expect(a).toContain("chase the lease signature");
  });

  it("with a query vector it surfaces a semantic match that shares NO keywords", () => {
    // "kilakoltatas" appears nowhere in the stored text, so FTS cannot reach it.
    const out = recallForPrompt("v", "kilakoltatas", V(1));
    expect(out).toContain("joint liability");
  });

  it("hot and warm still lead and are never displaced by topical hits", () => {
    const out = recallForPrompt("v", "kilakoltatas", V(1));
    expect(out.indexOf("chase the lease signature")).toBeLessThan(out.indexOf("joint liability"));
    expect(out.indexOf("owner prefers short replies")).toBeLessThan(out.indexOf("joint liability"));
  });

  it("never exceeds the preamble budget", () => {
    expect(recallForPrompt("v", "kilakoltatas", V(1)).length).toBeLessThanOrEqual(PREAMBLE_MAX_CHARS + 200);
  });
});

describe("recallForPromptAsync — the embedder can never block a delivery", () => {
  it("embedder down -> identical output to the FTS-only path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await recallForPromptAsync("v", "lease")).toBe(recallForPrompt("v", "lease"));
  });

  it("embedder hanging -> returns within the timeout, still with the FTS answer", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const t0 = Date.now();
    const out = await recallForPromptAsync("v", "lease", 300);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out).toBe(recallForPrompt("v", "lease"));
  });

  it("embedder healthy -> the semantic hit appears", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: V(1) }) })));
    expect(await recallForPromptAsync("v", "kilakoltatas")).toContain("joint liability");
  });
});

describe("topical must not be starved by a large hot/warm bundle", () => {
  it("a semantic hit still appears when hot+warm alone exceed the whole budget", () => {
    // The live failure this pins, found by checking production instead of trusting the suite: marveen
    // has 26 hot + 378 warm memories, roughly 197,000 chars after the per-entry cap, against a 6,000
    // char budget. Under strict hot -> warm -> topical priority the loop breaks long before topical,
    // so vector search was correct and STRUCTURALLY UNREACHABLE. Any agent with more than a dozen
    // warm memories had the same silent starvation.
    for (let i = 0; i < 60; i++) seed(`WARM FILLER ${i} ` + "x".repeat(400), "warm");
    seed("the eviction and notary undertaking", "cold", V(3));
    const out = recallForPrompt("v", "kilakoltatas", V(3));
    expect(out).toContain("eviction and notary undertaking");
    expect(out.length).toBeLessThanOrEqual(PREAMBLE_MAX_CHARS + 200);
  });
});

describe("every tier gets a guaranteed slice, none starves another", () => {
  it("long hot memories cannot push warm out of the preamble entirely", () => {
    // Measured in production: marveen/darryl/cfo were getting 8 hot + 3 topical and ZERO warm, because
    // hot entries are long and strict priority let them eat the whole non-topical budget. Warm is the
    // stable-facts tier (preferences, config, project context), so losing it entirely is a correctness
    // problem, not a cosmetic one. My topical reserve made it worse: it took its slice off the top and
    // left even less for warm.
    for (let i = 0; i < 12; i++) seed(`HOT LONG ${i} ` + "h".repeat(480), "hot", undefined, "v2");
    for (let i = 0; i < 12; i++) seed(`WARM FACT ${i} owner preference number ${i}`, "warm", undefined, "v2");
    const out = recallForPrompt("v2", "anything");
    expect(out).toContain("HOT LONG");
    expect(out).toContain("WARM FACT");
  });
});

describe("keyword hits get reserved slots INSIDE topical (Darryl, the 4th starvation)", () => {
  it("saturated vector hits cannot zero out keyword-only matches", () => {
    // The one place I did not apply my own reserve. The byte budget got reserves; the topical
    // RESULT-SET assembly did not. Vectors push first up to MAX_TOPICAL, so once they saturate, the
    // keyword search contributes nothing — and keyword-only matches are exactly the exact-string ids
    // and invoice numbers the comment says keywords exist for. Verified by Darryl on real data:
    // 6 vector hits saturated the set and all 6 keyword-only hits were dropped.
    for (let i = 0; i < 8; i++) seed(`semantically adjacent filler ${i}`, "cold", V(5), "v3");
    seed("INV-2026-0099 exact invoice reference", "cold", V(6), "v3"); // vector-far, keyword-near
    const out = recallForPrompt("v3", "INV-2026-0099", V(5));
    expect(out).toContain("INV-2026-0099");
  });
});

describe("the documented cap covers the WHOLE preamble, frame included", () => {
  it("total output never exceeds PREAMBLE_MAX_CHARS", () => {
    // The constant is documented as "Hard cap on the WHOLE preamble", but the header, footer and the
    // "N more" line were uncounted, so a full preamble measured ~6150 in production (Darryl's nit).
    for (let i = 0; i < 40; i++) seed(`BULK ${i} ` + "z".repeat(460), "warm", undefined, "v4");
    for (let i = 0; i < 10; i++) seed(`BULK HOT ${i} ` + "z".repeat(460), "hot", undefined, "v4");
    expect(recallForPrompt("v4", "anything").length).toBeLessThanOrEqual(PREAMBLE_MAX_CHARS);
  });
});
