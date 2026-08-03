import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { violations, ALL_CHECKS } from "./response-checks.js";

/**
 * Behavioural evals for the prompt/persona layer, fixture-backed (issue #21 §4, tier 2).
 *
 * The engine is well covered by vitest; the layer that decides how agents actually BEHAVE had no
 * coverage at all, so editing a persona was blind flying — a regression surfaced days later, in
 * production, as a strange Slack message.
 *
 * Fixtures rather than a live model, deliberately: CI stays free, deterministic and offline, and a
 * failure means someone changed the contract rather than that a model felt different today. The
 * cases are recorded replies; each names the exact checks it must trigger, so both directions are
 * pinned — a check that stops firing fails, and one that starts over-firing fails too.
 *
 * To score a live model against the same set, run the checks over its output; nothing here is
 * coupled to the fixture file beyond loading it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(readFileSync(join(HERE, "fixtures", "behaviour-cases.json"), "utf8")) as {
  cases: { name: string; reply: string; violations: string[] }[];
};

describe("output contract — recorded replies score exactly as expected", () => {
  for (const c of suite.cases) {
    it(c.name, () => {
      expect(violations(c.reply).sort()).toEqual([...c.violations].sort());
    });
  }
});

describe("the case set itself stays honest", () => {
  it("names only checks that exist — a typo'd expectation would silently never fire", () => {
    const known = new Set(Object.keys(ALL_CHECKS));
    for (const c of suite.cases) {
      for (const v of c.violations) expect(known.has(v), `${c.name}: unknown check "${v}"`).toBe(true);
    }
  });

  it("exercises EVERY check at least once, so no rule is shipped untested", () => {
    const covered = new Set(suite.cases.flatMap((c) => c.violations));
    for (const name of Object.keys(ALL_CHECKS)) {
      expect(covered.has(name), `no case triggers ${name}`).toBe(true);
    }
  });

  it("includes clean cases, so the suite can fail on FALSE POSITIVES too", () => {
    // A checker set with only violating cases passes trivially by flagging everything.
    expect(suite.cases.filter((c) => c.violations.length === 0).length).toBeGreaterThanOrEqual(3);
  });
});
