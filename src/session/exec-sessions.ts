import { getDb } from "../db/index.js";
import { log } from "../logger.js";

/**
 * Shared bookkeeping for the exec-style runtimes (codex, gemini): per-turn token usage and conversation
 * continuity. Each prompt is one CLI subprocess, so without this every prompt is a brand new conversation
 * and the tokens it burned are invisible.
 *
 * Everything here is best-effort and never throws: a DB hiccup must not fail a delivered turn (the turn
 * already ran), and unit tests that mock the queue run without a database.
 */
const logger = log("exec-sessions");

/** Approximate context windows (tokens), used only for the dashboard's ESTIMATED fill % and the roll-over. */
export const CONTEXT_WINDOW: Record<string, number> = {
  codex: 272_000, // `codex debug models`: context_window for the gpt-5.x family
  gemini: 256_000, // what agy itself reports for gemini-3.8-flash (its context meter's denominator)
};
/**
 * When the real context size could not be read (null reading), roll over by turn count instead: blind
 * continuity forever would eventually overflow the window. Deliberately conservative.
 */
export const UNKNOWN_CONTEXT_MAX_TURNS = 20;
/** Start a fresh conversation once the last turn's context fill passes this share of the window. */
export const ROLLOVER_FRACTION = 0.7;

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  thinking: number;
}

export interface StoredSession {
  sessionId: string;
  turns: number;
  /** size of the context after the last turn (prompt of the last model call); 0 = could not be measured */
  lastContextTokens: number;
  /** the CLI-reported window; 0 = use CONTEXT_WINDOW */
  contextWindow: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** gemini (`agy --output-format json`): usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens}. */
export function usageFromGemini(u: any): TurnUsage | null {
  if (!u || typeof u !== "object") return null;
  return { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_tokens), thinking: num(u.thinking_tokens) };
}

/**
 * codex (`codex exec --json` turn.completed): usage {input_tokens, cached_input_tokens, output_tokens,
 * reasoning_output_tokens}. codex counts cached tokens INSIDE input_tokens, so split them out to keep
 * `input` meaning "uncached input" across runtimes.
 */
export function usageFromCodex(u: any): TurnUsage | null {
  if (!u || typeof u !== "object") return null;
  const cached = num(u.cached_input_tokens);
  const input = Math.max(0, num(u.input_tokens) - cached);
  return { input, output: num(u.output_tokens), cacheRead: cached, thinking: num(u.reasoning_output_tokens) };
}


export function recordUsage(agentId: string, sessionId: string | null, u: TurnUsage): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(agentId, sessionId, Date.now(), u.input, u.output, u.cacheRead, u.thinking);
  } catch (err) {
    logger.warn({ agent: agentId, err: String((err as Error).message ?? err) }, "usage not recorded");
  }
}

export function getSession(agentId: string, runtime: string): StoredSession | null {
  try {
    const r = getDb()
      .prepare(`SELECT session_id, turns, last_context_tokens, context_window FROM runtime_sessions WHERE agent_id = ? AND runtime = ?`)
      .get(agentId, runtime) as { session_id: string; turns: number; last_context_tokens: number; context_window: number } | undefined;
    return r ? { sessionId: r.session_id, turns: r.turns, lastContextTokens: r.last_context_tokens, contextWindow: r.context_window } : null;
  } catch {
    return null;
  }
}

