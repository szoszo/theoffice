import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { isValidCron } from "../scheduler/cron.js";

/**
 * Structural validation for the prompt/persona layer (issue #21 §4a). Pure, model-free, filesystem-only
 * lint of the config that determines agent behaviour: scheduled-task definitions and agent directories.
 * The engine reads these at runtime but never checks them, so a bad cron / dangling agent / empty prompt
 * silently no-ops in production. These functions turn that into a caught error — in the vitest suite
 * against fixtures + shipped templates, and (fast-follow) as an operator preflight against a live tenant.
 */

export interface ConfigIssue {
  /** What the issue is about — a task name, a config path, or an agent id. */
  target: string;
  /** The specific field at fault, when applicable. */
  field?: string;
  message: string;
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export interface TaskValidationOpts {
  /**
   * The set of agent ids that exist in the target install. When provided, a task's `agent` must be a
   * member. Omitted for template/fixture validation in CI (there is no live tenant to resolve against),
   * where only the static shape is checked. Supply the real set for a live-tenant preflight.
   */
  knownAgents?: Set<string>;
}

/**
 * Validate ONE scheduled-task directory: `<dir>/task-config.json` (+ optional `SKILL.md` prompt body).
 * Returns [] when the task is well-formed. Does NOT cross-check duplicate names — that is a property of
 * the whole set, see validateScheduledTasks.
 */
export function validateTaskConfigDir(dir: string, opts: TaskValidationOpts = {}): ConfigIssue[] {
  const name = basename(dir);
  const cfgPath = join(dir, "task-config.json");
  if (!existsSync(cfgPath)) return [{ target: name, message: "missing task-config.json" }];

  const parsed = readJson(cfgPath);
  if (!parsed.ok) return [{ target: name, field: "task-config.json", message: `invalid JSON: ${parsed.error}` }];
  if (!isObject(parsed.value)) return [{ target: name, field: "task-config.json", message: "must be a JSON object" }];
  const tc = parsed.value;
  const issues: ConfigIssue[] = [];

  // schedule: required + parseable by the live scheduler's cron.
  if (!isValidCron(tc.schedule)) {
    issues.push({ target: name, field: "schedule", message: `missing or unparseable cron: ${JSON.stringify(tc.schedule)}` });
  }
  // agent: if present must be a non-empty string; if a known-agent set is supplied, must be a member.
  if ("agent" in tc) {
    if (!nonEmptyString(tc.agent)) {
      issues.push({ target: name, field: "agent", message: "agent must be a non-empty string" });
    } else if (opts.knownAgents && !opts.knownAgents.has(tc.agent)) {
      issues.push({ target: name, field: "agent", message: `agent "${tc.agent}" does not exist in this install` });
    }
  }
  // prompt: non-empty, from tc.prompt OR a non-empty SKILL.md alongside the config (loader falls back to it).
  const skillPath = join(dir, "SKILL.md");
  const hasSkill = existsSync(skillPath) && readFileSync(skillPath, "utf8").trim().length > 0;
  if (!nonEmptyString(tc.prompt) && !hasSkill) {
    issues.push({ target: name, field: "prompt", message: "no prompt: task-config.prompt is empty and no non-empty SKILL.md" });
  }
  // enabled: must be present + boolean (the issue requires it explicit, so a fat-fingered omission is caught).
  if (!("enabled" in tc)) {
    issues.push({ target: name, field: "enabled", message: "enabled is required (true/false), and is missing" });
  } else if (typeof tc.enabled !== "boolean") {
    issues.push({ target: name, field: "enabled", message: "enabled must be a boolean" });
  }
  // type: optional, but if present must be a known kind.
  if ("type" in tc && tc.type !== "task" && tc.type !== "heartbeat") {
    issues.push({ target: name, field: "type", message: `type must be "task" or "heartbeat", got ${JSON.stringify(tc.type)}` });
  }
  return issues;
}

/** List immediate subdirectories of `root` (each is one unit — a task dir or an agent dir). [] if absent. */
function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    });
}

/**
 * Validate an entire `scheduled-tasks/` root: every task dir + the cross-task invariant that task names
 * (task-config.name ?? dir name) are unique — a duplicate silently collides on the dedup key at runtime.
 */
export function validateScheduledTasks(root: string, opts: TaskValidationOpts = {}): ConfigIssue[] {
  const dirs = subdirs(root);
  const issues = dirs.flatMap((d) => validateTaskConfigDir(d, opts));
  const seen = new Map<string, string>();
  for (const d of dirs) {
    const cfgPath = join(d, "task-config.json");
    if (!existsSync(cfgPath)) continue;
    const parsed = readJson(cfgPath);
    if (!parsed.ok || !isObject(parsed.value)) continue;
    const taskName = nonEmptyString(parsed.value.name) ? parsed.value.name : basename(d);
    if (seen.has(taskName)) {
      issues.push({ target: taskName, message: `duplicate task name "${taskName}" (dirs ${basename(seen.get(taskName)!)} + ${basename(d)})` });
    } else {
      seen.set(taskName, d);
    }
  }
  return issues;
}

/**
 * Validate ONE agent directory: a parseable `agent.json` object and a present, non-empty `CLAUDE.md`
 * (the persona that is re-read every turn — an empty one means an agent with no rules).
 */
export function validateAgentDir(dir: string): ConfigIssue[] {
  const id = basename(dir);
  const issues: ConfigIssue[] = [];
  const agentJson = join(dir, "agent.json");
  if (!existsSync(agentJson)) {
    issues.push({ target: id, field: "agent.json", message: "missing agent.json" });
  } else {
    const parsed = readJson(agentJson);
    if (!parsed.ok) issues.push({ target: id, field: "agent.json", message: `invalid JSON: ${parsed.error}` });
    else if (!isObject(parsed.value)) issues.push({ target: id, field: "agent.json", message: "must be a JSON object" });
  }
  const claudeMd = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    issues.push({ target: id, field: "CLAUDE.md", message: "missing CLAUDE.md" });
  } else if (readFileSync(claudeMd, "utf8").trim().length === 0) {
    issues.push({ target: id, field: "CLAUDE.md", message: "CLAUDE.md is empty" });
  }
  return issues;
}

/** List agent ids under an `agents/` root — a subdir counts as an agent when it has an agent.json. */
export function listAgentIds(agentsDir: string): string[] {
  return subdirs(agentsDir)
    .filter((d) => existsSync(join(d, "agent.json")))
    .map((d) => basename(d));
}

/** Validate every agent dir under an `agents/` root. */
export function validateAgents(agentsDir: string): ConfigIssue[] {
  return subdirs(agentsDir).flatMap(validateAgentDir);
}
