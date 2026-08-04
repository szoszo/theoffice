/**
 * Memory vectors via the local Ollama instance.
 *
 * WHY THIS EXISTS: the `memories.embedding` column came across in the ClaudeClaw import, but The
 * Office runtime never wrote to it. The last memory to get a vector was 2026-06-09, the migration day.
 * Recall kept working because it runs on FTS keywords, so the gap was invisible: it just could not
 * match on MEANING, so a question about "the flat" never surfaced a memory that only says "the Baker Street unit".
 *
 * DESIGN RULE, load-bearing: AN EMBEDDING FAILURE MUST NEVER COST A MEMORY OR BREAK A SEARCH. Ollama
 * is a local service that can be down, restarting, or slow, and the memory itself is the valuable
 * thing — the vector is an enhancement that a backfill can add later. So every function here returns
 * null / 0 instead of throwing, and callers treat a missing vector as "fall back to keywords".
 */

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
/**
 * Multilingual by default, chosen by measurement on a real bilingual store rather than by reputation
 * (2026-08-03, prompted by the parallel fork having done the same experiment and written it down).
 *
 * nomic-embed-text is excellent English-only and was the previous default. On 12 real questions
 * against 250 real memories it scored recall@1 3/12 and — the finding that mattered — HUNGARIAN
 * 0/6, ranking correct memories 53rd, 81st, 192nd and 249th. A memory you cannot retrieve in the
 * language you ask in is not stored as far as the owner is concerned, and nothing reported this:
 * vector COVERAGE was 100%, because coverage counts rows with a vector, not vectors that find
 * anything.
 *
 * bge-m3 on the identical set: recall@1 6/12, recall@5 11/12, Hungarian 3/6 with five of six in the
 * top two. recall@5 is the number to watch — agents are told to search with a generous limit and
 * read the results, so "in the top five" is what retrieval actually has to deliver.
 *
 * Cost: ~438ms for a query and ~1.4s per document warm, against ~108ms/~399ms for nomic. Queries
 * stay well inside RECALL_EMBED_TIMEOUT_MS; documents are embedded in the background or by backfill,
 * where seconds do not matter. Set EMBED_MODEL=nomic-embed-text (with EMBED_DIM=768) to go back —
 * a sensible choice for an English-only store on a small box.
 */
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";
/** Matches the old ClaudeClaw generator, so backfilled and live vectors stay comparable. */
const MAX_INPUT_CHARS = 2000;
/**
 * bge-m3 returns 1024 dimensions. A vector of any other length is REJECTED rather than
 * stored, because a stored wrong-length vector is the worst of both worlds: cosine reads 0 against
 * every real vector (semantically dead), yet the row counts as "covered" and the backfill, which
 * selects WHERE embedding IS NULL, never retries it. Leaving the row NULL is honest and self-healing.
 * Found by Toby's adversarial pass on fc077ea, 2026-08-03, before it could bite.
 */
export const EXPECTED_DIM = Number(process.env.EMBED_DIM ?? 1024);
/** Ollama is local; a hung request must not stall a memory save or a recall. */
const TIMEOUT_MS = 20_000;

/** Cosine similarity, clamped to 0 for anything degenerate (empty, zero-norm, dimension mismatch). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function encodeEmbedding(v: number[]): string {
  return JSON.stringify(v);
}

/**
 * Parse a stored vector. Returns null for anything that is not a clean array of finite numbers —
 * the column is TEXT and holds rows written by an older system, and one bad row must not take down a
 * search across every memory.
 */
export function decodeEmbedding(s: string | null | undefined): number[] | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    if (!Array.isArray(v) || v.length === 0) return null;
    if (!v.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return v as number[]; // no dimension opinion here: this is a parser. The write side is the gate,
  } catch {                //  and cosineSimilarity already returns 0 on a length mismatch.
    return null;
  }
}

/** Embed one piece of text. Returns null on empty input or any Ollama failure. */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const prompt = (text ?? "").trim().slice(0, MAX_INPUT_CHARS);
  if (!prompt) return null;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embedding?: unknown };
    const v = data?.embedding;
    if (!Array.isArray(v) || v.length === 0) return null;
    if (!v.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if (v.length !== EXPECTED_DIM) return null; // half-loaded / swapped model — keep the row NULL
    return v as number[];
  } catch {
    return null; // Ollama down / timeout / bad JSON — the caller keeps its keyword path
  }
}
