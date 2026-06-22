import { join } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { EngineConfig } from "../types.js";
import { loadAgents, slackAgents } from "../agents.js";
import { enqueueInbound } from "../queue/index.js";
import { isAllowedSender } from "./access.js";
import { downloadFiles } from "./files.js";
import { log } from "../logger.js";

const logger = log("slack-ingest");

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  urlPrivateDownload?: string;
}

export interface ParsedInbound {
  text: string;
  channel: string;
  user: string;
  ts: string;
  files: SlackFile[];
}

function parseFiles(raw: unknown): SlackFile[] {
  if (!Array.isArray(raw)) return [];
  const out: SlackFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) continue;
    const dl =
      typeof o.url_private_download === "string"
        ? o.url_private_download
        : typeof o.url_private === "string"
          ? o.url_private
          : undefined;
    out.push({
      id,
      name: typeof o.name === "string" ? o.name : id,
      mimetype: typeof o.mimetype === "string" ? o.mimetype : "application/octet-stream",
      urlPrivateDownload: dl,
    });
  }
  return out;
}

/** Strip every `<@BOTID>` / `<@BOTID|label>` mention of this bot, then collapse the whitespace it left. */
function stripMention(text: string, selfBotUserId?: string): string {
  if (!selfBotUserId) return text.trim();
  return text
    .replace(new RegExp(`<@${selfBotUserId}(\\|[^>]*)?>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure inbound parser (testable without Slack). Accepts real human messages on two
 * entry paths:
 *   - DMs: a `message` event with channel_type "im" (respond to everything).
 *   - Channels: an `app_mention` event (respond only when the bot is @-mentioned),
 *     so agents never react to unrelated chatter in a shared channel.
 * Both paths carry file attachments (subtype "file_share"). Rejects anything from a
 * bot (incl. the agent's own echoes), edits, joins, plain non-DM messages, and
 * messages with neither text nor files.
 */
export function parseInbound(event: unknown, selfBotUserId?: string): ParsedInbound | null {
  const e = event as Record<string, unknown> | null;
  if (!e) return null;
  const isMention = e.type === "app_mention";
  if (e.type !== "message" && !isMention) return null;
  // allow plain messages and file uploads; reject edits / bot_message / joins / ...
  if (e.subtype && e.subtype !== "file_share") return null;
  if (e.bot_id) return null; // any bot, including self
  if (selfBotUserId && e.user === selfBotUserId) return null;
  // DMs stay DM-only: a plain `message` with a present, non-'im' channel_type is rejected so a future scope
  // widening (e.g. channels:history) can't silently make agents react to public-channel posts. Channels are
  // reached exclusively through app_mention, which only fires when the bot is explicitly @-mentioned.
  if (!isMention && typeof e.channel_type === "string" && e.channel_type !== "im") return null;
  const raw = typeof e.text === "string" ? e.text : "";
  const text = isMention ? stripMention(raw, selfBotUserId) : raw.trim();
  const files = parseFiles(e.files);
  if (!text && files.length === 0) return null;
  if (typeof e.channel !== "string" || typeof e.user !== "string" || typeof e.ts !== "string") return null;
  return { text, channel: e.channel, user: e.user, ts: e.ts, files };
}

/**
 * Build the prompt delivered to the agent's session. When files were attached we
 * download them to the agent's inbox and point the agent at the local paths so it
 * can open them with the Read tool (images + PDFs). Failed downloads (e.g. the bot
 * lacks files:read) are surfaced to the agent rather than dropped silently.
 */
async function buildPrompt(parsed: ParsedInbound, agentDir: string, botToken: string): Promise<string> {
  if (parsed.files.length === 0) return parsed.text;
  const inbox = join(agentDir, "inbox");
  const dl = await downloadFiles(parsed.files, botToken, inbox, parsed.ts.replace(/\./g, "_"));
  const got = dl.filter((f) => f.ok);
  const failed = dl.filter((f) => !f.ok);
  const lines: string[] = [];
  if (got.length) {
    lines.push(`[The user attached ${got.length} file(s). Open them with the Read tool:`);
    for (const f of got) lines.push(`- ${f.path} (${f.mimetype})`);
    lines.push("]");
  }
  if (failed.length) {
    lines.push(
      `[${failed.length} attached file(s) could NOT be downloaded — the bot is likely missing the Slack files:read scope: ${failed
        .map((f) => f.name)
        .join(", ")}. Tell the user you can't open attachments until that scope is added.]`
    );
  }
  const block = lines.join("\n");
  return parsed.text ? `${parsed.text}\n\n${block}` : block;
}

/**
 * Start the Slack ingest daemon: ONE Socket-Mode connection per slack-enabled
 * agent-app. Each connection is the sole consumer of its app's events (no
 * event-splitting). Inbound human messages are enqueued to the single inbound
 * queue with a Slack-ts dedup key, then drained by the Session Manager deliverer.
 */
export function startSlackIngest(cfg: EngineConfig): () => void {
  const agents = slackAgents(loadAgents(cfg));
  if (agents.length === 0) {
    logger.info("no slack-enabled agents — ingest idle");
    return () => {};
  }

  const ownerId = cfg.owner.slackUserId;
  const clients: SocketModeClient[] = [];
  for (const agent of agents) {
    const sm = new SocketModeClient({ appToken: agent.slack!.appToken! });
    // Reuse one Web client per agent for the "seen" 👀 reaction (reactions:write).
    const web = agent.slack!.botToken ? new WebClient(agent.slack!.botToken) : null;

    // Shared handler for both entry paths: DMs (`message`) and channel @-mentions
    // (`app_mention`). The dedup key `slack:<ts>` means that if a single mention ever
    // arrives on both subscriptions it is enqueued only once.
    const handle = async (args: { ack?: () => Promise<void>; event?: unknown; body?: { event?: unknown } }) => {
      if (args.ack) {
        try {
          await args.ack();
        } catch {
          /* ack best-effort */
        }
      }
      const event = args.event ?? args.body?.event;
      const parsed = parseInbound(event, agent.slack!.botUserId);
      if (!parsed) return;
      const isDm = parsed.channel.startsWith("D");
      if (!isAllowedSender(parsed.user, agent.allowFrom, ownerId)) {
        logger.warn({ agent: agent.id, from: parsed.user, dm: isDm }, "ignored message from non-allowed user");
        return;
      }
      // Instant "I've seen this" feedback so the owner isn't left wondering — react
      // 👀 the moment we accept the message, well before the agent finishes thinking.
      // Best-effort: a missing reactions:write scope or an already-reacted message
      // must never block delivery.
      web?.reactions
        .add({ channel: parsed.channel, timestamp: parsed.ts, name: "eyes" })
        .catch((err: unknown) => logger.debug({ agent: agent.id, err }, "seen-reaction failed"));
      const prompt = await buildPrompt(parsed, agent.dir, agent.slack!.botToken!);
      const id = enqueueInbound({
        agentId: agent.id,
        source: "channel",
        prompt,
        replyChannel: parsed.channel,
        replyUser: parsed.user,
        dedupKey: `slack:${parsed.ts}`,
      });
      logger.info(
        { agent: agent.id, enqueued: id != null, dm: isDm, files: parsed.files.length },
        isDm ? "inbound DM enqueued" : "inbound channel mention enqueued"
      );
    };

    sm.on("message", handle);
    sm.on("app_mention", handle);

    sm.start().catch((err: unknown) => logger.error({ agent: agent.id, err }, "socket start failed"));
    clients.push(sm);
    logger.info({ agent: agent.id, name: agent.displayName }, "slack ingest socket up");
  }

  return () => {
    for (const c of clients) c.disconnect().catch(() => {});
  };
}
