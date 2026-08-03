import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

const logger = log("session");

/**
 * Expose the shared tenant skills directory inside an agent's workspace as `.claude/skills`
 * (issue #21 §5).
 *
 * `skillsDir` was configured and typed from the start but never consumed, so procedural knowledge
 * had nowhere to live except CLAUDE.md — which is re-read on EVERY turn. A monthly runbook sat in
 * context permanently, spending tokens on every message and diluting the daily rules. Skills load
 * progressively: the name and one-line description are always visible, the body only when selected.
 *
 * A symlink rather than a copy, so editing a skill in `tenant/skills/` takes effect for every agent
 * at once with no sync step to forget. Same trick gemini-runtime already uses for AGENTS.md.
 */
export function linkTenantSkills(skillsDir: string, agentDir: string): void {
  // An install with no skills dir is normal, not an error. Creating one here would be presumptuous:
  // an empty directory looks configured, and a link into nothing is worse than no link.
  if (!existsSync(skillsDir)) return;

  const linkPath = join(agentDir, ".claude", "skills");
  try {
    const st = lstatSync(linkPath, { throwIfNoEntry: false });
    if (st) {
      // A REAL directory means the agent keeps its own skills there. Leave it completely alone —
      // replacing it would delete the operator's files to install a convenience.
      if (!st.isSymbolicLink()) return;
      if (readlinkSync(linkPath) === skillsDir) return; // already correct
      rmSync(linkPath); // stale link (e.g. the tenant root moved) — repoint it
    }
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
    symlinkSync(skillsDir, linkPath);
  } catch (err) {
    // Best-effort: a filesystem without symlinks, or a permission problem, must not stop an agent
    // from launching. Losing progressive disclosure is a degradation; failing to start is an outage.
    logger.warn({ agentDir, skillsDir, err }, "could not link tenant skills into agent workspace");
  }
}
