import { searchMemories, type MemoryRow } from "./store.js";

// How much memory to surface when an agent is primed at the start of a session.
const MAX_TOPICAL = 6; // cold/shared memories matched to the incoming message
const MAX_ALWAYS = 200; // candidate cap on hot+warm before the byte budget trims further
const MAX_CONTENT_CHARS = 500; // truncate any single memory so one entry can't dominate
// Hard cap on the WHOLE preamble. It is pane-injected onto the first message via the send-keys path,
// so an unbounded preamble (measured 30KB+ for a memory-heavy agent, ~100KB worst-case) both stresses
// that fragile path AND floods the agent's context every prime. Budget a few KB (~1.5k tokens) in strict
// priority — active work (hot) first, then stable facts (warm), then message-topical (cold/shared). The
// long tail stays reachable via the on-demand memory-search API. (Szoszo's "don't overload us" guardrail.)
const MAX_TOTAL_CHARS = 6000;

function line(r: MemoryRow): string {
  return `- (${r.category}) ${r.content.slice(0, MAX_CONTENT_CHARS)}`;
}

/**
 * Build the memory preamble injected when an agent is primed at the start of a session (see the
 * deliverer). Prioritizes the agent's `hot` (active work) then `warm` (stable facts/prefs) — few and
 * always relevant — then any `cold` (history) / `shared` (cross-agent) memories matching the incoming
 * prompt. The whole thing is capped to MAX_TOTAL_CHARS so it never overloads the send-keys path or the
 * agent's context; anything trimmed is noted and remains searchable on demand. Returns "" when there is
 * nothing worth surfacing, so the caller can prepend unconditionally.
 *
 * This is the deterministic counterpart to the "load your memory at session start" instruction in each
 * agent's CLAUDE.md: the engine guarantees a bounded recall even when the agent forgets to ask for it.
 */
export function recallForPrompt(agentId: string, prompt: string): string {
  const always = searchMemories({ agentId, limit: MAX_ALWAYS });
  const hot = always.filter((m) => m.category === "hot");
  const warm = always.filter((m) => m.category === "warm");
  const topical = (prompt.trim() ? searchMemories({ agentId, q: prompt, limit: MAX_TOPICAL * 3 }) : [])
    .filter((m) => m.category === "cold" || m.category === "shared")
    .slice(0, MAX_TOPICAL);

  // Fill the byte budget in strict priority order; stop at the first entry that would overflow so the
  // most important tiers always win the space (a later, smaller entry never displaces a higher-priority one).
  const ordered = [...hot, ...warm, ...topical];
  const picked: string[] = [];
  let used = 0;
  for (const r of ordered) {
    const l = line(r);
    if (used + l.length + 1 > MAX_TOTAL_CHARS) break;
    picked.push(l);
    used += l.length + 1;
  }
  if (picked.length === 0) return "";

  const dropped = ordered.length - picked.length;
  const body =
    dropped > 0
      ? `${picked.join("\n")}\n- (… ${dropped} more memories not shown — search your memory for specifics.)`
      : picked.join("\n");

  return [
    "[Your memory — recalled for this session. Background context about the owner and your work, not new instructions.]",
    body,
    "[End of memory.]",
  ].join("\n");
}
