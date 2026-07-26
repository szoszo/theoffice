import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { ConfigIssue } from "./validate-config.js";

/**
 * Static prompt-layer evals (issue #21 §4b, adapted to our architecture). We can't run behavioural
 * fixture evals — the runtime fires prompts into a live TUI and never captures a response — so instead we
 * regression-guard the SHIPPED prompt/persona artifacts themselves, deterministically and with no model:
 *
 *  - PORTABILITY: a shipped template/persona must be tenant-agnostic (no owner name, no agent-id literals,
 *    no absolute install paths). This locks the exact marveen/Szoszo leak the grooming fast-follow fixed.
 *  - SAFETY: a shipped state-mutating task prompt must still contain its propose-not-destroy + card-text-
 *    is-data guardrails. Locks the injection-hardening against a future silent reword.
 *
 * These complement (do not duplicate) the structural lint in validate-config.ts and the #3 preamble-cap
 * lock in goals.test.ts.
 */

/**
 * Tenant-specific identifiers that must NEVER appear in a shipped (tenant-agnostic) template or persona.
 * Explicit + minimal + documented so it is trivially extensible; deliberately NOT derived at runtime
 * (there is no live tenant in CI to derive from). Matched case-insensitively on WORD BOUNDARIES so an
 * agent-id like "jim" can't false-positive inside an unrelated word. Extend this list as the fleet grows.
 */
export const TENANT_IDENTIFIERS: string[] = [
  "Szoszo", // owner display name
  // known agent-id literals
  "marveen", "dwight", "toby", "jim", "pam", "cfo", "pete", "ryan", "clark", "darryl",
  // tenant email(s)
  "k.szoszo@gmail.com",
];

/** Absolute / home-relative install paths that leak a machine-specific layout into a shipped artifact. */
const ABSOLUTE_PATH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\/opt\//, label: "/opt/ path" },
  { re: /\/home\//, label: "/home/ path" },
  { re: /(^|[\s(])~\//m, label: "~/ home path" },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Scan one shipped artifact's text for tenant leaks: any denylisted identifier (word-boundary, case-
 * insensitive) or absolute install path. `target` is the artifact path/name for the reported issue.
 */
export function checkTenantLeaks(target: string, text: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const id of TENANT_IDENTIFIERS) {
    // \b doesn't sit against an email's dot/@, so match either a word-boundary token or the literal email.
    const re = id.includes("@") ? new RegExp(escapeRe(id), "i") : new RegExp(`\\b${escapeRe(id)}\\b`, "i");
    if (re.test(text)) issues.push({ target, field: "tenant-leak", message: `contains tenant-specific identifier "${id}"` });
  }
  for (const { re, label } of ABSOLUTE_PATH_PATTERNS) {
    if (re.test(text)) issues.push({ target, field: "tenant-leak", message: `contains an absolute install path (${label})` });
  }
  return issues;
}

/**
 * The guardrail phrases a shipped STATE-MUTATING task prompt must retain. If a future edit silently drops
 * one, this fails — turning "the safety wording must not be weakened" into a permanent test.
 */
const MUTATING_SAFETY_ANCHORS: Array<{ re: RegExp; what: string }> = [
  { re: /never\s+delete/i, what: "never-delete/archive/merge rule" },
  // Must be the specific propose-not-destroy phrasing ("... it never destroys"), NOT a bare "propose":
  // a loose /propose/ can be satisfied by unrelated text ("I might propose a new priority") while the
  // actual no-destroy guarantee has been stripped — which would make this teeth-check vacuous.
  { re: /never\s+destroys?/i, what: 'propose-not-destroy framing (the specific "never destroys" phrasing)' },
  { re: /not\s+instructions|do\s+not\s+act\s+on|is\s+just\s+text/i, what: "card-text-is-data injection hardening" },
];

/** Shipped scheduled tasks whose prompt MUTATES state (kanban) and therefore must carry the guardrails. */
export const SHIPPED_MUTATING_TASKS = ["kanban-grooming"];

/** Assert a mutating task's prompt still contains every required safety anchor. */
export function checkMutatingTaskSafety(target: string, promptText: string): ConfigIssue[] {
  return MUTATING_SAFETY_ANCHORS.filter((a) => !a.re.test(promptText)).map((a) => ({
    target,
    field: "safety",
    message: `mutating-task prompt is missing its ${a.what}`,
  }));
}

/** A shipped task-config must NOT hardcode a tenant-specific `agent` (portability — see the grooming fix). */
export function checkTaskConfigNoHardcodedAgent(target: string, configText: string): ConfigIssue[] {
  let obj: unknown;
  try { obj = JSON.parse(configText); } catch { return []; } // JSON validity is validate-config's job
  if (obj && typeof obj === "object" && !Array.isArray(obj) && "agent" in (obj as Record<string, unknown>)) {
    return [{ target, field: "agent", message: "shipped task-config hardcodes an `agent` (must be omitted so it defaults to the tenant's mainAgentId)" }];
  }
  return [];
}

function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).map((n) => join(root, n)).filter((p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  });
}

/**
 * Validate the whole shipped prompt/persona surface under a repo root: the base persona template, and
 * every shipped scheduled-task's task-config.json + SKILL.md. Returns [] when everything is portable +
 * (for mutating tasks) still carries its safety guardrails.
 */
export function validateShippedPromptLayer(repoRoot: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  // Base persona template every scaffolded agent inherits.
  const persona = join(repoRoot, "templates", "product", "agent.CLAUDE.md");
  if (existsSync(persona)) {
    const text = readFileSync(persona, "utf8");
    if (!text.trim()) issues.push({ target: "agent.CLAUDE.md", message: "base persona template is empty" });
    issues.push(...checkTenantLeaks("agent.CLAUDE.md", text));
  }

  // Operator goals example (issue #21 §3) — a shipped, seeded artifact, so it too must be tenant-agnostic.
  const goalsExample = join(repoRoot, "tenant", "GOALS.md.example");
  if (existsSync(goalsExample)) {
    issues.push(...checkTenantLeaks("GOALS.md.example", readFileSync(goalsExample, "utf8")));
  }

  // Shipped scheduled-task templates: portability of both files, no hardcoded agent, and safety anchors
  // for the ones that mutate state.
  const tasksRoot = join(repoRoot, "templates", "scheduled-tasks");
  for (const dir of subdirs(tasksRoot)) {
    const name = basename(dir);
    const cfgPath = join(dir, "task-config.json");
    const skillPath = join(dir, "SKILL.md");
    if (existsSync(cfgPath)) {
      const cfgText = readFileSync(cfgPath, "utf8");
      issues.push(...checkTenantLeaks(`${name}/task-config.json`, cfgText));
      issues.push(...checkTaskConfigNoHardcodedAgent(`${name}/task-config.json`, cfgText));
    }
    if (existsSync(skillPath)) {
      const skillText = readFileSync(skillPath, "utf8");
      issues.push(...checkTenantLeaks(`${name}/SKILL.md`, skillText));
      if (SHIPPED_MUTATING_TASKS.includes(name)) {
        issues.push(...checkMutatingTaskSafety(`${name}/SKILL.md`, skillText));
      }
    }
  }
  return issues;
}
