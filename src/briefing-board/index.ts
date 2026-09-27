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
 *
 * REWRITTEN 2026-09-22, BOTH DIRECTIONS, after Toby tested the one direction nobody had: THE PATTERN WAS
 * ALREADY FALSE-BLOCKING ORDINARY SECTION COPY. 13 of 15 plausible strings were refused, including four real
 * content shapes from that week. A 422 is a HARD REFUSAL, so the whole section is absent from the board - and a
 * missing section is indistinguishable from an agent that did not run. THE FALSE-BLOCK IS THE MORE EXPENSIVE
 * FAILURE, not the gap, and we optimised the cheap one for two days.
 * FIXED FALSE-BLOCKS (each was live):
 *   orvos|doktor|klinik  now carry a PLACE GUARD - Klinikak is a real M3 station, Orvosi utca and Doktor
 *                        Sandor utca are real streets, and `car` publishes street names EVERY DAY.
 *   lelet -> \blelet     `lelet` matched inside `felelet`.
 *   bare weight / suly / \d+mg  DROPPED - blocked "total weight of the swag boxes" (toggl, live that week),
 *                        "suly alatt", "300 mg caffeine". body_weight and testsuly still carry the real case.
 * CLOSED GAP (Toby, five cycles, reported into a dead-lettered address so nobody heard it): the list was
 * CLINICAL and the case that reaches a whitelisted section is A HUMAN EXPLAINING WHY SOMETHING DID NOT HAPPEN.
 * Two threats, two vocabularies, one written. Real instance in cycle 22: "waking up sick".
 * ANCHORING IS ASYMMETRIC ON PURPOSE (marveen) - DO NOT TIDY IT INTO UNIFORMITY:
 *   HUNGARIAN stems  -> NO trailing \b (agglutinative: betegen, orvoshoz, korhazban must all hit)
 *   ENGLISH literals -> \b REQUIRED   (`ill` inside bill/will/still/grill/chill; `flu` inside influx/fluid)
 * DELIBERATELY STRICTER THAN THE AGREED SHORTLIST, because plain versions false-block on test:
 *   headache needs has/had/with -> "this config is a headache" must pass
 *   rough/lousy need a feel-verb -> "the drive is rough on that road" must pass (car section)
 *   rosszul needs vagyok/van/volt/lett/erzem/erzi -> "rosszul mukodik a deploy" must pass
 *   lazas excludes tempo|iram -> "lazas tempo" is an idiom for a busy week
 * NOT ADDED, verified to false-block: cold ("4C, cold start" - weather carries it daily), a temperature,
 *   dizzy ("dizzying number of invoices"), laid up ("car is laid up at the garage"), under the weather,
 *   virus/infection (security sections).
 * CLAUSE THAT OUTRANKS THE OTHER TWO (Toby): EVERY term, existing and new, is tested against a false-block
 * corpus before it ships, and that corpus MUST contain Budapest street and station names.
 * That corpus is the ENFORCEMENT of FLEET-RULES.md:46 Rule 3 (Szoszo, 2026-08-14, against
 * over-classifying operational content as HR-private). Read the rule there, not here: a
 * second copy of its wording is a second thing to go stale. Do not widen this regex
 * without running index.test.ts.
 *
 * DO NOT add \b to the HU stems as a blanket cleanup. Matching runs on deburr()'d text, so a
 * stem can sit inside an unrelated word (duplazas contains the fever stem - a real refusal of
 * ordinary finance copy, Oscar 2026-09-24). A leading \b fixes that class but REMOVES matches,
 * which is the leak direction, and Hungarian compounds put the health stem at the END of a word:
 *   magasvernyomas, szivbeteg, belazasodott   <- all real, all health data, all mid-word
 * So \b is safe ONLY for a stem that never appears as a compound tail, decided per stem and
 * MEASURED against must-fire cases that include a PREFIXED form, not just the bare adjective.
 * A must-fire set containing only word-initial forms cannot detect the leak a \b introduces.
 */
