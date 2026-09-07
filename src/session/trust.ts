import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../logger.js";

const logger = log("trust");

interface ClaudeProject {
  hasTrustDialogAccepted?: boolean;
  [k: string]: unknown;
}
interface ClaudeConfig {
  projects?: Record<string, ClaudeProject>;
  bypassPermissionsModeAccepted?: boolean;
  [k: string]: unknown;
}

/**
 * Pre-accept the TWO interactive gates a freshly-launched `claude` blocks on, so an
 * automated tmux pane boots straight to the prompt instead of sitting on a dialog
 * nobody can answer. Both gates fail the same way: the pane never reaches idle, so
 * `isReady` never passes, so the deliverer can never hand it a message — the agent
 * looks dead while the inbound queue silently piles up (attempts stay 0, no error).
 *
 * 1. Folder trust ("Is this a project you trust?") — per-project
 *    `hasTrustDialogAccepted`. `--dangerously-skip-permissions` does NOT bypass it
 *    (anthropics/claude-code #28506 / #36342).
 * 2. The bypass-permissions disclaimer ("WARNING: Claude Code running in Bypass
 *    Permissions mode … 2. Yes, I accept") — global `bypassPermissionsModeAccepted`.
 *    This one is gated on the flag ALREADY being true at startup and Claude does not
 *    write it back when you accept interactively, so every fresh session re-prompts
 *    until we seed it. Without the flag Claude also silently downgrades the mode
 *    ("bypass requires accepting the disclaimer interactively first"), which would
 *    break `office-say` / git / vault writes even if the pane got past the dialog.
 *
 * We persist the very same keys Claude itself reads from ~/.claude.json. Idempotent,
 * one read-modify-write for both gates, and it preserves every other key in the file
 * (atomic rename — never leaves a half-written ~/.claude.json).
 */
export function ensureClaudeGatesAccepted(agentDir: string, homeOverride?: string): void {
  // Seed into the AGENT's resolved HOME (from buildAgentEnv), not the engine's. An ownAccount:true agent
  // runs with HOME=agent.dir/home, so seeding process.env.HOME would write the gates to the wrong home and
  // the agent would wedge on both startup dialogs (issue #28). Falls back to process.env.HOME for shared-
  // account agents (whose HOME == the engine's), preserving the prior behaviour.
  const home = homeOverride ?? process.env.HOME;
  if (!home) return;
  const cfgPath = join(home, ".claude.json");
  const dir = resolve(agentDir);

  // Gate 2, CURRENT form (Claude Code 2.1.x): the bypass-disclaimer acceptance MOVED from the legacy
  // ~/.claude.json `bypassPermissionsModeAccepted` to ~/.claude/settings.json `skipDangerousModePermissionPrompt`.
  // A current `claude` reads the NEW key, so it must be seeded or a fresh install wedges on the
  // "WARNING … Bypass Permissions mode … Yes, I accept" dialog. Seed it INDEPENDENTLY of ~/.claude.json
  // (which may not exist yet on a fresh box). Atomic, mkdir -p, MERGE (preserve Claude's own settings),
  // and never clobber an unreadable/corrupt settings.json. The legacy key below stays as a fallback for
  // older Claude versions — it is NOT proof the gate is open.
  try {
    const settingsPath = join(home, ".claude", "settings.json");
    let settings: Record<string, unknown> | null = {};
    if (existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
        settings = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        settings = null; // corrupt — do not clobber the owner's real settings
      }
    }
    if (settings === null) {
      logger.warn({ settingsPath }, "~/.claude/settings.json unreadable — left intact, bypass key NOT seeded");
    } else if (settings.skipDangerousModePermissionPrompt !== true) {
      settings.skipDangerousModePermissionPrompt = true;
      mkdirSync(join(home, ".claude"), { recursive: true });
      const tmp = `${settingsPath}.office-${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2));
      renameSync(tmp, settingsPath); // atomic: never leaves a half-written settings.json
      logger.info({ dir }, "seeded skipDangerousModePermissionPrompt in ~/.claude/settings.json");
    }
  } catch (err) {
    logger.warn({ dir, err }, "could not seed ~/.claude/settings.json bypass key (agent may block on the disclaimer)");
  }

  try {
    if (!existsSync(cfgPath)) return; // legacy ~/.claude.json not initialised yet — nothing more to seed here
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as ClaudeConfig;
    cfg.projects ??= {};
    const existing = cfg.projects[dir];
    const needsTrust = !existing?.hasTrustDialogAccepted;
    const needsBypass = cfg.bypassPermissionsModeAccepted !== true;
    if (!needsTrust && !needsBypass) return; // both gates already open — leave Claude's own state alone
    if (needsTrust) cfg.projects[dir] = { ...(existing ?? {}), hasTrustDialogAccepted: true };
    if (needsBypass) cfg.bypassPermissionsModeAccepted = true;
    const tmp = `${cfgPath}.office-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, cfgPath); // atomic: never leaves a half-written ~/.claude.json
    logger.info({ dir, trust: needsTrust, bypass: needsBypass }, "pre-accepted claude startup gates");
  } catch (err) {
    logger.warn({ dir, err }, "could not pre-seed claude startup gates (agent may block on a startup dialog)");
  }
}
