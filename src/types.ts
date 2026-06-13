/** Shared types for The Office engine. */

export type MemoryTier = "hot" | "warm" | "cold" | "shared";
export type KanbanStatus = "planned" | "in_progress" | "waiting" | "done";
export type Priority = "low" | "normal" | "high" | "urgent";
export type MessageStatus = "pending" | "delivered" | "done" | "failed";
export type QueueSource = "channel" | "scheduler" | "bus" | "manual";
export type QueueStatus = "queued" | "delivering" | "delivered" | "failed";
export type ScheduledTaskType = "task" | "heartbeat";

/** A single agent persona, loaded from tenant/agents/<id>/. NOT hardcoded in engine. */
export interface AgentDef {
  id: string;
  displayName: string;
  /** absolute path to this agent's working dir (where its `claude` runs) */
  dir: string;
  model?: string;
  enabled: boolean;
  /**
   * This agent's OWN Slack identity — a distinct bot the owner can DM directly
   * ("CFO Charly", "Logistics Lenny"). Each agent = its own Slack app, so:
   *  - appToken (xapp-…) opens one Socket-Mode connection for THIS app
   *  - botToken (xoxb-…) posts replies AS this agent (its name + avatar)
   *  - botUserId lets us ignore the agent's own echoed messages
   * One ingest daemon owns one socket per app, so there is no event-splitting.
   */
  slack?: { appToken?: string; botToken?: string; botUserId?: string };
  /**
   * Slack user ids (besides the owner) allowed to DM this agent. The owner is
   * ALWAYS allowed. If this list is empty AND an owner is configured, the agent
   * is owner-only (secure by default). Shared agents (e.g. Ryan↔Gergő,
   * Dwight↔wife) list the external person's id here.
   */
  allowFrom?: string[];
  /** security profile name (drives the connector deny-list); default = full access */
  profile?: string;
  /**
   * Which terminal-agent runtime drives this agent — the provider id of a registered runtime
   * (see src/session/runtime.ts). "claude" (Claude Code, the default) and "codex" (OpenAI Codex CLI)
   * ship today; the registry is provider-pluggable so a future "local"/"gemini" runtime is one module.
   * Selects the spawn + delivery path ONLY — Slack identity, office-say, memory and inter-agent routing
   * are model-agnostic and identical across providers. An unset or unknown value resolves to the default
   * (claude), so existing agents are unaffected. This is the one-line revert flag (agent.json): flip the
   * provider + restart = instant runtime swap.
   */
  runtime?: string;
}

/** Effective, fully-resolved engine config = deepMerge(platform, product, tenant). */
export interface EngineConfig {
  mainAgentId: string;
  paths: PathsConfig;
  web: WebConfig;
  tmux: TmuxConfig;
  owner: OwnerConfig;
  channel: ChannelConfig;
}

export interface PathsConfig {
  /** the single writable tenant root; everything tenant-specific hangs off this */
  tenantRoot: string;
  storeDir: string;
  dbFile: string;
  agentsDir: string;
  secretsDir: string;
  /** file-based scheduled tasks (cron) — source of truth */
  scheduledTasksDir: string;
  /** shared skills dir (read-only to engine) */
  skillsDir: string;
  vaultKeyFile: string;
  dashboardTokenFile: string;
}

export interface WebConfig {
  host: string;
  port: number;
}

export interface TmuxConfig {
  /** dedicated tmux server socket name (`tmux -L <socket>`) — isolates our fleet */
  socket: string;
}

export interface OwnerConfig {
  displayName: string;
  /** Slack user id of the human owner (replaces the old hardcoded Telegram chat id) */
  slackUserId?: string;
  locale: string;
  timezone: string;
}

export interface ChannelConfig {
  provider: "slack" | "none";
  /** workspace-level Socket Mode app token (xapp-...) — value lives in secrets, not config */
  appTokenRef?: string;
  /** default bot token ref for outbound when an agent has no own token */
  botTokenRef?: string;
}
