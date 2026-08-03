import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentEnv } from "./agent-env.js";

// The agent's .env is applied FIRST, then the engine's reserved keys overwrite it — so a stray or
// hostile .env line can extend PATH / add its own vars but can NEVER redirect the agent's tenant/port
// or break office-say. This ordering is load-bearing security, not cosmetics.
describe("buildAgentEnv — engine reserved keys win over the agent .env", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentenv-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cfg: any = { owner: { timezone: "Europe/Budapest" }, paths: { tenantRoot: "/tenant" }, web: { port: 3430 } };

  it("a hostile .env cannot override reserved keys, but legit vars survive", () => {
    writeFileSync(
      join(dir, ".env"),
      ["OFFICE_PORT=9999", "OFFICE_AGENT_ID=imposter", "OFFICE_TENANT_ROOT=/evil", "HOME=/tmp/evil", "MY_API_KEY=secret123"].join("\n"),
    );
    const env = buildAgentEnv(cfg, { id: "dwight", dir });
    expect(env.OFFICE_PORT).toBe("3430"); // engine wins, not 9999
    expect(env.OFFICE_AGENT_ID).toBe("dwight"); // engine wins, not imposter
    expect(env.OFFICE_TENANT_ROOT).toBe("/tenant"); // engine wins, not /evil
    expect(env.HOME).toBe(process.env.HOME ?? ""); // engine wins, not /tmp/evil
    expect(env.MY_API_KEY).toBe("secret123"); // legit per-agent var preserved
    expect(env.PATH.startsWith(`${process.env.HOME ?? ""}/.local/bin:`)).toBe(true); // office-say path prepended
  });

  it("a .env PATH extends (kept after ~/.local/bin), never replaces the office-say prefix", () => {
    writeFileSync(join(dir, ".env"), "PATH=/opt/custom/bin");
    const env = buildAgentEnv(cfg, { id: "dwight", dir });
    expect(env.PATH.startsWith(`${process.env.HOME ?? ""}/.local/bin:`)).toBe(true);
    expect(env.PATH.includes("/opt/custom/bin")).toBe(true);
  });
});

/**
 * HOME decides which SUBSCRIPTION an agent works under: the provider CLIs resolve their login and
 * their connectors from it. The default must stay the owner's HOME — flipping a signed-in agent to a
 * fresh one logs it out — and `ownAccount` must be the only thing that changes it.
 */
describe("buildAgentEnv — HOME selects the subscription", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agenthome-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cfg: any = { owner: { timezone: "Europe/Budapest" }, paths: { tenantRoot: "/tenant" }, web: { port: 3430 } };

  it("defaults to the owner's HOME (shared account) when ownAccount is unset", () => {
    const env = buildAgentEnv(cfg, { id: "mancika", dir });
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("gives an ownAccount agent its own HOME inside its working dir", () => {
    const env = buildAgentEnv(cfg, { id: "charly", dir, ownAccount: true });
    expect(env.HOME).toBe(join(dir, "home"));
    expect(env.HOME).not.toBe(process.env.HOME);
  });

  it("keeps PATH on the OWNER's ~/.local/bin even with a separate HOME", () => {
    // office-say and the provider binaries live in the owner's bin; a separate identity must not mean
    // a separate (missing) toolchain, or the agent silently loses its ability to answer on Slack.
    const env = buildAgentEnv(cfg, { id: "charly", dir, ownAccount: true });
    expect(env.PATH.startsWith(`${process.env.HOME}/.local/bin:`)).toBe(true);
  });

  it("a hostile .env cannot claim another account by setting HOME", () => {
    writeFileSync(join(dir, ".env"), "HOME=/home/arnohegedus\n");
    const env = buildAgentEnv(cfg, { id: "charly", dir, ownAccount: true });
    expect(env.HOME).toBe(join(dir, "home")); // engine wins, the .env does not
  });
});
