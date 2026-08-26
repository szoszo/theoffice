import { getDb } from "../db/index.js";

/**
 * The briefing board: a shared store the fleet pre-writes non-private venture sections into, so the
 * morning briefing is COMPOSED FROM a complete/fresh board rather than raced together on the bus.
 * Completeness is a data property — readBoard() reports which required sections are present and fresh,
 * so a missing/stale section is visible to the compose gate instead of silently dropped.
 *
 * HEALTH IS EXCLUDED BY CONSTRUCTION (the load-bearing privacy guarantee):
 *   1. section_key must be in SECTION_WHITELIST — there is no 'health' section, so health can't be a section.
 *   2. no free-text catch-all key is accepted.
 *   3. write-boundary health-keyword DENY — even inside a whitelisted section, content that reads like real
 *      health data is refused, so a stray BP reading can't ride the shared board.
 * Health is composed separately by marveen from its private .health-sync path and joined after the read.
 */

/** The only section keys the shared board accepts. No 'health'. No catch-all. */
export const SECTION_WHITELIST = ["finance", "toggl", "car", "weather", "infra", "home"] as const;
export type SectionKey = (typeof SECTION_WHITELIST)[number];

/** Sections the morning briefing EXPECTS present — used by readBoard() to compute the completeness gate. */
export const EXPECTED_SECTIONS: readonly SectionKey[] = SECTION_WHITELIST;

export const STATUSES = ["ok", "stale", "skipped", "error"] as const;
export type SectionStatus = (typeof STATUSES)[number];

/**
 * Write-boundary health-keyword deny — defence-in-depth behind the whitelist (Toby canaries it).
 *
 * STEM-based, NOT \b-word-bounded at the end: Hungarian agglutinates (diagnózis, vérnyomásom, kórházban,
 * orvosi), so `\bdiagnóz\b` misses "diagnózis" — the exact gap Toby's canary found (2026-08-26, "orvosi
 * kontroll ... kórház" + "a diagnózis szerint" reached the shared board). So each health STEM matches any
 * suffixed form. Terms are UNAMBIGUOUSLY medical (HU+EN); deliberately excludes ambiguous stems like
 * "kezel"(=handle/manage), "recept"(=recipe), "kontroll"(=control) that would false-block venture content,
 * and the generic word "health" (so "battery health"/"healthy runway" pass). Widen as the canary finds gaps.
 */
const HEALTH_DENY_RX =
  /(?:blood\s*pressure|v[ée]rnyom|systol|diastol|szisztol|diasztol|mmhg|heart\s*rate|pulse|sz[íi]vritmus|medic|gy[óo]gyszer|orvos|doktor|k[óo]rh[áa]z|klinik|diagn|lelet|t[üu]net|\bbeteg|v[ée]rv[ée]tel|v[ée]rcukor|glucose|cholesterol|koleszterin|\d+\s*mg\b)/i;

export interface BoardRow {
  section_key: string;
  agent: string;
  content: string;
  as_of: number;
  max_age_sec: number | null;
  status: SectionStatus;
  updated_at: number;
}

export interface UpsertArgs {
  section_key: string;
  agent: string;
  content: string;
  /** SOURCE-READ time (unix seconds) — when the underlying data was actually gathered (provenance). */
  as_of: number;
  max_age_sec?: number;
  status?: SectionStatus;
}

export interface UpsertResult {
  ok: boolean;
  code?: number;
  error?: string;
}

/** Validate + UPSERT one section. Rejects a non-whitelisted key and health-keyword content (never writes them). */
export function upsertSection(a: UpsertArgs): UpsertResult {
  if (!(SECTION_WHITELIST as readonly string[]).includes(a.section_key)) {
    return { ok: false, code: 400, error: `section_key '${a.section_key}' is not on the board whitelist (${SECTION_WHITELIST.join("|")}); no free-text sections, and health is not a section` };
  }
  const status: SectionStatus = a.status && (STATUSES as readonly string[]).includes(a.status) ? a.status : "ok";
  // Health deny scans the CONTENT (defence-in-depth behind the whitelist). A 'skipped'/'error' row can carry
  // a short reason, so scan that too — the deny applies to whatever text lands on the shared board.
  if (HEALTH_DENY_RX.test(a.content)) {
    return { ok: false, code: 422, error: "content looks like health data — the briefing board is shared and never carries health; keep it on the private health path" };
  }
  getDb()
    .prepare(
      `INSERT INTO briefing_board (section_key, agent, content, as_of, max_age_sec, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(section_key) DO UPDATE SET
         agent=excluded.agent, content=excluded.content, as_of=excluded.as_of,
         max_age_sec=excluded.max_age_sec, status=excluded.status, updated_at=unixepoch()`
    )
    .run(a.section_key, a.agent, a.content, a.as_of, a.max_age_sec ?? null, status);
  return { ok: true };
}

export interface BoardSectionView extends BoardRow {
  age_sec: number;
  /** true when present, status ok, and within max_age_sec (or no max set). */
  fresh: boolean;
}

export interface BoardView {
  now: number;
  sections: BoardSectionView[];
  /** Expected sections that are absent entirely. */
  missing: string[];
  /** Present sections that are stale or reported a non-ok status. */
  stale: string[];
  /** true only when every EXPECTED section is present, ok, and fresh — the compose gate. */
  complete: boolean;
}

/**
 * Read the whole board with per-section freshness + a present-vs-EXPECTED diff, so the compose gate can
 * decide green/red from DATA. `nowSec` is injectable for tests.
 */
export function readBoard(nowSec: number = Math.floor(Date.now() / 1000)): BoardView {
  const rows = getDb()
    .prepare(`SELECT section_key, agent, content, as_of, max_age_sec, status, updated_at FROM briefing_board`)
    .all() as BoardRow[];
  const byKey = new Map(rows.map((r) => [r.section_key, r]));
  const sections: BoardSectionView[] = rows.map((r) => {
    const age = nowSec - r.as_of;
    const withinAge = r.max_age_sec == null || age <= r.max_age_sec;
    return { ...r, age_sec: age, fresh: r.status === "ok" && withinAge };
  });
  const missing = EXPECTED_SECTIONS.filter((k) => !byKey.has(k));
  const stale = sections.filter((s) => EXPECTED_SECTIONS.includes(s.section_key as SectionKey) && !s.fresh).map((s) => s.section_key);
  const complete = missing.length === 0 && stale.length === 0;
  return { now: nowSec, sections, missing, stale, complete };
}
