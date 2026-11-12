/** Shared types for The Office engine. */

export type MemoryTier = "hot" | "warm" | "cold" | "shared";
export type KanbanStatus = "planned" | "in_progress" | "waiting" | "done";
export type Priority = "low" | "normal" | "high" | "urgent";
export type MessageStatus = "pending" | "delivered" | "done" | "failed";
export type QueueSource = "channel" | "scheduler" | "bus" | "manual" | "system";
export type QueueStatus = "queued" | "delivering" | "delivered" | "failed";
export type ScheduledTaskType = "task" | "heartbeat";

/** A single agent persona, loaded from tenant/agents/<id>/. NOT hardcoded in engine. */
export interface AgentDef {
  id: string;
  displayName: string;
  /** absolute path to this agent's working dir (where its `claude` runs) */
  dir: string;
  model?: string;
  /**
   * Claude "thinking effort" for this agent (low | medium | high | xhigh | max), passed as --effort at
   * launch. Claude runtime only; ignored by codex/gemini. Unset = whatever the CLI defaults to.
   * An unknown value normalizes away to unset (see session/effort.ts) so a typo can't block a launch.
   */
  effort?: string;
  enabled: boolean;
  /**
   * This agent's OWN Slack identity — a distinct bot the owner can DM directly
   *. Each agent = its own Slack app, so:
   *  - appToken (xapp-…) opens one Socket-Mode connection for THIS app
   *  - botToken (xoxb-…) posts replies AS this agent (its name + avatar)
   *  - botUserId lets us ignore the agent's own echoed messages
   * One ingest daemon owns one socket per app, so there is no event-splitting.
   */
  slack?: { appToken?: string; botToken?: string; botUserId?: string };
  /**
   * Slack user ids (besides the owner) allowed to DM this agent. The owner is
   * ALWAYS allowed. If this list is empty AND an owner is configured, the agent
   * is owner-only (secure by default). Shared agents (e.g. a work agent shared with a colleague,
   * a home agent shared with a partner) list the external person's id here.
   */
  allowFrom?: string[];
  /** security profile name (drives the connector deny-list); default = full access */
  profile?: string;
  /**
   * Run this agent under its OWN provider account instead of the owner's.
   *
   * Unset (default): the agent shares the owner's HOME, therefore the owner's Claude/ChatGPT login,
   * connectors and rate limit. Set to true: the agent gets its own HOME (`<agent.dir>/home`, 0700) and
   * must be signed in separately — after which its connectors see THAT account's mailbox and Drive,
   * and its usage counts against THAT subscription.
   *
   * This is the switch that makes several subscriptions usable side by side, and it is also the
   * isolation boundary between them: no agent may read another agent's home (enforced in
   * session/profile.ts). Flipping it on an agent that is already signed in logs that agent out until
   * someone signs in again under the new HOME — so migrate one agent at a time, deliberately.
   */
  ownAccount?: boolean;
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
  /** Short role one-liner shown on the dashboard agent card (e.g. "CEO", "Infra & QA"). Optional. */
  role?: string;
  /** Per-agent identity color (hex) for the dashboard — monogram coin, kanban left-border, author
   * chips, usage bars. Optional; the dashboard falls back to a deterministic palette when unset. */
  color?: string;
}

/** Effective, fully-resolved engine config = deepMerge(platform, product, tenant). */
export interface EngineConfig {
  mainAgentId: string;
  paths: PathsConfig;
  /** optional absolute path of the clean-reset orchestrator; default <tenantRoot>/tools/clean-reset/clean_reset.py */
  cleanResetScript?: string;
  /** scheduled-task completion: runs carry an id + completion instruction; unfinished `task` runs alarm the main agent once (heartbeats never) */
  taskCompletion?: { enabled?: boolean; alarm?: boolean; alarmAfterMin?: number; alarmMaxAgeH?: number };
  /** quota guard: defer BACKGROUND (heartbeat) work when the Claude quota is nearly spent. Off by default; shadow mode logs what it would defer, enforce mode defers. Owner-facing work always runs; any unknown state fails open. */
  quotaGuard?: { enabled?: boolean; mode?: "shadow" | "enforce"; deferAtPercent?: number; nearResetPercent?: number; maxDeferMin?: number; credentialsFile?: string };
  /** several Claude plans: move the fleet to another when the active one is spent. mode "observe" (default) only reports; "act" swaps the live credentials file. */
  claudePlans?: { mode?: "observe" | "act"; rotateAtPercent?: number; plans: { id: string; credentialsFile: string }[] };
  /** briefing-board section keys this tenant accepts (replaces the built-in default list) */
  briefingSections?: string[];
  /** extra identifiers the shipped-template leak check must reject (owner nickname, private repo names ...) */
  tenantIdentifiers?: string[];
  /** extra health-deny regex fragments for the briefing board (tenant's own medication names etc.) */
  briefingHealthDenyExtra?: string[];
  /** codex/gemini conversation roll-over: a fresh conversation at `maxTurns` resumed turns (default 60) or past `rolloverFraction` of the context window (default 0.7), whichever comes first */
  execSessions?: { maxTurns?: number; rolloverFraction?: number };
  web: WebConfig;
  tmux: TmuxConfig;
  owner: OwnerConfig;
  channel: ChannelConfig;
  /**
   * Optional scoped OCR trigger (document portal). When set, a bot message in `channelId` carrying
   * the matching `secret` (and a valid UUID) is the ONLY bot message accepted by the Slack ingest — routed
   * as a data-only re-OCR wake to `agentId`. Unset = the feature is inert and the bot-drop is unchanged.
   */
  ocrSignal?: OcrSignalConfig;
}

