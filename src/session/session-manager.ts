import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { hasSession, sessionNameFor } from "./tmux.js";
import { listQueued } from "../queue/index.js";
import { loadAgents } from "../agents.js";
import { runtimeFor } from "./runtime.js";

const logger = log("session");

const DELIVERER_TICK_MS = 2000; // queue drain cadence

// Re-exported so existing importers (the web server) keep a stable import path.
export { sessionNameFor } from "./tmux.js";

/**
 * Launch an agent via its configured runtime. The runtime ("claude" default, "codex", or any future
 * provider) owns the actual spawn; this is just the provider-agnostic entry point.
 */
export function launchAgent(cfg: EngineConfig, agent: AgentDef): boolean {
  return runtimeFor(agent).launch(cfg, agent);
}

/**
 * The single deliverer loop. Drains the inbound queue: for each queued item whose target session is
 * running, hand it to that agent's runtime to deliver. The runtime owns readiness gating and ALL queue
 * bookkeeping (markDelivered / markFailed / requeue); this loop only skips agents that are not running
 * or busy, so one stuck or in-flight agent never blocks delivery for the others.
 */
export function startDeliverer(cfg: EngineConfig): () => void {
  const socket = cfg.tmux.socket;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const byId = new Map(loadAgents(cfg).map((a) => [a.id, a]));
      for (const item of listQueued()) {
        const session = sessionNameFor(item.agent_id);
        if (!hasSession(socket, session)) continue; // agent not running -> leave queued
        const agent = byId.get(item.agent_id);
        if (!agent) continue; // unknown agent (roster changed) -> leave queued
        const rt = runtimeFor(agent);
        if (rt.isBusy(item.agent_id)) continue; // async turn in flight / usage back-off -> leave queued
        await rt.deliver(cfg, agent, item); // runtime owns readiness + queue bookkeeping
      }
    } catch (err) {
      logger.error({ err }, "deliverer tick error");
    }
  };

  const handle = setInterval(() => void tick(), DELIVERER_TICK_MS);
  logger.info({ socket, tickMs: DELIVERER_TICK_MS }, "deliverer started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
