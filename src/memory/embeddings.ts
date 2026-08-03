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
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
/** Matches the old ClaudeClaw generator, so backfilled and live vectors stay comparable. */
const MAX_INPUT_CHARS = 2000;
/**
 * nomic-embed-text returns 768 dimensions. A vector of any other length is REJECTED rather than
 * stored, because a stored wrong-length vector is the worst of both worlds: cosine reads 0 against
 * every real vector (semantically dead), yet the row counts as "covered" and the backfill, which
 * selects WHERE embedding IS NULL, never retries it. Leaving the row NULL is honest and self-healing.
 * Found by Toby's adversarial pass on fc077ea, 2026-08-03, before it could bite.
 */
export const EXPECTED_DIM = Number(process.env.EMBED_DIM ?? 768);
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
