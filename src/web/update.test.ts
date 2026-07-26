import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import Database from "better-sqlite3";
import { openDb, closeDb, getDb } from "../db/index.js";
import { backupDb } from "./update.js";

/**
 * Phase A backup correctness (Toby non-negotiable): the pre-update backup must capture COMMITTED state,
 * including rows still in the WAL that a naive `cp theoffice.db` would miss. We commit rows, do NOT
 * checkpoint, then back up and restore-read them.
 */

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-backup-"));
  dbPath = join(dir, "theoffice.db");
  openDb(dbPath); // WAL mode
  // committed write that lives in the WAL (no checkpoint) — the case a raw file copy would lose
  getDb().prepare(`INSERT INTO memories (agent_id, category, content) VALUES (?, 'hot', ?)`).run("tester", "wal-resident row");
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("backupDb", () => {
  it("captures committed (WAL-resident) rows — the backup restores to a working DB with the data", () => {
    const path = backupDb();
    expect(existsSync(path)).toBe(true);
    // open the backup as a standalone DB and query the row that was only in the source's WAL
    const b = new Database(path, { readonly: true });
    const n = (b.prepare(`SELECT COUNT(*) c FROM memories WHERE content='wal-resident row'`).get() as { c: number }).c;
    const tables = (b.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table'`).get() as { c: number }).c;
    b.close();
    expect(n).toBe(1); // committed-WAL row IS in the backup (VACUUM INTO captured it)
    expect(tables).toBeGreaterThan(5); // full schema came across
  });

  it("produces a unique filename per call (no same-ms collision) and prunes to the last 5", () => {
    const names = new Set<string>();
    for (let i = 0; i < 7; i++) names.add(basename(backupDb())); // rapid succession (same-ms likely)
    expect(names.size).toBe(7); // all unique despite ms collisions
    const baks = readdirSync(dir).filter((f) => f.startsWith("theoffice.db.bak-"));
    expect(baks.length).toBeLessThanOrEqual(5); // pruned
  });
});

/**
 * The install step can't be exercised for real in a unit test (it pulls, installs and rebuilds the live
 * checkout), so guard the one flag whose absence silently breaks EVERY update on a normal deployment: the
 * engine runs under NODE_ENV=production, npm turns that into omit=dev, and `npm run build` then can't find
 * `tsc`. The update rolls itself back, so the symptom is "the button does nothing" rather than a crash.
 */
describe("applyUpdate install step", () => {
  it("installs devDependencies explicitly, so the build can find tsc under NODE_ENV=production", () => {
    const src = readFileSync(new URL("./update.ts", import.meta.url), "utf8");
    const ciStep = src.match(/step\("npm", \[([^\]]*)\]\)/)?.[1] ?? "";
    expect(ciStep).toContain("ci");
    expect(ciStep).toContain("--include=dev");
  });
});