export interface OcrSignalConfig {
  /** the dedicated Slack channel id whose bot posts are treated as OCR triggers */
  channelId: string;
  /** shared secret that must be present in the signal payload (matches the poster's secret) */
  secret: string;
  /** the agent woken to run the OCR cross-check for the submission */
  agentId: string;
  /** wording used in the wake prompts; defaults are generic so the engine carries no tenant specifics */
  label?: string;
  /** base URL a generated document is fetched from, e.g. https://portal.example/svc/doc/view/ */
  viewUrlBase?: string;
  /** URL where the owner approves a new submission */
  approveUrl?: string;
  /** name used for the owner in the heads-up prompt (default "the owner") */
  ownerName?: string;
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
  /**
   * Optional shared secret the reverse proxy sends as `X-Proxy-Token`. When set, X-Real-IP/X-Forwarded-For
   * are only trusted on requests carrying the matching token (#6 trusted-proxy gate) — stops a direct client
   * spoofing its rate-limit IP. Unset = forwarding headers trusted as before (backward compatible).
   */
  trustedProxyToken?: string;
  /**
   * Cloudflare Access in front of the dashboard (via the tunnel). Needed for the dashboard Unfreeze button: the fleet can be thawed only by a request
   * carrying a Cf-Access-Jwt-Assertion that verifies against the team keys for one of `audiences` and the owner's email (src/web/cf-access.ts).
   * Unset = no dashboard unfreeze at all (Slack / deleting the file still work).
   */
  cfAccess?: { teamDomain: string; audiences: string[]; ownerEmail: string; tokenHosts?: string[] };      // tokenHosts: public hostnames (behind Access) where the owner's Access JWT also yields the dashboard token for Mission Control; empty/absent = off
  /**
   * Which dashboard `/` opens: "classic" (default) or "mc" (Mission Control, served under /mc/).
   * With "mc", `/` redirects to /mc/ and Mission Control hides its "Classic" switch link.
   */
  dashboard?: "classic" | "mc";
  rateLimit?: {
    maxFails: number;
    windowMs: number;
    /** base block duration once maxFails is hit; escalates (doubles) on repeat lockouts up to maxBlockMs */
    blockMs: number;
    /** ceiling for the escalating block duration (optional; defaults to 1h) */
    maxBlockMs?: number;
  };
}

export interface TmuxConfig {
  /** dedicated tmux server socket name (`tmux -L <socket>`) — isolates our fleet */
  socket: string;
}

export interface OwnerConfig {
  displayName: string;
  /** stable handle stored as the owner's author/assignee value (default "owner") */
  handle?: string;
  /** Slack user id of the human owner (replaces the old hardcoded Telegram chat id) */
  slackUserId?: string;
  locale: string;
  timezone: string;
  /**
   * The owner's OWN interactive Claude CLI defaults. Agents share ~/.claude/settings.json with the
   * owner (one HOME), and /model + /effort save themselves into it, so after tuning an agent the
   * engine restores these values — otherwise the owner's next `claude` would silently start on
   * whatever an agent was last switched to. Agents themselves are unaffected either way: they launch
   * with explicit --model/--effort flags, which override the file.
   */
  claudeModel?: string;
  claudeEffort?: string;
}

export interface ChannelConfig {
  provider: "slack" | "none";
  /** workspace-level Socket Mode app token (xapp-...) — value lives in secrets, not config */
  appTokenRef?: string;
  /** default bot token ref for outbound when an agent has no own token */
  botTokenRef?: string;
}
