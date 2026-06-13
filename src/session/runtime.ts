import type { EngineConfig, AgentDef } from "../types.js";
import { log } from "../logger.js";
import { claudeRuntime } from "./claude-runtime.js";
import { codexRuntime } from "./codex-runtime.js";

/**
 * Provider-pluggable agent runtime registry.
 *
 * A "runtime" is the engine that drives one agent: how its tmux session is launched and how a queued
 * prompt is delivered + completed. Today two are wired — "claude" (Claude Code, a persistent TUI we
 * inject into) and "codex" (OpenAI Codex CLI, one `codex exec` subprocess per turn). Both hide behind
 * the SAME interface, so the rest of the engine (launch, deliverer loop, dashboard) is provider-agnostic:
 * flipping an agent's `runtime` flag swaps its whole execution path with no other code change.
 *
 * Adding a third provider (e.g. a local/ollama runtime, or gemini) is a single new module that exports a
 * `Runtime` and registers here — nothing else in the engine needs to know it exists. That is the whole
 * point: someone could stand a fleet up entirely on a non-Claude provider by flipping switches.
 */

const logger = log("runtime");

/** One queued inbound prompt awaiting delivery to an agent. */
export interface QueuedItem {
  id: number;
  agent_id: string;
  source: string;
  prompt: string;
  reply_channel: string | null;
  attempts: number;
}

export interface Runtime {
  /** provider id — matches the agent.json `runtime` value (e.g. "claude", "codex") */
  readonly id: string;
  /** human label for the dashboard provider dropdown */
  readonly label: string;
  /**
   * Known model ids selectable for this provider (UI hint only; empty = the provider's own default).
   * For claude these are the `--model` ids; codex uses the account's model, so it advertises none.
   */
  readonly models: readonly string[];

  /** Launch this agent's tmux session. Returns true if a new session was created. */
  launch(cfg: EngineConfig, agent: AgentDef): boolean;

  /**
   * True if delivery for this agent should be SKIPPED this tick without burning a delivery attempt —
   * an async turn is already in flight, or the runtime is in a transient usage back-off. A persistent-TUI
   * runtime (claude) returns false here and decides readiness inside deliver() from live pane state.
   */
  isBusy(agentId: string): boolean;

  /**
   * Deliver one queued item. The runtime FULLY OWNS the queue bookkeeping for its delivery style —
   * markDelivering / markDelivered / markFailed / requeue — whether that is synchronous pane injection
   * (claude) or an async exec subprocess (codex). The deliverer loop only gates on hasSession + isBusy
   * and then hands the item off here.
   */
  deliver(cfg: EngineConfig, agent: AgentDef, item: QueuedItem): void | Promise<void>;
}

const registry = new Map<string, Runtime>();

export function registerRuntime(rt: Runtime): void {
  registry.set(rt.id, rt);
}

/** The default runtime id when an agent leaves `runtime` unset. */
export const DEFAULT_RUNTIME = "claude";

/** True if `id` names a registered runtime. Used to normalize agent.json on load. */
export function isKnownRuntime(id: string | undefined): boolean {
  return !!id && registry.has(id);
}

/** Resolve a runtime by id, falling back to the default (claude) for unknown/unset ids. */
export function getRuntime(id: string | undefined): Runtime {
  const rt = id ? registry.get(id) : undefined;
  if (id && !rt) logger.warn({ id }, "unknown runtime -> falling back to default");
  return rt ?? registry.get(DEFAULT_RUNTIME)!;
}

/** Resolve the runtime driving a given agent. */
export function runtimeFor(agent: AgentDef): Runtime {
  return getRuntime(agent.runtime);
}

/** Registered providers for the dashboard dropdown (id + label + selectable models). */
export function listRuntimes(): { id: string; label: string; models: readonly string[] }[] {
  return [...registry.values()].map((r) => ({ id: r.id, label: r.label, models: r.models }));
}

// Wire the providers shipped today. New providers register themselves by being imported + added here.
registerRuntime(claudeRuntime);
registerRuntime(codexRuntime);
