import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { upsertSection, readBoard, SECTION_WHITELIST } from "./index.js";

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

const NOW = 1_800_000_000; // fixed test clock

describe("briefing board — whitelist + health exclusion (the privacy guarantee)", () => {
  it("accepts a whitelisted section", () => {
    const r = upsertSection({ section_key: "finance", agent: "cfo", content: "Erste 122k, under floor", as_of: NOW, max_age_sec: 3600 });
    expect(r.ok).toBe(true);
    expect(readBoard(NOW).sections.map((s) => s.section_key)).toContain("finance");
  });

  it("REJECTS a non-whitelisted section_key (no free-text sections, no 'health')", () => {
    const health = upsertSection({ section_key: "health", agent: "marveen", content: "checkup ok", as_of: NOW });
    expect(health.ok).toBe(false);
    expect(health.code).toBe(400);
    const rando = upsertSection({ section_key: "secrets", agent: "x", content: "x", as_of: NOW });
    expect(rando.ok).toBe(false);
    // nothing was written
    expect(readBoard(NOW).sections.length).toBe(0);
  });

  it("DENIES health-keyword content even inside a whitelisted section (incl. HU agglutinated forms)", () => {
    // Each must be rejected (422) and never written.
    for (const c of [
      "note: Szoszo BP 132/87, took 5mg ramipril",
      "vérnyomás 130/90 reggel",
      "orvosi kontroll jövő héten, kórház", // the exact canary gap (orvosi/kórház) — was slipping through
      "a diagnózis szerint",                 // agglutinated: diagnózis, was missed by \bdiagnóz\b
      "kórházban volt",                      // suffixed kórház
      "új gyógyszert kapott",                // suffixed gyógyszer
    ]) {
      const r = upsertSection({ section_key: "home", agent: "dwight", content: c, as_of: NOW });
      expect(r.ok, `should deny: ${c}`).toBe(false);
      expect(r.code).toBe(422);
    }
    expect(readBoard(NOW).sections.length).toBe(0);
  });

  it("does NOT false-block legit venture content resembling health words / ambiguous stems", () => {
    for (const c of [
      "battery health 92%, tyres healthy, service due",
      "Oscar kezeli a finance pipeline-t",   // kezel = manage, NOT treatment
      "új recept a főzéshez",                // recept = recipe, NOT prescription
      "verzió-kontroll és minőség-kontroll", // kontroll = control, NOT medical checkup
      "healthy runway, 18 months",
    ]) {
      const r = upsertSection({ section_key: "car", agent: "dwight", content: c, as_of: NOW });
      expect(r.ok, `should allow: ${c}`).toBe(true);
    }
  });
});

describe("briefing board — freshness + completeness gate", () => {
  it("computes fresh/stale from as_of vs max_age_sec", () => {
    upsertSection({ section_key: "toggl", agent: "pam", content: "x", as_of: NOW - 100, max_age_sec: 3600 }); // fresh
    upsertSection({ section_key: "car", agent: "dwight", content: "y", as_of: NOW - 7200, max_age_sec: 3600 }); // stale (too old)
    const v = readBoard(NOW);
    expect(v.sections.find((s) => s.section_key === "toggl")!.fresh).toBe(true);
    expect(v.sections.find((s) => s.section_key === "car")!.fresh).toBe(false);
    expect(v.stale).toContain("car");
  });

  it("a non-ok status is not fresh (a skipped/error section surfaces, not silently dropped)", () => {
    upsertSection({ section_key: "finance", agent: "cfo", content: "could not read email", as_of: NOW, max_age_sec: 3600, status: "error" });
    const v = readBoard(NOW);
    expect(v.sections.find((s) => s.section_key === "finance")!.fresh).toBe(false);
    expect(v.stale).toContain("finance");
  });

  it("complete only when every EXPECTED section is present, ok and fresh; missing sections are listed", () => {
    for (const k of SECTION_WHITELIST) upsertSection({ section_key: k, agent: "a", content: "c", as_of: NOW, max_age_sec: 3600 });
    expect(readBoard(NOW).complete).toBe(true);
    getDb().prepare("DELETE FROM briefing_board WHERE section_key='weather'").run();
    const v = readBoard(NOW);
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(["weather"]);
  });

  it("UPSERT replaces a section in place (one row per section)", () => {
    upsertSection({ section_key: "home", agent: "dwight", content: "first", as_of: NOW - 50 });
    upsertSection({ section_key: "home", agent: "dwight", content: "second", as_of: NOW });
    const rows = readBoard(NOW).sections.filter((s) => s.section_key === "home");
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe("second");
  });
});
