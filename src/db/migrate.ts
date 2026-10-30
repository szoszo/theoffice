import type { DB } from "./index.js";
import { log } from "../logger.js";

const logger = log("db-migrate");

export interface Migration {
  /** strictly ascending, > BASELINE_VERSION (the SCHEMA_SQL baseline is version 1) */
  version: number;
  name: string;
  /** one or more SQL statements; ALTER/CREATE that SCHEMA_SQL's "IF NOT EXISTS" cannot express on an existing DB */
  sql: string;
}

/**
 * The schema that `SCHEMA_SQL` produces == version 1. Any DB at user_version 0 (fresh install, or any DB
 * predating this runner) is ADOPTED at this baseline without running migration DDL: every historical schema
 * change in this repo was an additive `CREATE ... IF NOT EXISTS`, so SCHEMA_SQL already brings both a fresh
 * and a pre-system DB fully to v1. See src/db/MIGRATIONS.md.
 */
export const BASELINE_VERSION = 1;

/**
 * Ordered, forward-only migrations applied AFTER SCHEMA_SQL. EMPTY today — this PR installs the mechanism;
 * no schema change is being made.
 *
 * IMPORTANT (Model A): SCHEMA_SQL is FROZEN at the v1 baseline. EVERY post-v1 change — new columns AND new
 * tables — goes ONLY here as { version, name, sql } (version strictly ascending from 2). Do NOT also edit
 * SCHEMA_SQL: on a fresh install SCHEMA_SQL(v1) -> adopt v1 -> these migrations run, so a column added in
 * BOTH places would hit "duplicate column" when the migration re-adds what SCHEMA_SQL already created and
 * crash the fresh install. Frozen baseline + migrations-only = a fresh DB and an existing DB take the exact
 * same path (adopt v1, then run v2+). New tables use plain CREATE TABLE in a migration (not IF NOT EXISTS,
 * so a genuine collision is loud).
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: "scheduler_state",
    // Persisted scheduler bookkeeping (k/v). Holds 'last_tick' so boot catch-up knows the window of
    // occurrences missed while the engine was down. New table -> migration-only (NOT in SCHEMA_SQL, Model A).
    sql: `CREATE TABLE scheduler_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL);`,
  },
  {
    version: 3,
    name: "inbound_queue orphan tracking",
    // Orphan-requeue (kanban aba29f60). A message handed to a session that then DIES is currently lost
    // forever: 'delivered' is terminal on this table, so nothing can tell "the agent read it" from "the
    // agent was OOM-killed three seconds later". The result is a user message sitting unanswered against a
    // system that considers it handled.
    //
    // session_ref: WHICH session instance received it (tmux #{session_created}). Identity, not doneness —
    //   doneness does not exist here. NULL on every pre-existing row, which is also the gate that keeps
    //   the 2,084 historical orphans out of scope: no ref, no requeue, ever.
    // requeues: PERSISTED redelivery counter enforcing the hard cap of one. Persisted rather than
    //   in-memory precisely so an engine restart cannot silently reset it and reopen the loop — an
    //   in-memory cap would have been a fresh silent-failure inside the fix for one.
    sql: `ALTER TABLE inbound_queue ADD COLUMN session_ref TEXT;
          ALTER TABLE inbound_queue ADD COLUMN requeues INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 4,
    name: "kanban evidence-before-done",
    // Issue #21 §1. A card could reach 'done' on an agent's word alone, and "reports success on work
    // that silently did not land" is the most common agent failure there is. The column holds what
    // was actually run and what came back, so the claim survives the request and can be read later.
    // Nullable and unenforced at the DB level on purpose: every historical card predates the rule,
    // and rewriting history to satisfy a new guard would be inventing evidence that never existed.
    sql: `ALTER TABLE kanban_cards ADD COLUMN verification TEXT;`,
  },
  {
    version: 5,
    name: "outbound_queue sending-claim state",
    // Double-post fix. The sender selected `WHERE status='queued'` with no claim, so a postMessage
    // slower than the 1.5s tick let the next tick re-select the still-'queued' row and post it a
    // SECOND time (one DB row, two Slack messages — invisible at the queue layer). The fix claims a
    // row atomically (queued -> 'sending') before posting, so only one drain proceeds. That needs
    // 'sending' in the status CHECK, and SQLite cannot ALTER a CHECK constraint — so rebuild the
    // table. No FK references outbound_queue, and this runs inside the migration transaction. Any row
    // caught mid-'sending' at boot is recovered by reapStaleOutboundSending() (requeued, never dropped).
    sql: `CREATE TABLE outbound_queue_v5 (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             agent_id   TEXT NOT NULL,
             channel    TEXT NOT NULL,
             text       TEXT NOT NULL,
             status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
             attempts   INTEGER NOT NULL DEFAULT 0,
             last_error TEXT,
             created_at INTEGER NOT NULL DEFAULT (unixepoch()),
             sent_at    INTEGER
           );
           INSERT INTO outbound_queue_v5 (id, agent_id, channel, text, status, attempts, last_error, created_at, sent_at)
             SELECT id, agent_id, channel, text, status, attempts, last_error, created_at, sent_at FROM outbound_queue;
           DROP TABLE outbound_queue;
           ALTER TABLE outbound_queue_v5 RENAME TO outbound_queue;
           CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_queue(status);`,
  },
  {
    version: 6,
    name: "inbound_queue owner-alarm dedup",
    // The owner-delivery watchdog (2026-08-04) alarms the owner when a source='channel' message is dropped
    // (status=failed) OR sits queued+undelivered past a threshold — the queued case being the one the
    // 2026-08-04 outage actually hit (messages parked behind a modal, never attempted, never failed).
    // owner_alarmed_at records the last time we alarmed about a row so the watchdog fires once per drop
    // and only re-alarms a still-stuck queued row on a slow cadence, instead of paging every tick.
    sql: `ALTER TABLE inbound_queue ADD COLUMN owner_alarmed_at INTEGER;`,
  },
  {
    version: 7,
    name: "briefing_board",
    // The morning-briefing collection store (design artifact 86ec0cfc). One row per non-private venture
    // SECTION that the fleet pre-writes into, so composition reads a complete/fresh board instead of racing
    // agents on the bus — completeness becomes a data property. section_key is the PRIMARY KEY: each agent
    // UPSERTs only its own section. as_of is the SOURCE-READ time (provenance, agent-supplied) so a re-post
    // of stale data reads stale; updated_at is the server write time. status lets an agent report it could
    // not gather (skipped/error), which the compose gate surfaces instead of silently dropping the section.
    // HEALTH is EXCLUDED BY CONSTRUCTION: 'health' is not a valid section_key and the endpoint rejects any
    // key outside the whitelist + denies health-keyword content — health stays on marveen's private path.
    sql: `CREATE TABLE briefing_board (
            section_key TEXT PRIMARY KEY,
            agent       TEXT NOT NULL,
            content     TEXT NOT NULL,
            as_of       INTEGER NOT NULL,
            max_age_sec INTEGER,
            status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','stale','skipped','error')),
            updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
          );`,
  },
  {
    version: 8,
    name: "owner_cards",
    // Owner Board v1.1 (owner board spec v1.1). A board only
    // the owner uses: agents post short cards, he answers via a comment thread and picks a tray (now/batch)
    // per answer. New tables -> migration-only (Model A), never SCHEMA_SQL. Separate from kanban_cards by
    // design (hard constraint in the spec): no FK, no shared endpoints, the migration below only READS it.
    sql: `CREATE TABLE owner_cards (
            id           TEXT PRIMARY KEY,
            kind         TEXT NOT NULL CHECK (kind IN ('question','task','project','fyi')),
            agent        TEXT NOT NULL,
            project      TEXT,
            title        TEXT NOT NULL,
            body         TEXT,
            options      TEXT,
            status       TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','answered','sent','closed','dropped')),
            closed_via   TEXT CHECK (closed_via IN ('board','slack','agent','kanban')),
            source_kanban_id TEXT UNIQUE,
            created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
          );
          CREATE INDEX idx_owner_cards_status ON owner_cards(status);
          CREATE TABLE owner_card_comments (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id     TEXT NOT NULL REFERENCES owner_cards(id),
            author      TEXT NOT NULL,
            text        TEXT NOT NULL,
            tray        TEXT CHECK (tray IN ('now','batch')),
            sent_at     INTEGER,
            created_at  INTEGER NOT NULL DEFAULT (unixepoch())
          );
          CREATE INDEX idx_occ_card ON owner_card_comments(card_id);
          CREATE INDEX idx_occ_unsent ON owner_card_comments(tray, sent_at);`,
  },
  {
    version: 9,
    name: "task_runs completion bookkeeping",
    // task_runs only recorded that a scheduled task was FIRED, so a run that was delivered and a run that was
    // finished looked identical for ever. completed_at/outcome are written by the agent through
    // POST /api/task-runs/:id/complete; inbound_id links the run to its queue row; expects_completion marks runs
    // whose prompt carried the completion instruction (0 for every pre-migration row and for heartbeats, so
    // history never raises an alarm); fired_at is the REAL fire time (ts is the occurrence time, hours old for a
    // catch-up run, so ageing from ts would alarm a freshly fired catch-up run immediately); alarmed_at/delivery are written by the unfinished-run sweep, once per run.
    // Additive, so every existing query and old row stays valid. Migration-only (Model A), never SCHEMA_SQL.
    sql: `ALTER TABLE task_runs ADD COLUMN completed_at INTEGER;
          ALTER TABLE task_runs ADD COLUMN outcome TEXT;
          ALTER TABLE task_runs ADD COLUMN delivery TEXT;
          ALTER TABLE task_runs ADD COLUMN inbound_id INTEGER;
          ALTER TABLE task_runs ADD COLUMN alarmed_at INTEGER;
          ALTER TABLE task_runs ADD COLUMN expects_completion INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE task_runs ADD COLUMN fired_at INTEGER;
          CREATE INDEX idx_task_runs_open ON task_runs(completed_at, ts);`,
  },
  {
    version: 10,
    name: "kanban audit events",
    // Who moved / changed a card, written in the same transaction as the change (src/web/kanban-audit.ts).
    // kanban_card_events: one row per real status transition (from_status NULL = creation). kanban_card_field_events:
    // one row per real change of an audited field (priority, project). Separate tables on purpose: a reader of status
    // transitions must never read a field change as one. New tables -> migration-only (Model A), never SCHEMA_SQL.
    sql: `CREATE TABLE kanban_card_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id     TEXT NOT NULL,
            from_status TEXT,
            to_status   TEXT NOT NULL,
            actor       TEXT,
            created_at  INTEGER NOT NULL DEFAULT (unixepoch())
          );
          CREATE INDEX idx_kanban_events_card ON kanban_card_events(card_id, created_at);
          CREATE TABLE kanban_card_field_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id     TEXT NOT NULL,
            field       TEXT NOT NULL,
            old_value   TEXT,
            new_value   TEXT,
            actor       TEXT,
            created_at  INTEGER NOT NULL DEFAULT (unixepoch())
          );
          CREATE INDEX idx_kanban_field_events_card ON kanban_card_field_events(card_id, created_at);`,
  },
  {
    version: 11,
    name: "exec-runtime usage + conversation continuity",
    // codex/gemini run one CLI subprocess per prompt: thinking_tokens extends token_usage (already used for
    // per-turn rows) and runtime_sessions remembers the conversation id so the next turn resumes it instead of
    // starting blank. One row per agent; last_context_tokens drives the roll-over and the estimated fill %.
    // Migration-only (Model A), never SCHEMA_SQL.
    sql: `ALTER TABLE token_usage ADD COLUMN thinking_tokens INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE runtime_sessions (
            agent_id            TEXT PRIMARY KEY,
            runtime             TEXT NOT NULL,
            session_id          TEXT NOT NULL,
            turns               INTEGER NOT NULL DEFAULT 0,
            last_context_tokens INTEGER NOT NULL DEFAULT 0,
            updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
          );`,
  },
  {
    version: 12,
    name: "runtime_sessions.context_window",
    // The model's own context window as reported by the CLI (0 = unknown, the per-runtime constant is used).
    // Migration-only (Model A).
    sql: `ALTER TABLE runtime_sessions ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0;`,
  },
];

/** Highest known schema version (the baseline, or the max migration version). */
export function schemaVersion(migrations: Migration[] = MIGRATIONS): number {
  return migrations.reduce((mx, m) => Math.max(mx, m.version), BASELINE_VERSION);
}

