import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "../env.js";
import type { EngineConfig, AgentDef } from "../types.js";

/**
 * Where an agent with `ownAccount: true` keeps its provider login. One directory per agent, inside the
 * agent's own working dir, created 0700 so a sibling agent cannot read the credentials off disk.
 */
export function agentHomeDir(agent: AgentDef): string {
  return join(agent.dir, "home");
}

/**
 * Build the child-process environment for an agent's runtime (claude / codex / gemini — model-agnostic).
 *
 * Ordering is load-bearing: the agent's own `.env` is applied FIRST, then the engine's reserved keys
 * overwrite it. A stray `.env` line (`PATH=`, `HOME=`, `OFFICE_PORT=`) therefore can NOT break office-say
 * or redirect the agent to the wrong tenant/port — the engine always wins those.
 *
 * HOME decides WHICH SUBSCRIPTION the agent works under, because the provider CLIs resolve their login,
 * their connectors and their settings from it:
 *   - default (`ownAccount` unset): every agent shares the owner's HOME — one account, one set of
 *     connectors, one rate limit. This stays the default because flipping a signed-in agent to a fresh
 *     HOME would log it out until someone signs in again.
 *   - `ownAccount: true`: the agent gets its own HOME and can be signed in to a DIFFERENT Claude or
 *     ChatGPT account — its own mailbox, its own Drive, its own limits. That isolation IS the feature:
 *     what those connectors can reach is decided by the account the agent signed into, and nothing else
 *     on this machine shares it.
 *
 * PATH keeps pointing at the OWNER's ~/.local/bin either way, because office-say and the provider
 * binaries live there — an agent gets its own identity, not its own copy of the tooling.
 */
export function buildAgentEnv(cfg: EngineConfig, agent: AgentDef): Record<string, string> {
  const ownerHome = process.env.HOME ?? "";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(readEnvFile(join(agent.dir, ".env")))) env[k] = v;
  const basePath = env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  env.PATH = `${ownerHome}/.local/bin:${basePath}`;
  env.TZ = cfg.owner.timezone;

  let home = ownerHome;
  if (agent.ownAccount) {
    home = agentHomeDir(agent);
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } catch {
      /* best-effort — an unusable HOME surfaces loudly in the CLI's own startup output */
    }
  }
  env.HOME = home;

  env.OFFICE_AGENT_ID = agent.id;
  env.OFFICE_TENANT_ROOT = cfg.paths.tenantRoot;
  env.OFFICE_PORT = String(cfg.web.port);
  return env;
}
