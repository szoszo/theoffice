import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import type { AgentDef } from "../types.js";
import { getDb } from "../db/index.js";

/**
 * Live token-usage computed from each claude agent's transcript JSONL files
 * (~/.claude/projects/<encoded-cwd>/*.jsonl), filtered to a time window; codex/gemini agents come from the
 * token_usage rows their runtimes book per turn. No
 * background ingester — read on demand for the dashboard. Subscription runtime
 * is flat-rate, so these numbers are usage-allowance signal, not dollars.
 */

const PROJECTS = join(homedir(), ".claude", "projects");

/** Claude Code encodes a project dir as the agent's cwd with / and . -> - */
function projectDirFor(agentDir: string): string {
  return agentDir.replace(/[/.]/g, "-");
}

export interface AgentUsage {
  id: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  /** codex/gemini only: reasoning tokens (claude's transcripts do not split these out). */
  thinking: number;
  /** false only when the usage store cannot be read, so usage is unmeasurable → show "n/a", not 0. */
  tracked: boolean;
}

const USAGE_WORKER_TIMEOUT_MS = 120_000;

/**
 * computeUsage in a worker thread, so the ~10 s transcript scan never freezes the engine's event loop (Slack ingest, the deliverer and the
 * dashboard API all share it). It never throws and never hangs:
 *  - a worker that cannot START (module not found, e.g. running from source) falls back to computing inline, inside a try/catch;
 *  - a worker that fails WHILE computing, exits without answering or is silent for 2 minutes (then terminated) rejects, handled by the caller;
 *  - it settles exactly once.
 */
export async function computeUsageAsync(agents: AgentDef[], cutoffMs: number): Promise<AgentUsage[]> {
  // codex/gemini usage is a cheap SQL read and needs the engine's db handle, which a worker thread does not
  // have; only the claude transcript scan goes to the worker.
  const isClaude = (a: AgentDef) => (a.runtime ?? "claude") === "claude";
  const claude = await transcriptUsageAsync(agents.filter(isClaude), cutoffMs);
  const byId = new Map(claude.map((u) => [u.id, u]));
  return agents.map((a) => (isClaude(a) ? byId.get(a.id)! : execUsage(a.id, cutoffMs)));
}

function transcriptUsageAsync(agents: AgentDef[], cutoffMs: number): Promise<AgentUsage[]> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(); };
    const inline = () => finish(() => { try { resolve(computeUsage(agents, cutoffMs)); } catch (e) { reject(e); } });
    let w: Worker;
    try {
      w = new Worker(new URL("./usage-worker.js", import.meta.url), { workerData: { agents, cutoff: cutoffMs } });
    } catch {
      inline();
      return;
    }
    timer = setTimeout(() => { finish(() => reject(new Error("usage worker timed out"))); void w.terminate(); }, USAGE_WORKER_TIMEOUT_MS);
    w.once("message", (r: AgentUsage[]) => { finish(() => resolve(r)); void w.terminate(); });
    w.once("error", (e: NodeJS.ErrnoException) => {
      if (e && (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "ERR_WORKER_PATH")) inline(); // could not start: compute here
      else finish(() => reject(e));
    });
    w.once("exit", (code) => finish(() => reject(new Error(`usage worker exited (${code}) without an answer`))));
  });
}

/** codex/gemini keep no Claude transcripts; the runtimes book one token_usage row per delivered turn. */
function execUsage(id: string, cutoffMs: number): AgentUsage {
  try {
    const r = getDb()
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_read_tokens),0) cr,
                COALESCE(SUM(thinking_tokens),0) th, COUNT(*) n FROM token_usage WHERE agent = ? AND timestamp >= ?`,
      )
      .get(id, cutoffMs) as { i: number; o: number; cr: number; th: number; n: number };
    return { id, input: r.i, output: r.o, cacheRead: r.cr, cacheWrite: 0, thinking: r.th, turns: r.n, tracked: true };
  } catch {
    return { id, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, turns: 0, tracked: false };
  }
}

export function computeUsage(agents: AgentDef[], cutoffMs: number): AgentUsage[] {
  return agents.map((a) => {
    // Usage is parsed from Claude Code transcripts; non-Claude runtimes don't write them,
    // so their tokens are unmeasurable here (report n/a rather than a misleading 0).
    const isClaude = (a.runtime ?? "claude") === "claude";
    if (!isClaude) return execUsage(a.id, cutoffMs);
    const tracked = true;
    const dir = join(PROJECTS, projectDirFor(a.dir));
    let input = 0, output = 0, cr = 0, cc = 0, turns = 0;
    if (tracked && existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        let text: string;
        try {
          text = readFileSync(join(dir, f), "utf8");
        } catch {
          continue;
        }
        for (const line of text.split("\n")) {
          if (!line.includes('"usage"')) continue;
          let m: any;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          const ts = Date.parse(m.timestamp ?? m.ts ?? "");
          if (!Number.isFinite(ts) || ts < cutoffMs) continue;
          const u = (m.message && m.message.usage) || m.usage;
          if (!u) continue;
          input += u.input_tokens || 0;
          output += u.output_tokens || 0;
          cr += u.cache_read_input_tokens || 0;
          cc += u.cache_creation_input_tokens || 0;
          turns++;
        }
      }
    }
    return { id: a.id, input, output, cacheRead: cr, cacheWrite: cc, thinking: 0, turns, tracked };
  });
}

export const WINDOW_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "3d": 259_200_000,
  "7d": 604_800_000,
};
