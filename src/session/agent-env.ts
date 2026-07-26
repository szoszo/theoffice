import { join } from "node:path";
import { readEnvFile } from "../env.js";
import type { EngineConfig, AgentDef } from "../types.js";

/**
 * Build the child-process environment for an agent's runtime (claude / codex / gemini — model-agnostic).
 *
 * Ordering is load-bearing: the agent's own `.env` is applied FIRST, then the engine's reserved keys
 * overwrite it. A stray `.env` line (`PATH=`, `HOME=`, `OFFICE_PORT=`) therefore can NOT break office-say
 * or redirect the agent to the wrong tenant/port — the engine always wins those. PATH still leads with
 * `~/.local/bin` (office-say + the provider binary) and keeps any PATH the `.env` contributed after it,
 * so an agent can extend PATH but never replace the bits the runtime depends on.
 */
export function buildAgentEnv(cfg: EngineConfig, agent: AgentDef): Record<string, string> {
  const home = process.env.HOME ?? "";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(readEnvFile(join(agent.dir, ".env")))) env[k] = v;
  const basePath = env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  env.PATH = `${home}/.local/bin:${basePath}`;
  env.TZ = cfg.owner.timezone;
  env.HOME = home;
  env.OFFICE_AGENT_ID = agent.id;
  env.OFFICE_TENANT_ROOT = cfg.paths.tenantRoot;
  env.OFFICE_PORT = String(cfg.web.port);
  return env;
}