/** Validate the list ONCE, loudly — a bad list is a programmer error, caught before it touches a DB. */
export function assertMigrationsValid(migrations: Migration[]): void {
  let prev = BASELINE_VERSION;
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version)) throw new Error(`migration "${m.name}" version must be an integer`);
    if (m.version <= BASELINE_VERSION) throw new Error(`migration "${m.name}" version ${m.version} must be > baseline ${BASELINE_VERSION}`);
    if (seen.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    if (m.version < prev) throw new Error(`migrations not in ascending order at version ${m.version}`);
    seen.add(m.version);
    prev = m.version;
  }
}

/**
 * Apply pending migrations and return the resulting user_version. Each migration runs in its OWN
 * transaction that execs the SQL AND bumps user_version together — so a throwing step rolls back both
 * (DB unchanged, version not advanced past the failure). Idempotent: already-applied versions are skipped,
 * so a re-run (or a resumed run after a mid-way failure) does the right thing.
 */
export function runMigrations(db: DB, migrations: Migration[] = MIGRATIONS): number {
  assertMigrationsValid(migrations);
  let current = Number(db.pragma("user_version", { simple: true }));

  if (current === 0) {
    // adopt fresh/pre-system DB at the baseline (SCHEMA_SQL already produced it) — run no migration DDL
    db.pragma(`user_version = ${BASELINE_VERSION}`);
    current = BASELINE_VERSION;
    logger.info({ baseline: BASELINE_VERSION }, "db adopted at baseline schema version");
  }

  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`); // bumped INSIDE the tx -> rolls back with the DDL on throw
    });
    try {
      apply();
    } catch (err) {
      logger.error({ version: m.version, name: m.name, err }, "migration failed -> rolled back (DB unchanged, user_version not advanced)");
      throw new Error(`db migration ${m.version} (${m.name}) failed: ${String((err as Error).message ?? err)}`, { cause: err });
    }
    current = m.version;
    logger.warn({ version: m.version, name: m.name }, "applied db migration");
  }
  return current;
}
