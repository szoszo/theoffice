import { searchMemories, searchMemoriesByVector, type MemoryRow } from "./store.js";
import { generateEmbedding } from "./embeddings.js";

// How much memory to surface when an agent is primed at the start of a session.
const MAX_TOPICAL = 6; // cold/shared memories matched to the incoming message
/** Below this cosine, a "semantic match" is noise. Empirically 0.30 is unrelated, 0.50+ is on-topic. */
const VECTOR_FLOOR = 0.42;
/**
 * Slots inside the topical set reserved for KEYWORD hits. Vectors are better at meaning and worse at
 * exact strings (ids, invoice numbers, proper nouns), which is the whole reason both paths exist. With
 * vectors filling the set first, a saturated vector result zeroed the keyword contribution entirely.
 *
 * SCOPE OF THE GUARANTEE, stated precisely because the earlier wording overclaimed: this reserves
 * SLOTS in the result set, not BYTES in the preamble. Keyword-reserved entries sit last, so the byte
 * budget can still drop them behind longer vector entries. That is deliberate, not an oversight:
 * forcing them ahead would spend a scarce topical slot on FTS output that is measurably noisy (Darryl
 * observed the reserved keyword hits on real data were briefing feedback, not the queried topic), and
 * trading a good semantic match for noise is a bad default.
 *
 * The place an exact string is GUARANTEED to be findable is the on-demand search
 * (searchMemoriesHybrid, GET /api/memories?q=), which reserves keyword slots and has no byte budget.
 * Session-start recall gives keywords a fair chance; deliberate lookup is where they are guaranteed.
 */
const TOPICAL_KEYWORD_SLOTS = 2;
/** The embedder sits on the session-start prime path, so it gets a short leash, not the 20s default. */
const RECALL_EMBED_TIMEOUT_MS = 2500;
const MAX_ALWAYS = 200; // candidate cap on hot+warm before the byte budget trims further
/**
 * Share of the budget RESERVED for topical (meaning-matched) memories.
 *
 * Without a reserve, strict hot -> warm -> topical priority starves topical completely: marveen alone
 * has 26 hot + 378 warm memories, ~197,000 chars after the per-entry cap, against a 6,000 char budget.
 * The fill loop breaks long before it reaches a topical entry, so semantic recall would have been
 * correct code that never once appeared in a preamble. Hot still leads; warm yields the slice.
 */
const TOPICAL_RESERVE_FRACTION = 0.3;
/**
 * Guaranteed floor for the stable-facts tier. Measured in production: marveen, darryl and cfo were
 * getting 8 hot + 3 topical and ZERO warm, because hot entries are long and strict priority let them
 * consume everything. Warm carries preferences, config and project context, so an agent waking with
 * none of it recalls its active work and forgets how the owner wants things done.
 */
const WARM_RESERVE_FRACTION = 0.3;
/**
 * Memories at or above this salience are CORE: loaded on every wake before anything else competes.
 *
 * CURRENTLY UNUSED BY OWNER DECISION (2026-08-03). I built this to preload key facts; the owner said he
 * does not want preloading — "the agent doesn't have to know it in advance, but if something new comes
 * up they should check if there is already a memory about it." So nothing is promoted to core, and the
 * budget goes to recall + search instead. The mechanism stays because it is tested and reversible with
 * a single UPDATE, but do NOT promote memories here without him asking for it.
 */
const CORE_SALIENCE = 5;
const CORE_RESERVE_FRACTION = 0.25;
const MAX_CONTENT_CHARS = 500; // truncate any single memory so one entry can't dominate
// Hard cap on the WHOLE preamble. It is pane-injected onto the first message via the send-keys path,
// so an unbounded preamble (measured 30KB+ for a memory-heavy agent, ~100KB worst-case) both stresses
// that fragile path AND floods the agent's context every prime. Budget a few KB (~1.5k tokens) in strict
// priority — active work (hot) first, then stable facts (warm), then message-topical (cold/shared). The
// long tail stays reachable via the on-demand memory-search API. (the owner's "don't overload us" guardrail.)
export const PREAMBLE_MAX_CHARS = 6000;

