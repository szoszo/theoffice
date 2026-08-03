import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkTenantSkills } from "./skills-link.js";

/**
 * Issue #21 §5. `skillsDir` has been defined in config.ts and typed as "shared skills dir" since
 * the beginning, and NOTHING consumed it — the only other reference was a test fixture. So
 * `tenant/skills/` sat empty on every live install and all procedural knowledge had to live in
 * CLAUDE.md, which is re-read on every single turn.
 *
 * That is the cost this fixes: a runbook needed once a month sits permanently in context, spending
 * tokens on every message and diluting the rules that matter daily. Skills give progressive
 * disclosure for free — name and one-line description up front, the body loaded only when selected.
 */

let root: string;
const agentDir = () => join(root, "agents", "a1");
const skillsDir = () => join(root, "skills");
const linkPath = () => join(agentDir(), ".claude", "skills");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-skills-"));
  mkdirSync(agentDir(), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("linkTenantSkills", () => {
  it("links tenant/skills into the agent workspace as .claude/skills", () => {
    mkdirSync(skillsDir(), { recursive: true });
    writeFileSync(join(skillsDir(), "runbook.md"), "# how to audit HA");

    linkTenantSkills(skillsDir(), agentDir());

    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    expect(existsSync(join(linkPath(), "runbook.md"))).toBe(true);
  });

  it("is idempotent — a second call on an already-linked workspace is a no-op, not a throw", () => {
    // Runs on every session launch, so EEXIST is the steady state, not an error.
    mkdirSync(skillsDir(), { recursive: true });
    linkTenantSkills(skillsDir(), agentDir());
    expect(() => linkTenantSkills(skillsDir(), agentDir())).not.toThrow();
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
  });

  it("does nothing when the tenant has no skills dir — an install without skills must still launch", () => {
    linkTenantSkills(skillsDir(), agentDir()); // skillsDir does not exist
    expect(existsSync(linkPath())).toBe(false);
  });

  it("NEVER clobbers a real directory an agent already has there", () => {
    // An agent may keep its own private skills. Replacing that with a link would silently delete
    // the operator's files — deleting data to install a convenience is never an acceptable trade.
    mkdirSync(skillsDir(), { recursive: true });
    mkdirSync(linkPath(), { recursive: true });
    writeFileSync(join(linkPath(), "mine.md"), "private skill");

    linkTenantSkills(skillsDir(), agentDir());

    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(false);
    expect(existsSync(join(linkPath(), "mine.md"))).toBe(true); // untouched
  });

  it("repairs a STALE link that points somewhere else", () => {
    // Moving the tenant root would otherwise leave every agent pointing at a path that no longer
    // exists, and a dangling link reads as "no skills" with nothing explaining why.
    mkdirSync(skillsDir(), { recursive: true });
    mkdirSync(join(agentDir(), ".claude"), { recursive: true });
    symlinkSync(join(root, "somewhere-else"), linkPath());

    linkTenantSkills(skillsDir(), agentDir());

    expect(readlinkSync(linkPath())).toBe(skillsDir());
  });
});
