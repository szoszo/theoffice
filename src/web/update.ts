import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { REPO_ROOT } from "../config.js";
import { getDb } from "../db/index.js";
import { log } from "../logger.js";
import { recordSetupNotices } from "./setup-notices.js";
import { checkRestartSafety } from "./restart-safety.js";

const logger = log("update");
const BACKUPS_TO_KEEP = 5;
/** The unit this engine runs as — restarted post-update, and the one the blast-radius gate checks. */
const SERVICE_UNIT = "theoffice.service";

function git(args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
}

/**
 * Snapshot the LIVE tenant DB before an update runs (a schema migration during the update could corrupt it
 * and we want a recoverable point). VACUUM INTO writes a clean, WAL-consistent standalone copy — unlike a
 * raw `cp` which would miss un-checkpointed WAL content. Returns the backup path. Keeps the last N.
 */
export function backupDb(): string {
  const db = getDb();
  const dbPath = db.name; // better-sqlite3 exposes the open file path
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // VACUUM INTO throws if the target exists; guarantee a unique name even for two backups in the same ms.
  let backup = `${dbPath}.bak-${stamp}`;
  for (let i = 2; existsSync(backup); i++) backup = `${dbPath}.bak-${stamp}-${i}`;
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  pruneBackups(dbPath);
  return backup;
}

function pruneBackups(dbPath: string): void {
  try {
    const dir = dirname(dbPath);
    const prefix = `${basename(dbPath)}.bak-`;
    const baks = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort(); // ISO stamps sort oldest-first
    for (const f of baks.slice(0, Math.max(0, baks.length - BACKUPS_TO_KEEP))) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* best-effort prune */
      }
    }
  } catch {
    /* best-effort */
  }
}

export interface PendingCommit {
  hash: string;
  subject: string;
  body: string;
}

/** Fetch origin and list commits the local install is behind (HEAD..origin/main). */
export function checkUpdates(): { current: string; behind: number; commits: PendingCommit[]; error?: string } {
  try {
    git(["fetch", "--quiet", "origin"]);
  } catch (e) {
    return { current: "?", behind: 0, commits: [], error: "git fetch failed: " + String(e) };
  }
  const current = git(["rev-parse", "--short", "HEAD"]).trim();
  let raw = "";
  try {
    // unit/record separators so multi-line bodies stay intact
    raw = git(["log", "--no-merges", "--pretty=format:%h%x1f%s%x1f%b%x1e", "HEAD..origin/main"]);
  } catch {
    raw = "";
  }
  const commits = raw
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [hash, subject, body] = c.split("\x1f");
      return { hash: (hash ?? "").trim(), subject: (subject ?? "").trim(), body: (body ?? "").trim() };
    });
  return { current, behind: commits.length, commits };
}

/**
 * Pull + reinstall deps + rebuild, then restart the engine (detached, just after we
 * return so the HTTP response still completes). Agents' tmux sessions survive — the
 * tmux server is a separate unit.
 */
