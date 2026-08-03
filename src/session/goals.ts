import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";
import { recallForPromptAsync, PREAMBLE_MAX_CHARS } from "../memory/recall.js";

/**
 * The operator's goals layer (issue #21 §3). A tenant-level `tenant/GOALS.md` — a handful of
 * operator-owned lines describing what the operator is actually trying to achieve — surfaced to an
 * agent on the first message of a fresh session, above the recalled-memory preamble, so the agent
 * (and any grooming/brief pass) can prioritize "moves the needle" over "noise".
 *
 * Operator-owned + READ-ONLY (trusted content, not attacker-controlled, like the memory preamble). A
 * missing / empty / unreadable file yields "" (pure no-op).
 *
 * BUDGETED: the goals block and the memory preamble share ONE pane-injection budget (PREAMBLE_MAX_CHARS)
 * on the fragile send-keys path — goals must count WITHIN that cap, not on top of it. Memory recalls
 * first and keeps its budget; goals gets only the remaining space and truncates/yields to fit, so the
 * COMBINED preamble can never push the submit path over the cap (the PR#8 bounded-injection lesson).
 */
const GOALS_MAX_CHARS = 1200; // absolute cap on the goals block even when there's plenty of room
const HEADER = "OPERATOR GOALS (what the operator is trying to achieve — prioritize your work against these, not the bare priority label):";
const TRUNC = "\n… (truncated)";

/** The framed goals block, length guaranteed <= `budget` (and <= GOALS_MAX_CHARS). Empty when the file is
 *  absent/empty, or when `budget` leaves no room for a meaningful block (goals yields to memory). */
export function goalsForPrompt(cfg: EngineConfig, budget: number = GOALS_MAX_CHARS): string {
  try {
    const cap = Math.min(GOALS_MAX_CHARS, budget);
    if (cap < HEADER.length + 20) return ""; // not enough room for the header + real content -> yield entirely
    const path = join(cfg.paths.tenantRoot, "GOALS.md");
    if (!existsSync(path)) return "";
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return "";
    const block = `${HEADER}\n${raw}`;
    return block.length <= cap ? block : block.slice(0, cap - TRUNC.length).trimEnd() + TRUNC;
  } catch {
    return ""; // best-effort: a read error must never block delivery
  }
}

/**
 * Assemble the first-message prime preamble = operator goals (top, framing) + recalled memory, kept
 * within the single PREAMBLE_MAX_CHARS budget. Memory takes its full budget first (never starved); goals
 * fills only the remainder. Combined length is always <= PREAMBLE_MAX_CHARS.
 */
export async function firstMessagePreamble(cfg: EngineConfig, agentId: string, prompt: string): Promise<string> {
  // Async only because recall now embeds the prompt to search by meaning. That embed is bounded and
  // optional: down or slow degrades to the keyword-only preamble rather than delaying the delivery.
  const mem = await recallForPromptAsync(agentId, prompt); // already <= PREAMBLE_MAX_CHARS
  const sep = mem ? 2 : 0; // the "\n\n" that will join goals to mem
  const goalsBudget = Math.max(0, PREAMBLE_MAX_CHARS - mem.length - sep);
  const goals = goalsForPrompt(cfg, goalsBudget);
  return [goals, mem].filter(Boolean).join("\n\n");
}
