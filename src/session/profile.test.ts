import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAgentSettings } from "./profile.js";

/**
 * The generated deny-list is the only thing standing between a restricted agent and the rest of the
 * installation, and it is regenerated on every launch so it cannot drift. These tests lock the denies
 * that are NOT expressible in a profile template because they depend on install-specific paths.
 *
 * The agent-home rule matters most once agents run on their own subscriptions: an agent home holds a
 * provider login, so reading a sibling's home hands over that entire account.
 */
describe("writeAgentSettings — runtime filesystem denies", () => {
  let root = "";
  let agentDir = "";
  const cfg = () =>
    ({
      paths: {
        secretsDir: join(root, "secrets"),
        dbFile: join(root, "store", "theoffice.db"),
        vaultKeyFile: join(root, "store", ".vault-key"),
        agentsDir: join(root, "agents"),
      },
    }) as never;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "profile-"));
    agentDir = join(root, "agents", "mancika");
    mkdirSync(agentDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const denies = () =>
    JSON.parse(readFileSync(join(agentDir, ".claude", "settings.json"), "utf8")).permissions.deny as string[];

  it("denies every agent's provider login directory", () => {
    writeAgentSettings(cfg(), { id: "mancika", dir: agentDir, profile: "does-not-exist" } as never);
    expect(denies()).toContain(`Read(${join(root, "agents")}/*/home/**)`);
  });

  it("denies the database AND its backups with one glob", () => {
    // A backup holds the same memories as the live file; denying only the live file was decorative.
    writeAgentSettings(cfg(), { id: "mancika", dir: agentDir, profile: "does-not-exist" } as never);
    const db = join(root, "store", "theoffice.db");
    expect(denies()).toContain(`Read(${db}*)`);
  });

  it("denies all connectors when the named profile is missing (fail-safe, not fail-open)", () => {
    writeAgentSettings(cfg(), { id: "mancika", dir: agentDir, profile: "typo-in-the-name" } as never);
    expect(denies()).toContain("mcp__claude_ai_*");
  });

  it("keeps the profile's own denies alongside the runtime ones", () => {
    const profDir = join(root, "templates", "profiles");
    mkdirSync(profDir, { recursive: true });
    // profile.ts resolves templates from REPO_ROOT, so this only asserts the merge shape via the
    // fail-safe path: whatever the profile contributes must survive next to the path denies.
    writeAgentSettings(cfg(), { id: "mancika", dir: agentDir, profile: "missing" } as never);
    const d = denies();
    expect(d.some((x) => x.startsWith("mcp__"))).toBe(true);
    expect(d.some((x) => x.startsWith("Read("))).toBe(true);
  });

  it("a full-access agent gets no settings file at all, and a stale one is removed", () => {
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
    writeFileSync(join(agentDir, ".claude", "settings.json"), "{}");
    writeAgentSettings(cfg(), { id: "iustinianus", dir: agentDir } as never); // no profile = full access
    expect(existsSync(join(agentDir, ".claude", "settings.json"))).toBe(false);
  });
});
