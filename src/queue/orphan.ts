// Orphan-requeue decision logic (kanban aba29f60). PURE — no DB, no tmux — because every interesting
// case here is a safety case, and safety cases must be testable without a live fleet.
//
// The problem: a message marked `delivered` to a session that then dies is lost forever. `delivered` is
// terminal on inbound_queue, so the engine cannot distinguish "the agent read it" from "the agent was
// OOM-killed three seconds later". On 2026-08-01 an owner Slack message sat unanswered for 36 minutes
// against a system that considered it handled, and was only recovered because a human hand-fed it back.
//
// The predicate is NOT doneness (which does not exist on this table) but SESSION-INSTANCE IDENTITY:
// is the session that received this message still the session that is running now?
import type { SessionState } from "../session/tmux.js";

/** What to do with one delivered-but-possibly-orphaned row. */
export type OrphanDecision = "requeue" | "leave" | "park";

export interface OrphanRow {
  /** unix seconds the row was handed to a session */
  delivered_at: number | null;
  /** tmux session-instance id at delivery time; NULL on rows predating the migration */
  session_ref: string | null;
  /** how many times this row has ALREADY been auto-requeued */
  requeues: number;
}

export interface SessionSnapshot {
  state: SessionState;
  /** instance id of the session that is running NOW (null unless state === "present") */
  ref: string | null;
}

export interface OrphanOpts {
  /** unix seconds of the agent's most recent OUTBOUND activity, or null if it has never spoken */
  lastOutboundAt: number | null;
  now: number;
  /** never resurrect anything older than this (seconds) */
  maxAgeSec: number;
  /** hard cap on AUTOMATIC requeues per message */
  maxRequeues: number;
}

/**
 * Decide the fate of one delivered row. Order matters: every early return is a reason NOT to act, and
 * they are deliberately checked before the one branch that re-sends a message to a live fleet.
 *
 *   leave   — do nothing (the default; chosen whenever we are not certain)
 *   requeue — the receiving session is provably gone and the agent provably never worked past it
 *   park    — it qualifies, but the cap is spent: stop retrying and escalate to a human
 */
export function decideOrphan(row: OrphanRow, current: SessionSnapshot, opts: OrphanOpts): OrphanDecision {
  // 1. NEVER act on "we could not ask". A tmux call killed by TMUX_TIMEOUT_MS reports the same falsy
  //    answer as a genuinely dead session; treating that as death would re-deliver to an agent that is
  //    alive and mid-turn — the automated, fleet-wide version of a duplicate owner message.
  if (current.state === "unknown") return "leave";

  // 2. No ref means the row predates this mechanism. This is the gate that holds the 2,084 historical
  //    orphans (2026-05-26..2026-08-01) out of scope by construction rather than by a date literal
  //    someone could later "helpfully" widen.
  if (row.session_ref == null) return "leave";
  if (row.delivered_at == null) return "leave";

  // 3. The session that received it is still the session running now -> it is being worked on, or was
  //    already handled. Note this compares INSTANCE, not existence: after a relaunch the agent is
  //    "present" but is a DIFFERENT instance with none of the context, which is exactly the 9766 case.
  if (current.state === "present" && current.ref === row.session_ref) return "leave";

  // 4. Recency bound: a resurrection from days ago is noise at best and confusing at worst.
  if (opts.now - row.delivered_at > opts.maxAgeSec) return "leave";

  // 5. THE SAFETY GATE. If the agent produced output AFTER this was delivered, it was alive and working
  //    past it, so re-sending would duplicate something already handled. This is the same test used by
  //    hand on 2026-08-01 to prove 9766 was genuinely unanswered rather than mid-conversation: the
  //    agent's last outbound PREDATED the inbound by 12 minutes.
  if (opts.lastOutboundAt != null && opts.lastOutboundAt > row.delivered_at) return "leave";

  // 6. Hard cap, persisted. An agent killed BY a message and then re-fed that same message on relaunch
  //    is a self-reinforcing kill loop; the cap makes that structurally impossible rather than unlikely.
  if (row.requeues >= opts.maxRequeues) return "park";

  return "requeue";
}
