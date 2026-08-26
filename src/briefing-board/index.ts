import { getDb } from "../db/index.js";

/**
 * The briefing board: a shared store the fleet pre-writes non-private venture sections into, so the
 * morning briefing is COMPOSED FROM a complete/fresh board rather than raced together on the bus.
 * Completeness is a data property — readBoard() reports which required sections are present and fresh,
 * so a missing/stale section is visible to the compose gate instead of silently dropped.
 *
 * HEALTH IS EXCLUDED BY CONSTRUCTION (the load-bearing privacy guarantee):
 *   1. section_key must be in SECTION_WHITELIST — there is no 'health' section (the PRIMARY guard).
 *   2. no free-text catch-all key is accepted.
 *   3. write-boundary health-keyword DENY on content (defence-in-depth) — a stray health reading in a
 *      legit section is refused, so it can't ride the shared board.
 * Health is composed separately by marveen from its private .health-sync path and joined after the read.
 */

/** The only section keys the shared board accepts. No 'health'. No catch-all. */
export const SECTION_WHITELIST = ["finance", "toggl", "car", "weather", "infra", "home"] as const;
export type SectionKey = (typeof SECTION_WHITELIST)[number];

/** Sections the morning briefing EXPECTS present — used by readBoard() to compute the completeness gate. */
export const EXPECTED_SECTIONS: readonly SectionKey[] = SECTION_WHITELIST;

export const STATUSES = ["ok", "stale", "skipped", "error"] as const;
export type SectionStatus = (typeof STATUSES)[number];

/** A section with no max_age is NOT immortal (Toby M2): freshness can't be disabled by omission. 6h default. */
export const DEFAULT_MAX_AGE_SEC = 6 * 3600;
/** as_of more than this into the future is a clock-skew/bug, not real provenance -> not fresh (Toby L1). */
const CLOCK_SKEW_SEC = 120;
/** Content size cap -> a runaway dump can't bloat the DB (Toby L3). */
const MAX_CONTENT_LEN = 64 * 1024;

/**
 * Strip diacritics + lowercase, so the health deny matches on plain ASCII. This is the root fix for the
 * accent-boundary leak Toby found (2026-08-26): a \b-anchored regex treats accented letters as ASCII word
 * boundaries, so "szisztolés" matched but "diagnózis" slipped — luck of the boundary. Deburring first makes
 * \b/\w correct (ASCII string) and lets stems match every agglutinated HU form.
 */
function deburr(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Health-keyword deny — matched against deburr(content). STEMS (no trailing \b) so any suffixed HU form is
 * caught (vernyom -> vérnyomásom, korhaz -> kórházban, orvos -> orvosi). Only UNAMBIGUOUSLY-medical terms:
 * deliberately excludes ambiguous words that would false-block venture content (Toby H1) — bare "pulse"
 * (Pulse dashboards), "dose"/"adag" (dose of signups), "symptom" (a symptom of GC pressure), "kezel"/
 * "recept"/"kontroll", and the tech-overloaded "diagnose/diagnostic" (kept HU-only "diagnoz"). Added weight
 * + specialist + common-regimen terms (Toby H2). Non-exhaustive by nature (drug names, bare BP ratios) —
 * it is DEFENCE-IN-DEPTH behind the whitelist; the compose side cross-checks high-consequence sections.
 */
const HEALTH_DENY_RX =
  /(?:blood\s*pressure|vernyom|systol|diastol|szisztol|diasztol|mmhg|heart\s*rate|heart\s*attack|szivroham|szivritmus|\bmedic|gyogyszer|orvos|doktor|\bdoctor\b|korhaz|klinik|diagnoz|lelet|tunet|beteg|injekci|vervetel|vercukor|glucose|cholesterol|koleszterin|testsuly|body\s*weight|\bweight\b|\bsuly\b|\bbmi\b|cardiolog|kardiolog|\d+\s*mg\b|ramipril|bisoprolol|amlodipin|concor)/;

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
  if (a.content.length > MAX_CONTENT_LEN) {
    return { ok: false, code: 413, error: `content too large (${a.content.length} > ${MAX_CONTENT_LEN}); post a pre-digested section, not a raw dump` };
  }
  // Fail-loud status (Toby M1): an OMITTED status defaults to 'ok' (the agent reported no problem), but a
  // PROVIDED-but-invalid status ('eror', 'BOGUS') coerces to 'error' — NEVER silently to 'ok', which would
  // promote a broken section to healthy and let the gate read complete.
  const status: SectionStatus =
    a.status === undefined ? "ok" : (STATUSES as readonly string[]).includes(a.status) ? a.status : "error";
  // Health deny scans deburred CONTENT on EVERY section (defence-in-depth behind the whitelist).
  if (HEALTH_DENY_RX.test(deburr(a.content))) {
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
  /** effective max age used for the freshness decision (the default when none was supplied). */
  effective_max_age_sec: number;
  /** true when present, status ok, as_of not in the future, and within the effective max age. */
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
 * decide green/red from DATA. `nowSec` is injectable for tests. Freshness: status ok AND as_of not in the
 * future (beyond clock skew) AND within the effective max age (a missing max_age falls back to the default,
 * so nothing is immortal).
 */
export function readBoard(nowSec: number = Math.floor(Date.now() / 1000)): BoardView {
  const rows = getDb()
    .prepare(`SELECT section_key, agent, content, as_of, max_age_sec, status, updated_at FROM briefing_board`)
    .all() as BoardRow[];
  const byKey = new Map(rows.map((r) => [r.section_key, r]));
  const sections: BoardSectionView[] = rows.map((r) => {
    const age = nowSec - r.as_of;
    const eff = r.max_age_sec == null ? DEFAULT_MAX_AGE_SEC : r.max_age_sec;
    const notFuture = age >= -CLOCK_SKEW_SEC;
    const withinAge = age <= eff;
    return { ...r, age_sec: age, effective_max_age_sec: eff, fresh: r.status === "ok" && notFuture && withinAge };
  });
  const missing = EXPECTED_SECTIONS.filter((k) => !byKey.has(k));
  const stale = sections.filter((s) => EXPECTED_SECTIONS.includes(s.section_key as SectionKey) && !s.fresh).map((s) => s.section_key);
  const complete = missing.length === 0 && stale.length === 0;
  return { now: nowSec, sections, missing, stale, complete };
}
