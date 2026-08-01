// Mechanical pre-restart safety gate.
//
// The manual "check the tmux server's cgroup before restarting" procedure produced THREE confidently
// wrong answers in one day (2026-08-01), from two people who both knew its traps. Each returns a
// plausible pid rather than an error, so the wrong answer is indistinguishable from the right one.
// The fix that mattered was not "remember to be careful" but making the correct check the path of
// least resistance: the update path runs it itself.
//
// THE CUT IS "IS THERE ANYTHING TO LOSE", NOT "COULD I DETERMINE SAFETY" (Michael, 2026-08-01).
// The first version keyed on the latter and so treated "cannot determine" as fine — which is the
// same mistake that, within the hour, let a blind clear-verify report 12 false "clean"s while
// residue survived. Cannot-tell is not a synonym for safe. It only means safe when there is
// demonstrably nothing at stake.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RestartDecision = { proceed: boolean; reason: string };

/** Set to any non-empty value to proceed despite a refusal. Logged loudly; leaves a trace. */
export const OVERRIDE_ENV = "OFFICE_FORCE_RESTART";

/**
 * Checker exit codes:
 *   0 — proven SAFE (tmux server is decoupled from the service)
 *   1 — proven UNSAFE (the restart would kill every agent session)
 *   2 — a FLEET EXISTS but its blast radius is unreadable (multiple servers, pane-parent mismatch,
 *       unreadable cgroup, service not running). Live sessions, unknown consequence -> REFUSE.
 *   3 — NOTHING TO PROTECT (no server at all, or an empty husk). Safe BY CONSTRUCTION -> proceed.
 *
 * `fleetExists` covers the codes the checker cannot speak for (it crashed, or is absent): refuse only
 * when there is actually something to lose, so a box with no fleet never blocks.
 */
export function decideRestart(exitCode: number | null, checkerOutput = "", fleetExists = false): RestartDecision {
  const tail = checkerOutput ? "\n" + checkerOutput.trim() : "";
  if (exitCode === 0) return { proceed: true, reason: "pre-restart check: fleet is decoupled, safe to restart" + tail };
  if (exitCode === 3) return { proceed: true, reason: "pre-restart check: nothing to protect on this box" + tail };
  if (exitCode === 1) {
    return {
      proceed: false,
      reason:
        "REFUSING to restart: the tmux server shares this service's cgroup, so a restart would kill every " +
        "agent session on this box. Fix the unit (KillMode=process, or give tmux its own scope/unit), " +
        `then retry. Set ${OVERRIDE_ENV}=1 to override.` + tail,
    };
  }
  if (exitCode === 2) {
    return {
      proceed: false,
      reason:
        "REFUSING to restart: agent sessions are LIVE but the blast radius could not be determined, so we " +
        "cannot tell whether restarting kills them. This is the case the gate exists for. Investigate, " +
        `then retry. Set ${OVERRIDE_ENV}=1 to override.` + tail,
    };
  }
  // Checker crashed / absent / unexpected code: refuse only if there is something to lose.
  if (fleetExists) {
    return {
      proceed: false,
      reason:
        `REFUSING to restart: the blast-radius checker gave no usable answer (exit ${exitCode}) and agent ` +
        `sessions are LIVE, so a restart would be blind. Set ${OVERRIDE_ENV}=1 to override.` + tail,
    };
  }
  return { proceed: true, reason: `pre-restart check inconclusive (exit ${exitCode}) but no fleet to lose` + tail };
}

/** Locate the bundled checker; null when it is absent (older checkout, trimmed install). */
export function checkerPath(repoRoot: string): string | null {
  const p = join(repoRoot, "scripts", "check-blast-radius.sh");
  return existsSync(p) ? p : null;
}

/**
 * Minimal independent probe: does this socket carry any agent session? Used only when the checker
 * cannot answer, to decide whether "cannot tell" is harmless or dangerous. Never throws — a failure
 * to probe is treated as "no fleet", because the checker's own verdict is the primary signal and this
 * is a fallback, not a second opinion.
 */
export function fleetExistsOn(socket: string): boolean {
  try {
    const out = execFileSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return out.split("\n").some((s) => s.trim().startsWith("agent-"));
  } catch {
    return false;
  }
}

/**
 * Run the bundled checker and decide. Never throws: a broken checker must not be able to wedge
 * updates on a box with nothing at stake — but it must not wave one through on a box with a live
 * fleet either.
 */
export function checkRestartSafety(repoRoot: string, socket: string, service: string): RestartDecision {
  if (process.env[OVERRIDE_ENV]) {
    return { proceed: true, reason: `!! ${OVERRIDE_ENV} set — pre-restart safety gate DELIBERATELY BYPASSED` };
  }
  const script = checkerPath(repoRoot);
  if (!script) {
    // Absent checker is only safe when there is nothing to lose; otherwise we would restart blind.
    return decideRestart(null, "blast-radius checker not present in this checkout", fleetExistsOn(socket));
  }
  try {
    const out = execFileSync("bash", [script, socket, service], { encoding: "utf8", timeout: 30_000 });
    return decideRestart(0, out);
  } catch (e: any) {
    const code = typeof e?.status === "number" ? e.status : null;
    const out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
    // Only probe when the code itself cannot decide — 1/2/3 are self-sufficient.
    const needProbe = code !== 1 && code !== 2 && code !== 3;
    return decideRestart(code, out, needProbe ? fleetExistsOn(socket) : false);
  }
}
