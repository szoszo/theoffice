import { describe, it, expect } from "vitest";
import { coverageVerdict, formatStatus, exitCodeFor } from "./embed-cli.js";

/**
 * The operator-facing half of the vectorization fix. The bug that started all this was not that
 * embedding was hard — it was that ZERO coverage looked exactly like full coverage from the outside
 * for eight weeks. So the contract under test is: this command can never report a problem quietly.
 *
 * That matters most for anyone running their own copy of The Office. Ollama is an external process
 * we do not control; the honest default is to assume it is NOT there and say so loudly.
 */

const counts = (o: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...o });
const base = () => ({ total: 100, embedded: 100, missing: 0, wrongDim: 0, usable: 100 });

describe("coverageVerdict", () => {
  it("full coverage -> ok", () => {
    expect(coverageVerdict(counts())).toBe("ok");
  });

  it("nothing embedded at all -> off (the eight-week bug), not merely 'degraded'", () => {
    // This is the exact shape of the original failure: rows present, column present, not one vector.
    expect(coverageVerdict(counts({ embedded: 0, missing: 100, usable: 0 }))).toBe("off");
  });

  it("a partial gap -> degraded", () => {
    expect(coverageVerdict(counts({ embedded: 60, missing: 40, usable: 60 }))).toBe("degraded");
  });

  it("wrong-dimension vectors count as a gap even though the column is populated", () => {
    // Present but semantically dead: cosine 0 against everything. "embedded" alone would call this fine.
    expect(coverageVerdict(counts({ embedded: 100, missing: 0, wrongDim: 100, usable: 0 }))).toBe("off");
  });

  it("an empty store is ok, not 'off' — there is nothing to fail to embed", () => {
    expect(coverageVerdict(counts({ total: 0, embedded: 0, missing: 0, usable: 0 }))).toBe("ok");
  });
});

describe("exitCodeFor — a script must be able to detect this without parsing prose", () => {
  it("ok exits 0, and anything less exits non-zero so cron/CI can catch it", () => {
    expect(exitCodeFor("ok")).toBe(0);
    expect(exitCodeFor("degraded")).not.toBe(0);
    expect(exitCodeFor("off")).not.toBe(0);
  });
});

describe("formatStatus", () => {
  it("states the usable number, not just the populated one", () => {
    const out = formatStatus(counts({ embedded: 100, wrongDim: 30, usable: 70 }), "nomic-embed-text", "http://x");
    expect(out).toContain("70");
    expect(out).toMatch(/wrong.dimension/i);
  });

  it("when coverage is off it names the likely cause and the fix, not just the number", () => {
    // An operator reading this at 2am should not have to go source-diving to learn it needs Ollama.
    const out = formatStatus(counts({ embedded: 0, missing: 100, usable: 0 }), "nomic-embed-text", "http://x");
    expect(out).toMatch(/ollama/i);
    expect(out).toMatch(/backfill/i);
    expect(out).toContain("nomic-embed-text");
  });

  it("says plainly that recall still works, so nobody thinks their memories are lost", () => {
    // The memory is the asset; the vector is an enhancement. A scary status line must not imply data loss.
    const out = formatStatus(counts({ embedded: 0, missing: 100, usable: 0 }), "nomic-embed-text", "http://x");
    expect(out).toMatch(/keyword/i);
  });
});
