import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureClaudeGatesAccepted } from "./trust.js";

/**
 * These guard the two startup gates that silently wedge an agent: if either regresses,
 * a fresh pane sits on a dialog and the inbound queue piles up with zero attempts and
 * zero errors — the failure mode that is hardest to notice from the logs.
 */
let home: string;
let agentDir: string;
const realHome = process.env.HOME;

const cfgPath = () => join(home, ".claude.json");
const readCfg = () => JSON.parse(readFileSync(cfgPath(), "utf8"));
const writeCfg = (o: unknown) => writeFileSync(cfgPath(), JSON.stringify(o, null, 2));
const settingsPath = () => join(home, ".claude", "settings.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "office-trust-"));
  agentDir = join(home, "tenant", "agents", "iustinianus");
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("ensureClaudeGatesAccepted", () => {
  it("seeds BOTH gates: per-project trust and the global bypass disclaimer", () => {
    writeCfg({ projects: {} });
    ensureClaudeGatesAccepted(agentDir);
    const cfg = readCfg();
    expect(cfg.projects[agentDir].hasTrustDialogAccepted).toBe(true);
    expect(cfg.bypassPermissionsModeAccepted).toBe(true);
  });

  it("seeds bypass even when the folder is already trusted (the regression that wedged the agent)", () => {
    writeCfg({ projects: { [agentDir]: { hasTrustDialogAccepted: true } } });
    ensureClaudeGatesAccepted(agentDir);
    expect(readCfg().bypassPermissionsModeAccepted).toBe(true);
  });

  it("preserves unrelated keys and other projects", () => {
    writeCfg({
      numStartups: 7,
      oauthAccount: { emailAddress: "a@b.c" },
      projects: { "/some/other": { hasTrustDialogAccepted: false, history: [1, 2] } },
    });
    ensureClaudeGatesAccepted(agentDir);
    const cfg = readCfg();
    expect(cfg.numStartups).toBe(7);
    expect(cfg.oauthAccount).toEqual({ emailAddress: "a@b.c" });
    expect(cfg.projects["/some/other"]).toEqual({ hasTrustDialogAccepted: false, history: [1, 2] });
    expect(cfg.projects[agentDir].hasTrustDialogAccepted).toBe(true);
  });

  it("is idempotent and leaves no temp files behind", () => {
    writeCfg({ projects: {} });
    ensureClaudeGatesAccepted(agentDir);
    const first = readFileSync(cfgPath(), "utf8");
    ensureClaudeGatesAccepted(agentDir);
    expect(readFileSync(cfgPath(), "utf8")).toBe(first);
    expect(readdirSync(home).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  // CC 2.1.x moved bypass-disclaimer acceptance to ~/.claude/settings.json:skipDangerousModePermissionPrompt.
  // The legacy ~/.claude.json key alone no longer stops the disclaimer, so a fresh install wedges on it.
  it("seeds skipDangerousModePermissionPrompt in ~/.claude/settings.json, creating the file when missing", () => {
    writeCfg({ projects: {} });
    ensureClaudeGatesAccepted(agentDir);
    expect(existsSync(settingsPath())).toBe(true);
    expect(readSettings().skipDangerousModePermissionPrompt).toBe(true);
  });

  it("seeds the new bypass key even when ~/.claude.json is absent (fresh install — the Legoza case)", () => {
    // fresh box: no ~/.claude.json yet, but the disclaimer must still be pre-accepted
    ensureClaudeGatesAccepted(agentDir);
    expect(existsSync(cfgPath())).toBe(false); // we do not fabricate ~/.claude.json
    expect(readSettings().skipDangerousModePermissionPrompt).toBe(true); // but the operative new key IS seeded
  });

  it("merges the new key into an existing settings.json, preserving Claude's own keys", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark", model: "opus", permissions: { allow: ["x"] } }, null, 2));
    writeCfg({ projects: {} });
    ensureClaudeGatesAccepted(agentDir);
    const s = readSettings();
    expect(s.skipDangerousModePermissionPrompt).toBe(true);
    expect(s.theme).toBe("dark");
    expect(s.model).toBe("opus");
    expect(s.permissions).toEqual({ allow: ["x"] });
  });

  it("does not fabricate ~/.claude.json when it is absent (only settings.json is seeded there)", () => {
    ensureClaudeGatesAccepted(agentDir);
    expect(existsSync(cfgPath())).toBe(false);
  });

  // Issue #28: an ownAccount:true agent runs with its OWN HOME (agent.dir/home), so the gates must be
  // seeded into THAT home (2nd arg), not the engine's process.env.HOME — else the agent reads un-seeded
  // gates and wedges on both dialogs.
  it("seeds into the RESOLVED home passed as the 2nd arg, not process.env.HOME", () => {
    const engineHome = home; // beforeEach temp == process.env.HOME
    const agentHome = mkdtempSync(join(tmpdir(), "office-agenthome-"));
    try {
      ensureClaudeGatesAccepted(agentDir, agentHome);
      // the new bypass key lands in the AGENT's home
      expect(existsSync(join(agentHome, ".claude", "settings.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(agentHome, ".claude", "settings.json"), "utf8")).skipDangerousModePermissionPrompt).toBe(true);
      // and NOT in the engine home
      expect(existsSync(join(engineHome, ".claude", "settings.json"))).toBe(false);
    } finally {
      rmSync(agentHome, { recursive: true, force: true });
    }
  });

  it("survives a corrupt ~/.claude.json without throwing or truncating it", () => {
    writeFileSync(cfgPath(), "{ not json");
    expect(() => ensureClaudeGatesAccepted(agentDir)).not.toThrow();
    expect(readFileSync(cfgPath(), "utf8")).toBe("{ not json");
  });
});
