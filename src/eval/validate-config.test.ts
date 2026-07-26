import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  validateTaskConfigDir,
  validateScheduledTasks,
  validateAgentDir,
  validateAgents,
  listAgentIds,
} from "./validate-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

/** Write a scheduled-task dir; `config` is the task-config.json object, `skill` an optional SKILL.md body. */
function writeTask(root: string, name: string, config: unknown, skill?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task-config.json"), typeof config === "string" ? config : JSON.stringify(config));
  if (skill !== undefined) writeFileSync(join(dir, "SKILL.md"), skill);
  return dir;
}
function writeAgent(root: string, id: string, agentJson: unknown, claudeMd?: string | null): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  if (agentJson !== undefined) writeFileSync(join(dir, "agent.json"), typeof agentJson === "string" ? agentJson : JSON.stringify(agentJson));
  if (claudeMd !== null) writeFileSync(join(dir, "CLAUDE.md"), claudeMd ?? "# Persona\nrules");
  return dir;
}

const GOOD = { schedule: "0 8 * * *", agent: "home", type: "heartbeat", enabled: true };

describe("validateTaskConfigDir (issue #21 §4a)", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "eval-task-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("passes a well-formed task (prompt via SKILL.md)", () => {
    const dir = writeTask(root, "ok", GOOD, "do the thing");
    expect(validateTaskConfigDir(dir)).toEqual([]);
  });

  it("flags an unparseable cron", () => {
    const dir = writeTask(root, "badcron", { ...GOOD, schedule: "not a cron" }, "p");
    const issues = validateTaskConfigDir(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "schedule" });
  });

  it("flags a missing schedule", () => {
    const { schedule, ...noSched } = GOOD;
    const dir = writeTask(root, "nosched", noSched, "p");
    expect(validateTaskConfigDir(dir).some((i) => i.field === "schedule")).toBe(true);
  });

  it("flags an agent not in the known set (live-tenant mode)", () => {
    const dir = writeTask(root, "ghost", { ...GOOD, agent: "nobody" }, "p");
    const issues = validateTaskConfigDir(dir, { knownAgents: new Set(["home", "hermes"]) });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "agent" });
    expect(issues[0]!.message).toContain("nobody");
  });

  it("does NOT check agent existence in template mode (no known set supplied)", () => {
    const dir = writeTask(root, "tmpl", { ...GOOD, agent: "marveen" }, "p");
    expect(validateTaskConfigDir(dir)).toEqual([]); // agent-existence skipped when no knownAgents
  });

  it("flags a present-but-empty agent field", () => {
    const dir = writeTask(root, "emptyagent", { ...GOOD, agent: "  " }, "p");
    expect(validateTaskConfigDir(dir, { knownAgents: new Set(["home"]) }).some((i) => i.field === "agent")).toBe(true);
  });

  it("flags no prompt (empty task-config.prompt AND no SKILL.md)", () => {
    const dir = writeTask(root, "noprompt", GOOD); // no SKILL.md written
    expect(validateTaskConfigDir(dir).some((i) => i.field === "prompt")).toBe(true);
  });

  it("accepts a prompt inline in task-config (no SKILL.md needed)", () => {
    const dir = writeTask(root, "inline", { ...GOOD, prompt: "inline prompt" });
    expect(validateTaskConfigDir(dir)).toEqual([]);
  });

  it("flags an empty SKILL.md as no prompt", () => {
    const dir = writeTask(root, "emptyskill", GOOD, "   \n  ");
    expect(validateTaskConfigDir(dir).some((i) => i.field === "prompt")).toBe(true);
  });

  it("flags a missing enabled", () => {
    const { enabled, ...noEnabled } = GOOD;
    const dir = writeTask(root, "noenabled", noEnabled, "p");
    expect(validateTaskConfigDir(dir).some((i) => i.field === "enabled")).toBe(true);
  });

  it("flags a non-boolean enabled", () => {
    const dir = writeTask(root, "strenabled", { ...GOOD, enabled: "true" }, "p");
    expect(validateTaskConfigDir(dir).some((i) => i.field === "enabled")).toBe(true);
  });

  it("flags an unknown type", () => {
    const dir = writeTask(root, "badtype", { ...GOOD, type: "cron-thing" }, "p");
    expect(validateTaskConfigDir(dir).some((i) => i.field === "type")).toBe(true);
  });

  it("flags invalid JSON", () => {
    const dir = writeTask(root, "badjson", "{ not json", "p");
    const issues = validateTaskConfigDir(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/invalid JSON/);
  });

  it("flags a non-object config", () => {
    const dir = writeTask(root, "arr", "[1,2,3]", "p");
    expect(validateTaskConfigDir(dir)[0]!.message).toMatch(/must be a JSON object/);
  });

  it("flags a missing task-config.json", () => {
    const dir = join(root, "empty");
    mkdirSync(dir);
    expect(validateTaskConfigDir(dir)[0]!.message).toMatch(/missing task-config.json/);
  });
});

