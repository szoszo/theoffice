import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { upsertSection, readBoard, SECTION_WHITELIST, DEFAULT_MAX_AGE_SEC } from "./index.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-board-"));
  openDb(join(dir, "test.db")); // runs migrations -> briefing_board table exists
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  getDb().prepare("DELETE FROM briefing_board").run();
});

const NOW = 1_800_000_000;

describe("briefing board — whitelist primary guarantee", () => {
  it("accepts a whitelisted section, rejects any other key (no 'health', no catch-all)", () => {
    expect(upsertSection({ section_key: "finance", agent: "cfo", content: "Erste 122k", as_of: NOW }).ok).toBe(true);
    for (const k of ["health", "notes", "", "secrets"]) {
      const r = upsertSection({ section_key: k, agent: "x", content: "x", as_of: NOW });
      expect(r.ok, `key ${k}`).toBe(false);
      expect(r.code).toBe(400);
    }
    expect(readBoard(NOW).sections.map((s) => s.section_key)).toEqual(["finance"]);
  });
});

describe("briefing board — health deny (deburred stems)", () => {
  it("DENIES real health data incl. HU agglutinated + accented forms (the Toby canary bar)", () => {
    for (const c of [
      "note: Szoszo BP 132/87, took 5mg ramipril",
      "vérnyomásom 130/90 reggel",
      "orvosi kontroll jövő héten, kórház", // orvos + kórház (accented)
      "a diagnózis szerint",                 // diagnózis (accented, was slipping)
      "kórházban volt",
      "új gyógyszert kapott: bisoprolol",
      "testsúly 82 kg ma",                   // weight (H2)
      // "súly 82 kg" WAS asserted DENIED here and is now an ACCEPTED GAP, deliberately (2026-09-22).
      // Bare `súly`/`weight` also blocked "súly alatt" and "total weight of the swag boxes" - the latter
      // being live toggl copy for the 80-piece order that week. A body weight and a package weight are
      // lexically identical. A false-block removes an ENTIRE section and fails silently from the reader`s
      // side; a gap leaks one sentence. The gap is the cheaper failure. `testsúly`, `body weight` and
      // `bmi` still carry the real health case; a bare kg figure no longer does.
      "BMI 24.1",                            // (H2)
      // *** CASE-COUPLING GUARD — DO NOT REMOVE OR LOWERCASE THESE TWO (Toby, bus 17555). ***
      // HEALTH_DENY_RX at index.ts:86 is FLAGLESS (no `i`). Every uppercase match depends entirely
      // on deburr()'s .toLowerCase() at index.ts:41, and NOTHING asserted that coupling: removing
      // .toLowerCase() leaves 35 of 36 must-deny cases green and leaks every capitalised health
      // mention — which in Hungarian prose is the common case, since it starts the sentence.
      // Measured: "BMI 24.1" above was the ONLY assertion that caught it, by coincidence of being
      // the one literal whose stem is itself capitalised. These two state the property instead.
      "Korhazban volt egesz nap",
      "Vernyomas 130/85",
      // *** FORWARD-GUARD LEAK, FIXED 2026-09-22 ~18:0x (Toby bus 17599/17606, Dwight 17607). ***
      // The place guard USED to read `(?![a-z]*(?:\s+\S+){0,2}\s*<place>)`. The `[a-z]*` let the
      // lookahead swallow the INFLECTION, so an inflected health stem entered the place exemption
      // whenever a street word happened to land within two tokens: "orvoshoz a Dobos utca fele
      // indult" (he set off TO THE DOCTOR via Dobos street) was ACCEPTED onto the shared board.
      // Narrowed to `(?:i|ai|ak|a)?` -- only the adjectival/plural forms that real place names use
      // (Orvosi utca, Klinikak utca) may enter the exemption. An inflected stem never can.
      // These five must stay DENIED. A guard is a leak surface; narrowing one is leak-reducing by
      // construction, which is why this shipped the same evening it was found.
      "orvoshoz a Dobos utca fele indult",
      "klinikara a Kalman ter fele",
      "doktorhoz a Margit korut fele",
      "orvoshoz ment a Dobos utca fele",
      "orvosnal volt a Dobos utca sarkan",
      "cardiologist appointment thursday",   // specialist (H2)
      "kardiológus kontroll",
      "doctor visit friday",                 // EN doctor (re-canary FN)
      "szívroham után lábadozik",            // heart attack HU (re-canary FN)
      "heart attack risk elevated",
      "kapott egy injekciót",                // injekció HU (re-canary FN)
      "koleszterin és vércukor rendben",
      // --- lay-illness gap found by Toby 2026-09-22; a real instance reached the board in cycle 22 ---
      // HU stems unanchored so inflections are caught (marveen 2026-09-22): five were absent entirely
      "szédülés", "hányingere van", "fájdalom a hátában", "influenzás", "gyengélkedik",
      "ágynak esett", "nem érzi jól magát", "megfázott", "rosszul lett", "bedridden today",
      "off sick", "orvoshoz megy", "kórházban volt", "túl beteg",
      "waking up sick",                          // THE observed instance
      "he woke up unwell so no morning drive",   // the realistic passing-mention vector (car/home section)
      "I am ill today",
      "feeling unwell",
      "got the flu",
      "bad migraine",
      "he has a headache",
      "she had a bad headache",
      "he was sick all night",
      "called in sick",
      "szoszo is feeling rough today",
      "felt dizzy",
      "a short illness",
      "sore throat and cough",
      "rosszul vagyok",
      "megfáztam",
      "lázas volt",
      // belázasod* is the prefixed verb: a BARE \blazas on the folded form leaks all three
      // (the fever stem is not word-initial here). Oscar 17753 proposed the boundary; the
      // boundary alone is a leak, so the term carries belazasod beside \blazas.
      "belázasodott éjszaka",
      "belázasodik a gyerek",
      "belázasodtam",
      "fejfájás",
    ]) {
      const r = upsertSection({ section_key: "home", agent: "d", content: c, as_of: NOW });
      expect(r.ok, `should DENY: ${c}`).toBe(false);
      expect(r.code).toBe(422);
    }
    expect(readBoard(NOW).sections.length).toBe(0);
  });

  // ENFORCES FLEET-RULES.md:46 Rule 3 calibration (Szoszo, 2026-08-14): "Tune any HR-privacy
  // scan to the genuine HR/health/personal-circumstance slice specifically, and never treat
  // operational logistics as HR-private." The owner ruled against over-classification five
  // weeks before Toby measured this pattern false-blocking 13/15 operational strings. The
  // cases below are the enforcement; this citation only says WHY, so anyone deleting a case
  // knows which owner ruling they are overriding. Widening the deny? These must still pass.
  it("does NOT false-block venture content that resembles health words (Toby H1 corpus = FLEET-RULES Rule 3)", () => {
    for (const c of [
      "battery health 92%, tyres healthy",
      "high p99 latency is a symptom of GC pressure",  // symptom (dropped)
      "Pulse 5 dashboard shows the funnel",            // bare pulse (dropped)
      "strong dose of new signups this week",          // dose (dropped)
      "nagy adag új feature ment ki",                  // adag (dropped)
      "Oscar kezeli a finance pipeline-t",             // kezel = manage
      "új recept a főzéshez",                          // recept = recipe
      "verzió-kontroll és minőség-kontroll",           // kontroll = control
      "diagnostic logs enabled on the deploy",         // diagnostic (tech, not diagnózis)
      "OBD diagnostics on the Kia",                    // car diagnostics
      "telemedicine client onboarded",                 // telemedicine (re-canary fb#3, \bmedic)
      "impulse buys up 12%",                           // impulse (not pulse)
      "assembly line + heavyweight config",            // assembly/heavyweight (not \bsuly\b/\bweight\b)
      "SQL injection scan clean",                      // injection (tech, not injekci)
      "Concord account + concordance report",          // Concord/concordance (re-canary #2, \bconcor\b)
      "healthy runway, 18 months",
      // --- tech/venture phrases the 2026-09-22 lay-illness additions must NOT false-block ---
      // FALSE-BLOCK CORPUS (Toby, clause 3): these were LIVE refusals before 2026-09-22, 13 of 15.
      // Budapest street + station names - the `car` section publishes these DAILY, nothing else does.
      "Klinikák metró, M3", "Klinikák utca -> Dobos utca 4km", "Klinikák téren",
      "Orvosi utca 3", "Orvosi úton parkol", "Doktor Sándor utca",
      "Kia parked, trip Klinikák -> Dobos utca", "meeting moved, he is at Doktor Sándor utca",
      // weights + doses in ordinary logistics copy (the live toggl swag order that week)
      "a csomag weight 23 kg", "total weight of the swag boxes", "súly alatt", "300 mg caffeine",
      "swag: 80 pcs, total weight of the boxes tbc", "towel 110x180, weight per unit 180g",
      "felelet a kérdésre",
      // \b-anchoring on English literals: ill inside bill/will/still/grill/chill, flu inside influx/fluid
      "bill due Friday", "will pay on Monday", "grill on the terrace", "chill in the air",
      "cash influx", "fluctuation in HUF", "brake fluid topped up",
      // phrase-gated ambiguous terms, and the HU idiom
      "rosszul működik a deploy", "lázas tempó a héten",
      // FIRST IN-THE-WILD false positive (Oscar, 17753): folding duplázás -> duplazas puts
      // the fever stem INSIDE an unrelated word. HU agglutination keeps feeding this class,
      // so nyilazás is here as a second member, not as a duplicate of the same word.
      "Google Pay duplázás, melyik javítást kéred", "duplázás után", "nyilazás",
      // Oscar PREDICTED the class rather than waiting for the next block: the stem lands inside
      // any HU noun in -lázás/-lázas, a productive ending on verb stems in -l. These are his own
      // finance vocabulary and all five were refused before the fix. nullázás is the likeliest
      // next hit ("a nullázás után" in a reconciliation line), so it is here by prediction.
      "triplázás", "a nullázás után", "skálázás a fürtön", "kalkulázás",
      // deliberately NOT in the pattern - each verified to false-block ordinary copy
      "terrace 4C, cold start expected", "set a temperature of 21C", "dizzying number of invoices",
      "the car is laid up at the garage", "under the weather forecast for Friday",
      "this config is a headache",              // headache is phrase-gated on has/had/with
      "the deploy is a headache",
      "the drive is rough on that road",        // `rough` only counts with a feel-verb (CAR section)
      "engine is running rough",
      "the weather is rough today",
      "is ill-advised to ship",                 // \bill\b(?!-) — hyphen is a word boundary
      "an ill-timed release",
      "illiquid asset",
      "illustrate the funnel",
      "virus scanner on the NAS",               // virus/infection deliberately NOT in the pattern
      "malware infection cleaned",
      "inflection point in the curve",
      "influence on conversion",
      "fluid layout",
      "flush the cache",
      "rosszul mukodik a deploy",               // rosszul is gated on vagyok/van/volt/lett/erzem/erzi
      "pain point in onboarding",
      "growing pains on the cluster",
    ]) {
      const r = upsertSection({ section_key: "infra", agent: "darryl", content: c, as_of: NOW });
      expect(r.ok, `should ALLOW: ${c}`).toBe(true);
    }
  });
});