const HEALTH_DENY_RX =
  /(?:blood\s*pressure|vernyom|systol|diastol|szisztol|diasztol|mmhg|heart\s*rate|heart\s*attack|szivroham|szivritmus|\bmedic|gyogyszer|(?:orvos|doktor|klinik)(?!(?:i|ai|ak|a)?(?:\s+\S+){0,2}\s*(?:utca|utcai|\but\b|uton|\bter\b|tere|teren|korut|metro|megallo|allomas|\bm[1-4]\b))|\bdoctor\b|korhaz|diagnoz|\blelet|tunet|beteg|injekci|vervetel|vercukor|glucose|cholesterol|koleszterin|testsuly|body\s*weight|\bbmi\b|cardiolog|kardiolog|ramipril|bisoprolol|amlodipin|\bconcor\b|\bsick\b|\bill\b(?!-)|\bunwell\b|\bmigraine|\bbedridden\b|\bflu\b|influenza|\billness\b|\bfever\b|feverish|\bnausea|vomit|diarrhoea|diarrhea|sore\s+throat|\bcough\b|coughing|antibiotic|(?:\bhas|\bhad|\bwith)\s+(?:a\s+)?(?:bad\s+|terrible\s+|awful\s+|slight\s+)?head\s?ache|(?:feel|feels|feeling|felt)[a-z\s]{0,12}\b(?:rough|lousy|poorly|dizzy)\b|szedul|hanyinger|fajdal|megfaz|influenzas|gyengelkedik|fejfaj|agynak\s+esett|hanyt|hasmenes|torokfaj|belazasod|\blazas(?!\s*(?:tempo|iram))|rosszul\s+(?:vagyok|van|volt|lett|erzem|erzi)|nem\s+erzi\s+jol)/;

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
  /**
   * Freshness contract in seconds. OMIT the field to KEEP whatever is stored (a partial update must not
   * erode the guard — see upsertSection); send an explicit `null` to clear it back to DEFAULT_MAX_AGE_SEC.
   */
  max_age_sec?: number | null;
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
  const hit = HEALTH_DENY_RX.exec(deburr(a.content));
  if (hit) {
    // NAME THE MATCHED TOKEN (Pam, 2026-09-22). "content looks like health data" tells the writer they are
    // wrong without telling them WHICH WORD. At 07:10, five minutes before compose, the difference between
    // naming `klinik` and not naming it is a one-word fix versus a dropped section.
    return { ok: false, code: 422, error: `content looks like health data (matched: "${hit[0]}") — the briefing board is shared and never carries health; keep it on the private health path. If this is a false positive (a street name, a package weight), rephrase that token and re-post.` };
  }
  // GUARD EROSION (fixed 2026-09-16, found by marveen, cause traced here): this used to bind
  // `a.max_age_sec ?? null` straight into `max_age_sec=excluded.max_age_sec`, so a writer that simply
  // STOPPED SENDING the field silently overwrote a deliberately-set contract with NULL on its very next
  // write. The section then fell back to the 6h default with nobody deciding that and nobody able to see
  // it. Observed live: finance carried 3600 through 09-09, then NULL 09-10..09-15 — not an edit, an
  // omission. Same spirit as the status rule above: an omission must never quietly weaken a guard.
  //   omitted  -> KEEP the stored value (NULL on first insert, so a brand-new section still gets the default)
  //   null     -> explicit reset to the default
  //   number   -> set it (validated below; a provided-but-bad value fails loud instead of landing in the DB)
  const provided = a.max_age_sec !== undefined;
  if (provided && a.max_age_sec !== null) {
    const v = a.max_age_sec as unknown;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return {
        ok: false,
        code: 400,
        error: `max_age_sec must be a positive integer number of seconds (got ${JSON.stringify(v)}); omit the field to keep the stored value, or send null to fall back to the ${DEFAULT_MAX_AGE_SEC}s default`,
      };
    }
  }
  getDb()
    .prepare(
      `INSERT INTO briefing_board (section_key, agent, content, as_of, max_age_sec, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(section_key) DO UPDATE SET
         agent=excluded.agent, content=excluded.content, as_of=excluded.as_of,
         max_age_sec=CASE WHEN ? = 1 THEN excluded.max_age_sec ELSE briefing_board.max_age_sec END,
         status=excluded.status, updated_at=unixepoch()`
    )
    .run(a.section_key, a.agent, a.content, a.as_of, a.max_age_sec ?? null, status, provided ? 1 : 0);
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