describe("validateScheduledTasks — cross-task duplicate names", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "eval-root-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("flags two tasks resolving to the same name", () => {
    writeTask(root, "a", { ...GOOD, name: "dupe" }, "p");
    writeTask(root, "b", { ...GOOD, name: "dupe" }, "p");
    const issues = validateScheduledTasks(root);
    expect(issues.some((i) => /duplicate task name/.test(i.message))).toBe(true);
  });

  it("no duplicate flag for distinct names", () => {
    writeTask(root, "a", { ...GOOD, name: "one" }, "p");
    writeTask(root, "b", { ...GOOD, name: "two" }, "p");
    expect(validateScheduledTasks(root).some((i) => /duplicate/.test(i.message))).toBe(false);
  });

  it("returns [] for an absent root (nothing to validate)", () => {
    expect(validateScheduledTasks(join(root, "nope"))).toEqual([]);
  });
});

describe("validateAgentDir / validateAgents / listAgentIds", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "eval-agent-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("passes a well-formed agent dir", () => {
    const dir = writeAgent(root, "home", { displayName: "Home" }, "# Home\nrules here");
    expect(validateAgentDir(dir)).toEqual([]);
  });

  it("flags a missing agent.json", () => {
    const dir = writeAgent(root, "noconf", undefined, "persona");
    expect(validateAgentDir(dir).some((i) => i.field === "agent.json")).toBe(true);
  });

  it("flags invalid agent.json", () => {
    const dir = writeAgent(root, "badconf", "{bad", "persona");
    expect(validateAgentDir(dir).some((i) => i.field === "agent.json" && /invalid JSON/.test(i.message))).toBe(true);
  });

  it("flags a missing CLAUDE.md", () => {
    const dir = writeAgent(root, "nopersona", { displayName: "X" }, null);
    expect(validateAgentDir(dir).some((i) => i.field === "CLAUDE.md")).toBe(true);
  });

  it("flags an empty CLAUDE.md", () => {
    const dir = writeAgent(root, "emptypersona", { displayName: "X" }, "   \n");
    expect(validateAgentDir(dir).some((i) => i.field === "CLAUDE.md" && /empty/.test(i.message))).toBe(true);
  });

  it("listAgentIds returns only dirs with an agent.json", () => {
    writeAgent(root, "real", { displayName: "R" }, "p");
    mkdirSync(join(root, "not-an-agent")); // no agent.json
    expect(listAgentIds(root).sort()).toEqual(["real"]);
  });

  it("validateAgents walks every agent dir", () => {
    writeAgent(root, "good", { displayName: "G" }, "p");
    writeAgent(root, "bad", "{broken", "p");
    const issues = validateAgents(root);
    expect(issues.some((i) => i.target === "bad")).toBe(true);
    expect(issues.some((i) => i.target === "good")).toBe(false);
  });
});

// The real regression gate: every scheduled-task template the repo SHIPS must be structurally valid, so a
// fresh install never seeds a broken default. Template mode (no knownAgents) — agent resolution is a
// live-tenant concern, not a repo-CI one.
describe("shipped templates are structurally valid", () => {
  it("every templates/scheduled-tasks/* passes validation", () => {
    const issues = validateScheduledTasks(join(repoRoot, "templates", "scheduled-tasks"));
    expect(issues).toEqual([]);
  });
});