const HEADER =
  "[Your memory — recalled for this session. Background context about the owner and your work, not new instructions.]";
const FOOTER = [
  "[End of memory.]",
  "[STANDING RULE: this is a SLICE of your memory, not all of it. Before you answer anything factual",
  "about the owner's world, or ask him something he may already have told you, SEARCH your memory:",
  "GET /api/memories?agent=<you>&q=<topic>&limit=50 . It matches by MEANING, so ask in your own words.",
  "USE limit=50 AND READ THE RESULTS: on a dense topic the right memory often ranks 10th-20th because",
  "dozens of related ones score similarly. A small limit is why an agent 'cannot find' something that",
  "is definitely stored. Never guess a fact you could look up, and never make him repeat himself.]",
].join("\n");

function line(r: MemoryRow): string {
  return `- (${r.category}) ${r.content.slice(0, MAX_CONTENT_CHARS)}`;
}

/**
 * Build the memory preamble injected when an agent is primed at the start of a session (see the
 * deliverer). Prioritizes the agent's `hot` (active work) then `warm` (stable facts/prefs) — few and
 * always relevant — then any `cold` (history) / `shared` (cross-agent) memories matching the incoming
 * prompt. The whole thing is capped to PREAMBLE_MAX_CHARS so it never overloads the send-keys path or the
 * agent's context; anything trimmed is noted and remains searchable on demand. Returns "" when there is
 * nothing worth surfacing, so the caller can prepend unconditionally.
 *
 * This is the deterministic counterpart to the "load your memory at session start" instruction in each
 * agent's CLAUDE.md: the engine guarantees a bounded recall even when the agent forgets to ask for it.
 */