export function applyUpdate(opts?: { discardLocal?: boolean }): {
  ok: boolean;
  output: string;
  dirty?: boolean;
  files?: string[];
} {
  const out: string[] = [];
  const step = (cmd: string, args: string[]) => {
    out.push(`$ ${cmd} ${args.join(" ")}`);
    try {
      out.push(execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim());
    } catch (e: any) {
      out.push("FAILED: " + (e?.stdout || "") + (e?.stderr || "") + String(e?.message || e));
      throw new Error(out.join("\n"));
    }
  };

  // A dirty working tree makes `git pull --ff-only` abort with a cryptic "your local changes would be
  // overwritten" error — the #1 self-host update snag. Detect locally-modified TRACKED files up front
  // (porcelain, untracked excluded) and surface a clear, actionable result instead of the raw git failure.
  const dirtyFiles = git(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).split(" -> ").pop()!.trim())
    .filter(Boolean);
  if (dirtyFiles.length) {
    if (!opts?.discardLocal) {
      return {
        ok: false,
        dirty: true,
        files: dirtyFiles,
        output:
          `Update blocked — you have local changes to:\n  ${dirtyFiles.join("\n  ")}\n\n` +
          `These would be overwritten by the update. Either:\n` +
          `  • use "Discard local changes & update" (saves your edits to git stash, then takes the official version), or\n` +
          `  • run \`git stash\` in a terminal to set them aside, then retry the update.`,
      };
    }
    // Explicit opt-in: stash (NOT destroy) so the user's edits stay recoverable via `git stash pop`.
    step("git", ["stash", "push", "-m", "office-update: auto-stash before pull"]);
  }

  // Rollback point: capture HEAD BEFORE pulling so a failed build/install can hard-reset main instead of
  // leaving a half-updated tree (mirrors the manual deploy discipline).
  const preHead = git(["rev-parse", "HEAD"]).trim();
  out.push(`pre-update HEAD ${preHead}`);

  // Pre-update DB backup. Refuse the update if it fails — we will not run a (possibly schema-changing)
  // update on the live DB without a recoverable snapshot.
  let backupPath: string;
  try {
    backupPath = backupDb();
    out.push(`DB backup -> ${backupPath}`);
  } catch (e) {
    return {
      ok: false,
      output: `Update aborted — pre-update DB backup failed; refusing to run on the live DB without a recoverable snapshot.\n${String((e as Error).message ?? e)}`,
    };
  }

  const home = process.env.HOME ?? "";
  try {
    step("git", ["pull", "--ff-only", "origin", "main"]);
    // ci (not install): reproducible from the lockfile. --include=dev is NOT optional: the engine runs under
    // NODE_ENV=production, npm inherits that as omit=dev, and the very next step needs `tsc` from
    // devDependencies — without the flag the build dies on "tsc: not found" and every update rolls back.
    step("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"]);
    step("npm", ["run", "build"]);
    // The office-say helper lives on PATH (~/.local/bin); recopy it post-build so a changed version ships
    // with the update instead of going stale.
    step("install", ["-m", "0755", join(REPO_ROOT, "scripts", "office-say.sh"), join(home, ".local", "bin", "office-say")]);
  } catch {
    // Any step failed (step() already pushed the FAILED detail to `out`). Roll the tree back to preHead so
    // main is never left half-updated; the DB backup stays for manual restore if needed.
    out.push(`!! update step failed -> rolling back working tree to ${preHead}`);
    try {
      git(["reset", "--hard", preHead]);
      out.push(`rolled back to ${preHead}`);
    } catch (re) {
      out.push("ROLLBACK FAILED (manual fix needed): " + String((re as Error).message ?? re));
    }
    out.push(`DB backup preserved at ${backupPath} (restore: stop engine, cp it over the db, start engine)`);
    return { ok: false, output: out.join("\n") };
  }

  // Record capability setup-notices from the applied commits — reached ONLY on the
  // success path (a failed/rolled-back update returned in the catch above), so we
  // never leave a stale pending notice for a capability that is no longer present.
  // Delivered to the main agent at the next boot; non-fatal if it fails.
  const tenantRoot = process.env.OFFICE_TENANT_ROOT ?? join(REPO_ROOT, "tenant");
  recordSetupNotices(tenantRoot, REPO_ROOT, preHead);

  // MECHANICAL pre-restart gate. If this service and the tmux server share a cgroup, `systemctl restart`
  // SIGTERMs the whole group and every agent session dies with it. The manual version of this check
  // produced three confidently-wrong answers in one day, so the update path runs it itself rather than
  // relying on whoever is deploying to remember. Only a PROVEN-unsafe verdict blocks; "cannot determine"
  // proceeds, because a box with no running fleet must still be updatable.
  const safety = checkRestartSafety(REPO_ROOT, process.env.OFFICE_TMUX_SOCKET ?? "theoffice", SERVICE_UNIT);
  out.push(safety.reason);
  if (!safety.proceed) {
    logger.error({ reason: safety.reason }, "post-update restart REFUSED — would kill the agent fleet");
    out.push(
      `\n!! Code is updated and built, but the engine was NOT RESTARTED, so the RUNNING process is still the old one.\n` +
        `   This is deliberate: restarting would have killed every agent session. Fix the unit, then restart manually.`,
    );
    return { ok: false, output: out.join("\n") };
  }

  // restart shortly after we've returned the response — ONLY on success
  setTimeout(() => {
    try {
      execFileSync("systemctl", ["--user", "restart", SERVICE_UNIT]);
    } catch (e) {
      logger.error({ e }, "post-update restart failed");
    }
  }, 1000);
  return { ok: true, output: out.join("\n") };
}
