// Mechanical pre-restart safety gate.
//
// The manual "check the tmux server's cgroup before restarting" procedure produced THREE confidently
// wrong answers in one day (2026-08-01) from two people who both knew its traps — a transient tmux
// client, a shell whose own command line matched the grep, and an empty keepalive server mistaken for
// the fleet. Each returns a plausible pid rather than an error, so the wrong answer is indistinguishable
// from the right one.
//
// The fix that mattered was not "remember to be careful" — it was making the correct check the path of
// least resistance. A tool you have to remember to use is still a procedure, and individual resolve is
// exactly what failed three times. So the update path runs the check itself.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** What the update path should do, given the checker's exit code. */
export type RestartDecision = { proceed: boolean; reason: string };

/**
 * ASYMMETRIC BY DESIGN: only a PROVEN-unsafe result blocks a restart.
 *
 *   0 -> proceed  (proven safe: tmux server is decoupled from the service)
 *   1 -> REFUSE   (proven unsafe: restarting would kill the whole agent fleet)
 *   2 -> proceed with a warning (cannot determine)
 *
 * "Cannot determine" must NOT block. A fresh tenant with no agents running yet, a box with no tmux
 * server, or a differently-named unit all legitimately produce exit 2, and blocking there would break
 * updates for every install that has not started a fleet. Refusing only on a definite UNSAFE keeps the
 * gate from becoming the thing people route around — which is how safety checks die.
 */
export function decideRestart(exitCode: number | null, checkerOutput = ""): RestartDecision {
  if (exitCode === 1) {
    return {
      proceed: false,
      reason:
        "REFUSING to restart: the tmux server shares this service's cgroup, so a restart would kill every " +
        "agent session on this box. Fix the unit (KillMode=process, or give tmux its own scope/unit) and " +
        "retry.\n" + checkerOutput,
    };
  }
  if (exitCode === 0) return { proceed: true, reason: "pre-restart check: fleet is decoupled, safe to restart" };
  return {
    proceed: true,
    reason:
      `pre-restart check could not determine blast radius (exit ${exitCode}); proceeding, since a box with ` +
      `no running fleet legitimately cannot answer this.\n` + checkerOutput,
  };
}

/** Locate the bundled checker; null when it is absent (older checkout, trimmed install). */
export function checkerPath(repoRoot: string): string | null {
  const p = join(repoRoot, "scripts", "check-blast-radius.sh");
  return existsSync(p) ? p : null;
}

/**
 * Run the bundled checker and decide. Never throws: a broken checker must not be able to block an
 * update, only a proven-unsafe verdict may do that.
 */
export function checkRestartSafety(repoRoot: string, socket: string, service: string): RestartDecision {
  const script = checkerPath(repoRoot);
  if (!script) return { proceed: true, reason: "pre-restart check: checker not present, skipping" };
  try {
    const out = execFileSync("bash", [script, socket, service], { encoding: "utf8", timeout: 30_000 });
    return decideRestart(0, out);
  } catch (e: any) {
    const code = typeof e?.status === "number" ? e.status : null;
    const out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
    return decideRestart(code, out);
  }
}
