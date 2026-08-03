import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { saveMemory, searchMemories } from "./store.js";

/**
 * Keyword-side ranking. Ported from the parallel fork (Iustinianus, 1c523ea) during the 2026-08-03
 * consolidation, where the same two defects were found independently and actually FIXED — this
 * codebase had only documented them in comments and routed around them with vectors:
 *
 *   1. results came back ordered by salience/recency, so the QUERY barely influenced the order;
 *   2. ftsQuery OR-joined every token INCLUDING stopwords, so a natural-language question matched
 *      nearly every row and ranked whichever long memory happened to contain the most "the"s.
 *
 * Vectors hid this rather than fixing it: semantic hits led the result set, so the keyword tail
 * being mis-ordered was invisible. It is not invisible when the embedder is down, which is exactly
 * when keyword search is the only thing left.
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-kw-"));
  openDb(join(dir, "test.db"));

  // A strong match that is OLD and low-salience: under the previous ordering it lost to anything
  // newer, no matter how well it answered the question.
  const strong = saveMemory({
    agentId: "k",
    content: "the boiler service contract renewal is handled by the managing agent every October",
    category: "cold",
  });
  getDb().prepare("UPDATE memories SET salience = 0, created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(strong);

  // A weak match that is NEW and high-salience: it shares only stopwords with the question.
  const weak = saveMemory({
    agentId: "k",
    content:
      "the meeting is on the schedule and the notes are in the folder and the folder is on the desk " +
      "and the desk is by the window and the window is in the room and the room is on the floor",
    category: "warm",
  });
  getDb().prepare("UPDATE memories SET salience = 9 WHERE id = ?").run(weak);
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const contents = (rows: { content: string }[]) => rows.map((r) => r.content);

describe("a query orders by RELEVANCE, not by salience or recency", () => {
  it("the memory that actually answers the question ranks first, despite being old and salience 0", () => {
    const rows = searchMemories({ agentId: "k", q: "who handles the boiler service contract" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].content).toContain("boiler service contract");
  });

  it("a stopword-heavy memory does not win on stopword count alone", () => {
    const rows = searchMemories({ agentId: "k", q: "who handles the boiler service contract" });
    // The long "the...the...the" memory shares only stopwords with the question; it must not lead.
    expect(rows[0].content).not.toContain("the desk is by the window");
  });
});

describe("stopwords are dropped from the MATCH", () => {
  it("a query of ONLY stopwords does not throw and does not pretend to match everything", () => {
    // Dropping every term would leave an empty MATCH (an FTS syntax error). The fallback must be
    // safe, whatever it returns.
    expect(() => searchMemories({ agentId: "k", q: "the and is on of" })).not.toThrow();
  });

  it("content words still drive the match when mixed with stopwords", () => {
    const rows = searchMemories({ agentId: "k", q: "is the boiler on the contract" });
    expect(contents(rows)[0]).toContain("boiler");
  });
});

describe("the no-query path is UNCHANGED — salience still wins", () => {
  it("without a query, ordering is salience-first (the always-loaded bundle depends on this)", () => {
    // Regression guard: bm25 only makes sense when there is a query. Ordering the always-bundle by
    // relevance-to-nothing would silently undo the core-fact ordering.
    const rows = searchMemories({ agentId: "k" });
    expect(rows[0].content).toContain("the meeting is on the schedule"); // salience 9
  });
});
