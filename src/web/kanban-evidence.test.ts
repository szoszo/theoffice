import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { checkDoneEvidence } from "./kanban-evidence.js";

/**
 * Issue #21 §1. Nothing made an agent prove a card was finished, and "reports success on work that
 * silently did not land" is the most common agent failure there is.
 *
 * The issue offered two shapes: a `verification` column, or simply requiring one comment before
 * `done`. We took the column. Requiring a comment is satisfied by ANY comment, so it would measure
 * "this agent knows a comment is required" and render a board that looks audited while asserting
 * nothing — worse than no check, because people trust it.
 *
 * The column is not proof either; nothing short of re-running the work is. What it does is make the
 * claim EXPLICIT, attributable and readable later, so a false one is a visible lie rather than an
 * absence. That is the honest ceiling for this guard, and it is worth having.
 */

let dir: string;
const CARD = "card-1";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-kb-"));
  openDb(join(dir, "test.db"));
  getDb().prepare(`INSERT INTO kanban_cards (id, title, status) VALUES (?, 'do a thing', 'in_progress')`).run(CARD);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const card = () =>
  getDb().prepare(`SELECT status, verification FROM kanban_cards WHERE id = ?`).get(CARD) as {
    status: string;
    verification: string | null;
  };

describe("moving a card to done requires evidence", () => {
  it("rejects done with no verification at all", () => {
    const r = checkDoneEvidence("done", undefined, CARD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/verification/i);
  });

  it("rejects a verification that is blank or whitespace", () => {
    expect(checkDoneEvidence("done", "   ", CARD).ok).toBe(false);
    expect(checkDoneEvidence("done", "", CARD).ok).toBe(false);
  });

  it("rejects a token gesture — evidence has to say something", () => {
    // Not a real defence against a determined agent, but it stops the laziest reflex: typing "ok"
    // to get past the gate. Anything that clears this bar had to at least describe what was run.
    for (const junk of ["ok", "done", "yes", "x", "fixed", ".", "n/a"]) {
      expect(checkDoneEvidence("done", junk, CARD).ok, junk).toBe(false);
    }
  });

  it("accepts evidence that describes what was run and what came back", () => {
    const r = checkDoneEvidence("done", "ran npm test: 471 passed, 0 failed", CARD);
    expect(r.ok).toBe(true);
  });

  it("accepts done when the card ALREADY carries verification from an earlier call", () => {
    // Re-closing a card that was reopened must not demand the evidence be retyped verbatim.
    getDb().prepare(`UPDATE kanban_cards SET verification = ? WHERE id = ?`).run("curl returned 200 and the row exists", CARD);
    expect(checkDoneEvidence("done", undefined, CARD).ok).toBe(true);
  });
});

describe("every other transition is untouched", () => {
  it("planned / in_progress / waiting never require evidence", () => {
    for (const st of ["planned", "in_progress", "waiting"]) {
      expect(checkDoneEvidence(st, undefined, CARD).ok, st).toBe(true);
    }
  });

  it("a card that does not exist is not this guard's problem", () => {
    // The 404 belongs to the caller; the guard must not turn a missing card into a 400 about
    // evidence, which would send whoever hit it looking in entirely the wrong place.
    expect(checkDoneEvidence("done", "ran the check, output was green", "no-such-card").ok).toBe(true);
  });
});

describe("the schema carries the evidence", () => {
  it("kanban_cards has a verification column so the claim survives the request", () => {
    expect(card().verification).toBeNull();
    getDb().prepare(`UPDATE kanban_cards SET verification = ?, status='done' WHERE id = ?`).run("re-read the file", CARD);
    expect(card().verification).toBe("re-read the file");
    expect(card().status).toBe("done");
  });
});