describe("briefing board — freshness / completeness / fail-loud integrity", () => {
  it("stale, skipped, error all surface (not silently dropped)", () => {
    upsertSection({ section_key: "toggl", agent: "pam", content: "fresh", as_of: NOW - 100, max_age_sec: 3600 });
    upsertSection({ section_key: "car", agent: "d", content: "old", as_of: NOW - 7200, max_age_sec: 3600 });
    upsertSection({ section_key: "finance", agent: "cfo", content: "no email", as_of: NOW, max_age_sec: 3600, status: "error" });
    const v = readBoard(NOW);
    expect(v.sections.find((s) => s.section_key === "toggl")!.fresh).toBe(true);
    expect(v.stale).toEqual(expect.arrayContaining(["car", "finance"]));
  });

  it("[M1] a PROVIDED invalid status coerces to 'error' (never silently 'ok')", () => {
    // @ts-expect-error deliberately bad status
    upsertSection({ section_key: "infra", agent: "x", content: "c", as_of: NOW, max_age_sec: 3600, status: "BOGUS" });
    const s = readBoard(NOW).sections.find((s) => s.section_key === "infra")!;
    expect(s.status).toBe("error");
    expect(s.fresh).toBe(false); // not promoted to healthy
  });

  it("[M2] a section with NO max_age is not immortal — stale past the default", () => {
    upsertSection({ section_key: "home", agent: "d", content: "c", as_of: NOW - (DEFAULT_MAX_AGE_SEC + 60) });
    const s = readBoard(NOW).sections.find((s) => s.section_key === "home")!;
    expect(s.effective_max_age_sec).toBe(DEFAULT_MAX_AGE_SEC);
    expect(s.fresh).toBe(false);
  });

  it("[G1] an OMITTED max_age_sec PRESERVES the stored guard (does not silently null it)", () => {
    // The guard-erosion bug: a writer that stops sending the field used to overwrite the contract with
    // NULL, quietly demoting the section to the 6h default. Omission must be a no-op on this field.
    upsertSection({ section_key: "finance", agent: "cfo", content: "v1", as_of: NOW, max_age_sec: 3600 });
    upsertSection({ section_key: "finance", agent: "cfo", content: "v2", as_of: NOW }); // no max_age_sec
    const s = readBoard(NOW).sections.find((s) => s.section_key === "finance")!;
    expect(s.content).toBe("v2"); // the rest of the row DID update
    expect(s.max_age_sec).toBe(3600); // ...but the guard survived
    expect(s.effective_max_age_sec).toBe(3600);
  });

  it("[G2] a preserved guard still bites — omission does not widen the freshness window", () => {
    upsertSection({ section_key: "finance", agent: "cfo", content: "v1", as_of: NOW, max_age_sec: 3600 });
    // Re-write with an as_of older than the 3600 guard but well inside the 6h default it used to fall to.
    upsertSection({ section_key: "finance", agent: "cfo", content: "v2", as_of: NOW - 7200 });
    const s = readBoard(NOW).sections.find((s) => s.section_key === "finance")!;
    expect(s.fresh).toBe(false); // would have read FRESH under the eroded 6h default
  });

  it("[G3] an EXPLICIT null resets to the default (the guard is still clearable on purpose)", () => {
    upsertSection({ section_key: "finance", agent: "cfo", content: "v1", as_of: NOW, max_age_sec: 3600 });
    upsertSection({ section_key: "finance", agent: "cfo", content: "v2", as_of: NOW, max_age_sec: null });
    const s = readBoard(NOW).sections.find((s) => s.section_key === "finance")!;
    expect(s.max_age_sec).toBe(null);
    expect(s.effective_max_age_sec).toBe(DEFAULT_MAX_AGE_SEC);
  });

  it("[G4] a brand-new section that omits max_age_sec still gets the default (no leak from another key)", () => {
    upsertSection({ section_key: "toggl", agent: "pam", content: "c", as_of: NOW, max_age_sec: 900 });
    upsertSection({ section_key: "car", agent: "d", content: "c", as_of: NOW }); // never written before
    const car = readBoard(NOW).sections.find((s) => s.section_key === "car")!;
    expect(car.max_age_sec).toBe(null);
    expect(car.effective_max_age_sec).toBe(DEFAULT_MAX_AGE_SEC);
  });

  it("[G5] a PROVIDED but invalid max_age_sec fails loud (never lands in the DB)", () => {
    upsertSection({ section_key: "home", agent: "d", content: "v1", as_of: NOW, max_age_sec: 3600 });
    for (const bad of [0, -1, 1.5, "3600", NaN]) {
      // @ts-expect-error deliberately bad max_age_sec
      const r = upsertSection({ section_key: "home", agent: "d", content: "v2", as_of: NOW, max_age_sec: bad });
      expect(r.ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
      expect(r.code).toBe(400);
    }
    const s = readBoard(NOW).sections.find((s) => s.section_key === "home")!;
    expect(s.content).toBe("v1"); // rejected writes changed nothing at all
    expect(s.max_age_sec).toBe(3600);
  });

  it("[L1] a FUTURE as_of does not read fresh", () => {
    upsertSection({ section_key: "weather", agent: "d", content: "c", as_of: NOW + 100000, max_age_sec: 3600 });
    expect(readBoard(NOW).sections.find((s) => s.section_key === "weather")!.fresh).toBe(false);
  });

  it("[P1] a 422 NAMES the matched token, so a false positive is a one-word fix (Pam 2026-09-22)", () => {
    const r = upsertSection({ section_key: "car", agent: "d", content: "he went to the orvos this morning", as_of: NOW });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(422);
    expect(r.error).toMatch(/matched: "/);
    expect(r.error).toMatch(/false positive/);
  });

  it("[L3] over-size content is rejected", () => {
    const huge = "x".repeat(64 * 1024 + 1);
    expect(upsertSection({ section_key: "infra", agent: "x", content: huge, as_of: NOW }).code).toBe(413);
  });

  it("complete only when every EXPECTED section is present, ok and fresh", () => {
    for (const k of SECTION_WHITELIST) upsertSection({ section_key: k, agent: "a", content: "c", as_of: NOW, max_age_sec: 3600 });
    expect(readBoard(NOW).complete).toBe(true);
    getDb().prepare("DELETE FROM briefing_board WHERE section_key='weather'").run();
    const v = readBoard(NOW);
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(["weather"]);
  });

  it("UPSERT replaces a section in place (one row per section)", () => {
    upsertSection({ section_key: "home", agent: "d", content: "first", as_of: NOW - 50 });
    upsertSection({ section_key: "home", agent: "d", content: "second", as_of: NOW });
    const rows = readBoard(NOW).sections.filter((s) => s.section_key === "home");
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe("second");
  });
});