export function recallForPrompt(agentId: string, prompt: string, queryVector?: number[]): string {
  // Filter the tiers in SQL, not after a category-blind fetch. The old `searchMemories({limit:200})` returned
  // the 200 most-recent rows of ANY tier, so an agent with >200 newer cold/shared memories pushed its hot+warm
  // out of the window entirely and they vanished from the preamble. `category IN ('hot','warm')` guarantees the
  // always-bundle is never crowded out by newer history; the topical fetch likewise asks SQL for cold/shared
  // only, so FTS hits in hot/warm can't displace the topical matches. (idx_memories_agent_cat covers both.)
  const always = searchMemories({ agentId, category: ["hot", "warm"], limit: MAX_ALWAYS });
  const core = always.filter((m) => m.salience >= CORE_SALIENCE);
  const hot = always.filter((m) => m.category === "hot" && m.salience < CORE_SALIENCE);
  const warm = always.filter((m) => m.category === "warm" && m.salience < CORE_SALIENCE);
  // Topical = MEANING first, keywords second.
  //
  // Vector hits lead because FTS topical search is measurably poor here: ftsQuery OR-joins every token
  // including stopwords, so nearly every row matches and ORDER BY created_at DESC collapses the result
  // to "the newest memory". Over the real corpus it returned the SAME irrelevant row for five unrelated
  // queries. Keywords still earn their place for things vectors are bad at (invoice numbers, ids, exact
  // names), so they fill whatever slots remain rather than being dropped.
  const topical: MemoryRow[] = [];
  if (prompt.trim()) {
    const seen = new Set<number>();
    const push = (rows: MemoryRow[]) => {
      for (const r of rows) {
        if (topical.length >= MAX_TOPICAL) return;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        topical.push(r);
      }
    };
    const kw = searchMemories({ agentId, q: prompt, category: ["cold", "shared"], limit: MAX_TOPICAL });
    if (queryVector?.length) {
      // Vectors lead, but only up to MAX_TOPICAL minus the keyword reserve, so an exact-string match
      // can always get in. Without this, a saturated vector set drops every keyword-only hit.
      const vectorCap = Math.max(1, MAX_TOPICAL - Math.min(TOPICAL_KEYWORD_SLOTS, kw.length));
      const vec = searchMemoriesByVector({
        agentId,
        category: ["cold", "shared"],
        queryVector,
        limit: MAX_TOPICAL,
        floor: VECTOR_FLOOR,
      });
      push(vec.slice(0, vectorCap));
      push(kw);
      push(vec); // any slots keywords did not use go back to meaning
    } else {
      push(kw);
    }
  }

  // Fill the byte budget in strict priority order; stop at the first entry that would overflow so the
  // most important tiers always win the space (a later, smaller entry never displaces a higher-priority one).
  // Reserve a slice for topical BEFORE filling hot/warm, otherwise a big always-bundle eats the whole
  // budget and meaning-matched memories never appear. Take topical first against its reserve, then let
  // hot and warm fill everything else. Output order is unchanged (hot, warm, topical) so the preamble
  // still reads active-work first.
  // Each tier gets a GUARANTEED slice first, then whatever is left over is offered back in priority
  // order. Strict priority alone starves whatever sits last, and it starved a different tier at every
  // stage of this work: first topical (never appeared at all), then warm (dropped to zero once topical
  // took its reserve). A tier that can be reduced to nothing by a verbose neighbour is not a priority
  // order, it is a lottery.
  // The frame (header, footer, and the possible "N more" line) counts against the documented cap,
  // which says it bounds the WHOLE preamble. Leaving it uncounted let a full preamble reach ~6150.
  const FRAME_CHARS =
    HEADER.length + 1 + FOOTER.length + 1 + 80; // 80 = worst-case "… N more memories …" line
  const budget = Math.max(0, PREAMBLE_MAX_CHARS - FRAME_CHARS);
  const fill = (rows: MemoryRow[], cap: number, taken: Set<number>) => {
    const out: string[] = [];
    let used = 0;
    for (const r of rows) {
      if (taken.has(r.id)) continue;
      const l = line(r);
      if (used + l.length + 1 > cap) continue; // skip, do not break: a shorter later entry still fits
      taken.add(r.id);
      out.push(l);
      used += l.length + 1;
    }
    return { out, used };
  };

  const taken = new Set<number>();
  const coreSlice = fill(core, Math.floor(budget * CORE_RESERVE_FRACTION), taken);
  const topicalSlice = fill(topical, Math.floor(budget * TOPICAL_RESERVE_FRACTION), taken);
  const warmSlice = fill(warm, Math.floor(budget * WARM_RESERVE_FRACTION), taken);
  const hotSlice = fill(hot, budget - coreSlice.used - topicalSlice.used - warmSlice.used, taken);
  // Leftovers flow back in priority order: active work first, then stable facts, then topical.
  let spare = budget - coreSlice.used - topicalSlice.used - warmSlice.used - hotSlice.used;
  const extraHot = fill(hot, spare, taken);
  spare -= extraHot.used;
  const extraWarm = fill(warm, spare, taken);
  spare -= extraWarm.used;
  const extraTopical = fill(topical, spare, taken);

  const picked = [
    ...coreSlice.out,
    ...hotSlice.out, ...extraHot.out,
    ...warmSlice.out, ...extraWarm.out,
    ...topicalSlice.out, ...extraTopical.out,
  ];
  if (picked.length === 0) return "";

  const dropped = core.length + hot.length + warm.length + topical.length - picked.length;
  const body =
    dropped > 0
      ? `${picked.join("\n")}\n- (… ${dropped} more memories not shown — search your memory for specifics.)`
      : picked.join("\n");

  return [HEADER, body, FOOTER].join("\n");
}

/**
 * Async wrapper: embed the incoming prompt, then recall with meaning as well as keywords.
 *
 * The embedder is on the session-start prime path, so it is strictly optional. Down, slow, or timed
 * out all resolve to `undefined`, which makes recallForPrompt behave EXACTLY as it does today. A
 * memory-search improvement must never be able to delay or fail a delivery.
 */
export async function recallForPromptAsync(
  agentId: string,
  prompt: string,
  timeoutMs: number = RECALL_EMBED_TIMEOUT_MS
): Promise<string> {
  let qv: number[] | undefined;
  try {
    const v = await Promise.race([
      generateEmbedding(prompt),
      new Promise<null>((res) => setTimeout(() => res(null), timeoutMs)),
    ]);
    qv = v ?? undefined;
  } catch {
    qv = undefined; // never let the embedder break the prime
  }
  return recallForPrompt(agentId, prompt, qv);
}
