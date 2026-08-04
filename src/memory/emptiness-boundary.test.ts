import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, closeDb, getDb } from "../db/index.js";
import { countEmbeddings } from "./store.js";
import { coverageVerdict, exitCodeFor } from "./embed-cli.js";

/**
 * Cross-language consistency, TS half. The "is this NULL row embeddable" rule lives in TWO languages —
 * store.ts countEmbeddings (this side) and tenant/store/watchd-checks/memory_embedding_health.py
 * (UNEMBEDDABLE_SQL) — and they must never disagree, or coverage and the alarm read the same store
 * differently. Both sides assert against the SAME shared fixture (../__fixtures__/embeddable-boundary.json):
 * edit one language's clause without the other and that side goes red here (TS) or in the python unittest.
 * The NULL-keywords rows are the load-bearing ones — the likeliest drift is one side COALESCE-ing null
 * keywords and the other not.
 */
const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/embeddable-boundary.json"), "utf8"),
) as { rows: { content: string; keywords: string | null; embeddable: boolean }[] };

describe("emptiness boundary — TS countEmbeddings rule agrees with the shared cross-language fixture", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "emptiness-ts-"));
    openDb(join(dir, "t.db"));
  });
  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const row of fixture.rows) {
    const label = `content=${JSON.stringify(row.content)} keywords=${JSON.stringify(row.keywords)} -> ${
      row.embeddable ? "EMBEDDABLE" : "un-embeddable"
    }`;
    it(label, () => {
      const db = getDb();
      db.prepare("DELETE FROM memories").run();
      // insert as a NULL-vector row, exactly what countEmbeddings classifies
      db.prepare("INSERT INTO memories(agent_id, category, content, keywords) VALUES('fx','warm',?,?)").run(
        row.content,
        row.keywords,
      );
      const c = countEmbeddings();
      expect(c.total).toBe(1);
      // unembeddable is 1 iff the row is NOT embeddable — the TS rule must match the fixture per-row
      expect(c.unembeddable).toBe(row.embeddable ? 0 : 1);
    });
  }

  // Composed cross-FILE regression guard (store.ts countEmbeddings -> embed-cli.ts coverageVerdict/exitCodeFor):
  // an un-embeddable row present alongside fully-covered embeddable rows must still read "ok" so embed-cli
  // stamps the backfill marker on that run — otherwise the .py (b) alarm would false-fire. A unit test of any
  // single link would not catch an edit that breaks the chain; this pins the whole store->cli path.
  it("un-embeddable row present + all embeddable covered -> verdict ok -> exit 0 (marker stamps, (b) no-fire)", () => {
    const db = getDb();
    db.prepare("DELETE FROM memories").run();
    const vec = JSON.stringify(Array(1024).fill(0.1)); // a valid 1024-dim vector == usable
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO memories(agent_id, category, content, keywords, embedding) VALUES('c','warm',?,?,?)").run(
        `real ${i}`, null, vec,
      );
    }
    db.prepare("INSERT INTO memories(agent_id, category, content, keywords) VALUES('c','warm','','')").run(); // un-embeddable NULL
    const c = countEmbeddings();
    expect(c.unembeddable).toBe(1);
    expect(coverageVerdict(c)).toBe("ok");     // un-embeddable carved out of the denominator -> full coverage
    expect(exitCodeFor(coverageVerdict(c))).toBe(0); // exit 0 is exactly what makes embed-cli stamp the marker
  });
});
