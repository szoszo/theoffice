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
      "súly 82 kg",                          // bare súly (re-canary FN)
      "BMI 24.1",                            // (H2)
      "cardiologist appointment thursday",   // specialist (H2)
      "kardiológus kontroll",
      "doctor visit friday",                 // EN doctor (re-canary FN)
      "szívroham után lábadozik",            // heart attack HU (re-canary FN)
      "heart attack risk elevated",
      "kapott egy injekciót",                // injekció HU (re-canary FN)
      "koleszterin és vércukor rendben",
    ]) {
      const r = upsertSection({ section_key: "home", agent: "d", content: c, as_of: NOW });
      expect(r.ok, `should DENY: ${c}`).toBe(false);
      expect(r.code).toBe(422);
    }
    expect(readBoard(NOW).sections.length).toBe(0);
  });

  it("does NOT false-block venture content that resembles health words (Toby H1)", () => {
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
