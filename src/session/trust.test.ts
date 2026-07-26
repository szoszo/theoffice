import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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

  it("does nothing when claude is not initialised yet (no ~/.claude.json to seed)", () => {
    ensureClaudeGatesAccepted(agentDir);
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("survives a corrupt ~/.claude.json without throwing or truncating it", () => {
    writeFileSync(cfgPath(), "{ not json");
    expect(() => ensureClaudeGatesAccepted(agentDir)).not.toThrow();
    expect(readFileSync(cfgPath(), "utf8")).toBe("{ not json");
  });
});
