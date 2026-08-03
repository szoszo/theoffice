/**
 * Operator CLI for semantic-memory coverage.
 *
 *   npm run memory:status     — how many memories are searchable BY MEANING, and why not
 *   npm run memory:backfill   — embed everything that has no usable vector, in bounded batches
 *
 * Why this exists at all: the vector column shipped, saves succeeded, keyword recall kept working,
 * and not one vector was written for eight weeks. Nothing was broken loudly enough to notice. A
 * silent degradation with no command to ask about it is indistinguishable from working software.
 * So the coverage number gets a name, an exit code, and a place to look.
 *
 * Usage:
 *   tsx src/memory/embed-cli.ts status
 *   tsx src/memory/embed-cli.ts backfill [--batch 200] [--max 100000]
 */
import { loadConfig } from "../config.js";
import { openDb, closeDb } from "../db/index.js";
import { countEmbeddings, backfillEmbeddings } from "./store.js";
import { EMBED_MODEL, OLLAMA_URL } from "./embeddings.js";

type Counts = ReturnType<typeof countEmbeddings>;
export type Verdict = "ok" | "degraded" | "off";

/**
 * `usable` is the only honest denominator: a wrong-length vector is stored, counted as populated,
 * and reads cosine 0 against every query — coverage that means nothing. An empty store is "ok"
 * because there is nothing there to have failed.
 */
export function coverageVerdict(c: Counts): Verdict {
  if (c.total === 0 || c.usable === c.total) return "ok";
  if (c.usable === 0) return "off";
  return "degraded";
}

/** Non-zero for anything short of full coverage, so a cron job or CI step can catch this unattended. */
export function exitCodeFor(v: Verdict): number {
  return v === "ok" ? 0 : 1;
}

export function formatStatus(c: Counts, model: string, url: string): string {
  const verdict = coverageVerdict(c);
  const pct = c.total === 0 ? 100 : Math.floor((c.usable / c.total) * 100);
  const lines = [
    `semantic memory coverage: ${c.usable}/${c.total} (${pct}%) — ${verdict.toUpperCase()}`,
    `  embedder: ${model} via ${url}`,
    `  missing vector: ${c.missing}`,
    `  wrong-dimension (stored but semantically dead): ${c.wrongDim}`,
  ];
  if (verdict !== "ok") {
    lines.push(
      "",
      "Memories are NOT lost and recall still works — keyword search covers every row.",
      "What is missing is search by MEANING, so a question phrased differently than the stored",
      "memory may not find it.",
      "",
      "Most likely cause: the local embedder is not reachable. Check, in order:",
      `  1. is Ollama running?            curl -s ${url}/api/tags`,
      `  2. is the model pulled?          ollama pull ${model}`,
      "  3. then fill the gap:            npm run memory:backfill",
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const argOf = (name: string): number | undefined => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? Number(process.argv[i + 1]) : undefined;
  };

  const cfg = loadConfig();
  openDb(cfg.paths.dbFile);
  try {
    if (cmd === "status") {
      const c = countEmbeddings();
      console.log(formatStatus(c, EMBED_MODEL, OLLAMA_URL));
      process.exitCode = exitCodeFor(coverageVerdict(c));
      return;
    }

    if (cmd === "backfill") {
      const batch = argOf("--batch") ?? 200;
      const max = argOf("--max") ?? Number.POSITIVE_INFINITY;
      let written = 0;
      let attempted = 0;
      // Loop until a batch comes back empty (drained) or produces nothing (embedder down —
      // otherwise a dead Ollama would spin here forever re-attempting the same rows).
      for (;;) {
        const r = await backfillEmbeddings(Math.min(batch, max - attempted));
        attempted += r.attempted;
        written += r.written;
        if (r.attempted === 0) break;
        if (r.written === 0) {
          console.error(`stopped: ${r.attempted} rows attempted, none embedded — is Ollama reachable?`);
          break;
        }
        console.log(`  ${written} embedded so far...`);
        if (attempted >= max) break;
      }
      console.log(`\nbackfill done: ${written} embedded (${attempted} attempted)`);
      console.log(formatStatus(countEmbeddings(), EMBED_MODEL, OLLAMA_URL));
      process.exitCode = exitCodeFor(coverageVerdict(countEmbeddings()));
      return;
    }

    console.error(`unknown command: ${cmd}\nusage: memory-cli [status|backfill] [--batch N] [--max N]`);
    process.exitCode = 2;
  } finally {
    closeDb();
  }
}

// Only run when invoked directly, so the pure helpers above stay importable by tests.
if (process.argv[1] && /embed-cli\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
