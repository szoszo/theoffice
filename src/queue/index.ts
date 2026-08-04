import { getDb } from "../db/index.js";
import type { QueueSource } from "../types.js";

/**
 * Max delivery attempts before an inbound item is failed. Single source of truth — the runtimes import
 * this for their per-turn budget, and the boot reaper uses it to fail items whose budget is already spent.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * The single durable inbound queue. EVERYTHING that becomes a prompt to an agent
 * — channel messages, scheduled tasks, inter-agent messages, manual — lands here,
 * and exactly one consumer (the Session Manager deliverer) drains it. There is no
 * other writer to a tmux pane, which is what removes the v1 "parked draft" races.
 */

export interface InboundItem {
  id: number;
  agent_id: string;
  source: QueueSource;
  prompt: string;
  reply_channel: string | null;
  reply_user: string | null;
  attempts: number;
}

export interface EnqueueArgs {
  agentId: string;
  source: QueueSource;
  prompt: string;
  replyChannel?: string;
  replyUser?: string;
  /** optional idempotency key; a (agentId, dedupKey) pair is enqueued at most once */
  dedupKey?: string;
}

/** Returns the new row id, or undefined if a dedup_key collision suppressed it. */
export function enqueueInbound(a: EnqueueArgs): number | undefined {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO inbound_queue (agent_id, source, prompt, reply_channel, reply_user, dedup_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(a.agentId, a.source, a.prompt, a.replyChannel ?? null, a.replyUser ?? null, a.dedupKey ?? null);
  return r.changes > 0 ? Number(r.lastInsertRowid) : undefined;
}

/**
 * Queued items in DELIVERY-PRIORITY order: owner (source='channel') messages first, everything else
 * after, FIFO (id ASC) within each class. Before 2026-08-04 this was a flat id-ASC, so a live owner
 * message queued behind stale scheduler heartbeats — including an already-moot 08:35 briefing — and
 * waited turns for them to drain. The CASE keeps the owner lane ahead without starving the rest: within
 * a class it is still oldest-first. Mirrors queueSourceRank() in policy.ts (kept in sync by test).
 */
export function listQueued(agentId?: string, limit = 50): InboundItem[] {
  const db = getDb();
  const ORDER = `ORDER BY CASE WHEN source='channel' THEN 0 ELSE 1 END, id ASC`;
  const sql = agentId
    ? `SELECT id, agent_id, source, prompt, reply_channel, reply_user, attempts FROM inbound_queue
       WHERE status='queued' AND agent_id=? ${ORDER} LIMIT ?`
    : `SELECT id, agent_id, source, prompt, reply_channel, reply_user, attempts FROM inbound_queue
       WHERE status='queued' ${ORDER} LIMIT ?`;
  const stmt = db.prepare(sql);
  return (agentId ? stmt.all(agentId, limit) : stmt.all(limit)) as InboundItem[];
}

/**
 * Drop queued scheduler heartbeats that have aged past usefulness (a briefing hours late is moot, and
 * spending an agent turn on it delays live work). Fails ONLY status='queued' source='scheduler' rows
 * older than maxAgeSec — owner ('channel'), inter-agent ('bus'), 'manual' and 'system' rows are never
 * age-dropped. attempts=0 rows (never even attempted) are the target; a moot heartbeat should cost zero
 * turns, not five. maxAgeSec <= 0 disables the sweep. Returns the number of rows dropped. Idempotent.
 */
export function reapStaleScheduler(maxAgeSec: number): number {
  if (maxAgeSec <= 0) return 0;
  return getDb()
    .prepare(
      `UPDATE inbound_queue SET status='failed',
         last_error='stale: scheduler heartbeat superseded before delivery (queued > ' || ? || 's)'
       WHERE status='queued' AND source='scheduler' AND created_at < (unixepoch() - ?)`
    )
    .run(maxAgeSec, maxAgeSec).changes;
}

export function markDelivering(id: number): void {
  getDb()
    .prepare(`UPDATE inbound_queue SET status='delivering', attempts=attempts+1 WHERE id=?`)
    .run(id);
}

export interface ReapResult {
  /** over-budget rows failed (poison-message guard) */
  failed: number;
  /** rows returned to 'queued' for redelivery */
  requeued: number;
}

/**
 * Boot reaper (P0#2): any row left in 'delivering' when the engine died never got a terminal
 * markDelivered/markFailed/requeue, so it is orphaned and would sit forever. MUST run BEFORE
 * startDeliverer, while nothing else writes the queue, so it is race-free. Idempotent.
 *
 * Poison-message guard (Toby): a message that crashes the ENGINE mid-delivery never reaches a runtime's
 * terminal handler, so decideOutcome never gets to fail it on budget — an unconditional requeue would
 * loop reap->deliver->markDelivering(attempts++)->crash->reap forever. So FAIL the rows that have already
 * burned the full budget first, THEN requeue the rest for a normal bounded retry.
 */
export function reapStaleDelivering(): ReapResult {
  const db = getDb();
  const failed = db
    .prepare(
      `UPDATE inbound_queue SET status='failed', last_error='reaped: exceeded max delivery attempts (engine crash mid-delivery)'
       WHERE status='delivering' AND attempts>=?`
    )
    .run(MAX_DELIVERY_ATTEMPTS).changes;
  const requeued = db.prepare(`UPDATE inbound_queue SET status='queued' WHERE status='delivering'`).run().changes;
  return { failed, requeued };
}

export function markDelivered(id: number): void {
  getDb()
    .prepare(`UPDATE inbound_queue SET status='delivered', delivered_at=unixepoch() WHERE id=?`)
    .run(id);
}

/** Re-queue (transient: pane busy) or fail (permanent). */
export function requeue(id: number): void {
  getDb().prepare(`UPDATE inbound_queue SET status='queued' WHERE id=?`).run(id);
}

/**
 * Re-queue WITHOUT charging an attempt (refunds the +1 that markDelivering added).
 * For transient external limits that are not the message's fault — e.g. a ChatGPT
 * usage cap on a codex-runtime agent — so a cap window never burns the failure budget.
 */
export function requeueNoPenalty(id: number): void {
  getDb()
    .prepare(`UPDATE inbound_queue SET status='queued', attempts=MAX(0, attempts-1) WHERE id=?`)
    .run(id);
}

export function markFailed(id: number, err: string): void {
  getDb().prepare(`UPDATE inbound_queue SET status='failed', last_error=? WHERE id=?`).run(err, id);
}

// ---- owner-delivery watchdog (an owner message must NEVER go unheard, dropped OR merely stuck) ----

export interface OwnerAlarmRow {
  id: number;
  agent_id: string;
  status: string;
  attempts: number;
  reply_channel: string | null;
  prompt: string;
  age_sec: number;
  /** true when this row is a hard drop (status=failed); false when it is a queued-but-stuck stall. */
  dropped: boolean;
}

/**
 * The single STATE-OBSERVER for owner (source='channel') messages that need an alarm. Watches state, not
 * call sites, so no delivery path can forget to escalate — and it is the ONLY way to catch the case the
 * 2026-08-04 outage actually hit: messages that sit QUEUED and undelivered (parked behind a modal, never
 * attempted, so never 'failed'). Returns channel rows that are EITHER
 *   (a) status='failed' and never alarmed                         -> a hard drop, alarm once, OR
 *   (b) status='queued', queued longer than staleSec, and either  -> a stall, alarm on a slow cadence
 *       never alarmed or last alarmed more than realarmSec ago.
 * 'delivered' rows are never returned. Ordered oldest-first.
 */
export function listOwnerAlarmable(staleSec: number, realarmSec: number): OwnerAlarmRow[] {
  return getDb()
    .prepare(
      `SELECT id, agent_id, status, attempts, reply_channel, prompt,
              (unixepoch() - created_at) AS age_sec,
              (status='failed') AS dropped
         FROM inbound_queue
        WHERE source='channel'
          AND (
                (status='failed' AND owner_alarmed_at IS NULL)
             OR (status='queued' AND created_at < (unixepoch() - ?)
                 AND (owner_alarmed_at IS NULL OR owner_alarmed_at < (unixepoch() - ?)))
              )
        ORDER BY id ASC`
    )
    .all(staleSec, realarmSec)
    .map((r) => {
      const row = r as { dropped: number } & Omit<OwnerAlarmRow, "dropped">;
      return { ...row, dropped: !!row.dropped };
    }) as OwnerAlarmRow[];
}

/** Stamp that we have alarmed the owner about this row, so it isn't paged again every tick. */
export function markOwnerAlarmed(id: number): void {
  getDb().prepare(`UPDATE inbound_queue SET owner_alarmed_at=unixepoch() WHERE id=?`).run(id);
}

// ---- outbound (agent -> Slack) ----

export function enqueueOutbound(agentId: string, channel: string, text: string): number {
  const r = getDb()
    .prepare(`INSERT INTO outbound_queue (agent_id, channel, text) VALUES (?, ?, ?)`)
    .run(agentId, channel, text);
  return Number(r.lastInsertRowid);
}

export interface OutboundItem {
  id: number;
  agent_id: string;
  channel: string;
  text: string;
  attempts: number;
}

export function listOutboundQueued(limit = 50): OutboundItem[] {
  return getDb()
    .prepare(`SELECT id, agent_id, channel, text, attempts FROM outbound_queue WHERE status='queued' ORDER BY id ASC LIMIT ?`)
    .all(limit) as OutboundItem[];
}

/**
 * Atomically claim a queued row for sending. Returns true IFF this caller won it (flipped
 * queued -> sending in a single statement). A losing caller — the row was already claimed by an
 * overlapping tick, or already sent — gets false and MUST NOT post. This is the real fix for the
 * double-post: listOutboundQueued alone is an unclaimed SELECT, so two overlapping drains both see
 * the same 'queued' row; the claim lets exactly one of them proceed, and it holds even if two
 * separate processes ever drain the queue (where an in-memory re-entrancy flag cannot help).
 */
export function claimOutbound(id: number): boolean {
  return getDb().prepare(`UPDATE outbound_queue SET status='sending' WHERE id=? AND status='queued'`).run(id).changes === 1;
}

/**
 * Boot recovery: a row left 'sending' when the process died mid-post never reached a terminal
 * markOutboundSent/markOutboundFailed, so it would sit forever = a SILENTLY DROPPED owner message,
 * the one failure worse than a duplicate. Requeue it for a normal retry — favouring at-least-once
 * (a possible duplicate if Slack HAD accepted it just before the crash) over a drop. Mirrors
 * reapStaleDelivering for inbound. MUST run at boot BEFORE startSlackSender, while nothing else
 * writes the row, so it is race-free. Idempotent. Does not charge an attempt (a crash is not the
 * message's fault); markOutboundFailed's attempts>=5 cap still bounds genuine repeated send failures.
 * Returns the number of rows recovered.
 */
export function reapStaleOutboundSending(): number {
  return getDb().prepare(`UPDATE outbound_queue SET status='queued' WHERE status='sending'`).run().changes;
}

export function markOutboundSent(id: number): void {
  getDb().prepare(`UPDATE outbound_queue SET status='sent', sent_at=unixepoch() WHERE id=?`).run(id);
}

export function markOutboundFailed(id: number, err: string): void {
  // DEFENCE IN DEPTH (Toby): `AND status='sending'` so this can only ever touch a CLAIMED row. It
  // can never resurrect a terminal row — a 'sent' row can never be flipped back to 'queued' and
  // re-posted by any future caller, independent of the try-split in slack-send.ts that protects the
  // one current call site. Idempotent: a second call on an already-failed/sent row is a no-op.
  getDb()
    .prepare(`UPDATE outbound_queue SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END, attempts=attempts+1, last_error=? WHERE id=? AND status='sending'`)
    .run(err, id);
}