export function saveSession(agentId: string, runtime: string, sessionId: string, contextTokens: number, contextWindow = 0): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO runtime_sessions (agent_id, runtime, session_id, turns, last_context_tokens, context_window, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, unixepoch())
         ON CONFLICT(agent_id) DO UPDATE SET
           turns = CASE WHEN runtime_sessions.session_id = excluded.session_id AND runtime_sessions.runtime = excluded.runtime
                        THEN runtime_sessions.turns + 1 ELSE 1 END,
           runtime = excluded.runtime, session_id = excluded.session_id,
           last_context_tokens = excluded.last_context_tokens, context_window = excluded.context_window,
           updated_at = unixepoch()`,
      )
      .run(agentId, runtime, sessionId, contextTokens, contextWindow);
  } catch (err) {
    logger.warn({ agent: agentId, err: String((err as Error).message ?? err) }, "session not saved");
  }
}

/** Forget the stored conversation: the next turn starts a new one. Returns true if a row existed. */
export function clearSession(agentId: string): boolean {
  try {
    return getDb().prepare(`DELETE FROM runtime_sessions WHERE agent_id = ?`).run(agentId).changes > 0;
  } catch {
    return false;
  }
}

/**
 * Which conversation to resume for this turn: the stored id, unless it belongs to another runtime
 * (the agent was flipped) or the context already passed the roll-over share of the window.
 */
export function sessionToResume(agentId: string, runtime: string): string | null {
  const s = getSession(agentId, runtime);
  if (!s) return null;
  const win = s.contextWindow || CONTEXT_WINDOW[runtime];
  if (s.lastContextTokens > 0 && win && s.lastContextTokens > win * ROLLOVER_FRACTION) {
    logger.info({ agent: agentId, runtime, ctx: s.lastContextTokens, win }, "context past roll-over -> starting a new conversation");
    clearSession(agentId);
    return null;
  }
  if (s.lastContextTokens <= 0 && s.turns >= UNKNOWN_CONTEXT_MAX_TURNS) {
    logger.info({ agent: agentId, runtime, turns: s.turns }, "context size unknown and many turns -> starting a new conversation");
    clearSession(agentId);
    return null;
  }
  return s.sessionId;
}

/** Estimated context fill % for the dashboard (null when the agent has no stored conversation). */
export function estimatedContextPct(agentId: string, runtime: string): number | null {
  const s = getSession(agentId, runtime);
  const win = s?.contextWindow || CONTEXT_WINDOW[runtime];
  if (!s || !win || s.lastContextTokens <= 0) return null; // not measured -> "n/a", never a made-up figure
  return Math.min(100, Math.round((s.lastContextTokens / win) * 100));
}

/**
 * A DETERMINISTIC configuration failure (unknown/unsupported model, conflicting flags): retrying cannot help,
 * so the caller fails the item once instead of burning the whole attempt budget. This tells the main agent,
 * throttled to one alert per agent per 30 minutes so a backlog of queued prompts does not flood the bus.
 */
const CONFIG_ALERT_GAP_MS = 30 * 60_000;
const lastConfigAlert = new Map<string, number>();
export function alertConfigFailure(mainAgentId: string, agentId: string, runtime: string, itemId: number, detail: string): void {
  const nowMs = Date.now();
  if (nowMs - (lastConfigAlert.get(agentId) ?? 0) < CONFIG_ALERT_GAP_MS) return;
  lastConfigAlert.set(agentId, nowMs);
  try {
    // direct insert, same row sendAgentMessage writes: importing the bus here would close an import cycle
    // (bus -> agents -> runtime -> this module)
    getDb()
      .prepare(`INSERT INTO agent_messages (from_agent, to_agent, content) VALUES (?, ?, ?)`)
      .run(
      "engine",
      mainAgentId,
      `${runtime} agent "${agentId}" has a configuration error: queue item #${itemId} was failed WITHOUT retries (retrying cannot fix it). ` +
        `Detail: ${detail.slice(0, 300)}. Check the agent's model/effort in agent.json against the runtime's model list (GET /api/runtimes).`,
    );
  } catch (err) {
    logger.warn({ agent: agentId, err: String((err as Error).message ?? err) }, "config-error alert not sent");
  }
}

/** Error texts that mean "this invocation can never work" (as opposed to a transient/provider failure). */
export const CONFIG_ERROR_RE =
  /invalid model|unknown model|model .*(?:not found|does not exist|not supported)|not supported for model|conflicts with|invalid .*selection|unrecognized (?:option|argument)|unknown flag|flag provided but not defined|unexpected argument/i;
