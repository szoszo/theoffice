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
    // agent was OOM-killed three seconds later". Proven live 2026-08-01 — an owner message sat 36 minutes
    // against a system that considered it handled.
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
    // The owner-delivery watchdog (2026-08-04) alarms Szoszo when a source='channel' message is dropped
    // (status=failed) OR sits queued+undelivered past a threshold — the queued case being the one the
    // 2026-08-04 outage actually hit (messages parked behind a modal, never attempted, never failed).
    // owner_alarmed_at records the last time we alarmed about a row so the watchdog fires once per drop
    // and only re-alarms a still-stuck queued row on a slow cadence, instead of paging every tick.
    sql: `ALTER TABLE inbound_queue ADD COLUMN owner_alarmed_at INTEGER;`,
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
