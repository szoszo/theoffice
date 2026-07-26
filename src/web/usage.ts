import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDef } from "../types.js";

/**
 * Live token-usage computed from each agent's Claude transcript JSONL files
 * (~/.claude/projects/<encoded-cwd>/*.jsonl), filtered to a time window. No
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
  /** false when the runtime keeps no Claude transcripts (codex/gemini) so usage is unmeasurable → show "n/a", not 0. */
  tracked: boolean;
}

export function computeUsage(agents: AgentDef[], cutoffMs: number): AgentUsage[] {
  return agents.map((a) => {
    // Usage is parsed from Claude Code transcripts; non-Claude runtimes don't write them,
    // so their tokens are unmeasurable here (report n/a rather than a misleading 0).
    const tracked = (a.runtime ?? "claude") === "claude";
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
    return { id: a.id, input, output, cacheRead: cr, cacheWrite: cc, turns, tracked };
  });
}

export const WINDOW_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "3d": 259_200_000,
  "7d": 604_800_000,
};
