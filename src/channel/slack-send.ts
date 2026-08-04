import { WebClient } from "@slack/web-api";
import type { EngineConfig } from "../types.js";
import { loadAgents } from "../agents.js";
import { listOutboundQueued, claimOutbound, markOutboundFailed, markOutboundSent } from "../queue/index.js";
import { recordOutbound } from "../memory/conversation.js";
import { log } from "../logger.js";

const logger = log("slack-send");
const TICK_MS = 1500;

/**
 * One drain pass over outbound_queue, extracted so the double-post race is testable without timers.
 * `post` does the actual Slack call; `hasWeb` reports whether the agent has a usable bot token.
 * Returns a re-entrancy-guarded async tick: if a pass is still running (a slow postMessage), the next
 * call is a no-op instead of starting an overlapping drain of the same rows.
 */
export function makeOutboundTick(deps: {
  post: (item: { agent_id: string; channel: string; text: string }) => Promise<void>;
  hasWeb: (agentId: string) => boolean;
  // Injectable bookkeeping seams (default to the real ops). Tests force these to throw AFTER a
  // successful post to prove the split below — the exact real code path, just with the DB/memory
  // write made to fail. Production passes nothing and gets the real functions.
  markSent?: (id: number) => void;
  recordOut?: (agentId: string, channel: string, text: string) => void;
}): () => Promise<void> {
  const markSent = deps.markSent ?? markOutboundSent;
  const recordOut = deps.recordOut ?? recordOutbound;
  let running = false;
  return async function tick(): Promise<void> {
    if (running) return; // re-entrancy guard: a slow drain must not overlap the next interval fire
    running = true;
    try {
      for (const item of listOutboundQueued()) {
        // ATOMIC CLAIM before posting: queued -> 'sending' in one statement. Only the winner posts,
        // so overlapping drains (and even a second draining process) cannot double-post one row.
        if (!claimOutbound(item.id)) continue;
        if (!deps.hasWeb(item.agent_id)) {
          markOutboundFailed(item.id, "no bot token for agent");
          continue;
        }
        // SPLIT FAILURE DOMAINS (Toby's load-bearing fix). markOutboundFailed — which returns a row
        // to 'queued' and lets the next tick re-post — must be reachable ONLY when the post did NOT
        // happen. If we lumped post + bookkeeping in one try (the old bug), a throw from
        // markOutboundSent (variant b) or recordOutbound (variant a) AFTER Slack already accepted
        // would requeue a delivered message and re-post it. So: post in its own try (a throw here =
        // never sent = safe to fail), then bookkeeping in a second try whose failure is LOGGED, never
        // requeued.
        try {
          await deps.post(item);
        } catch (err) {
          markOutboundFailed(item.id, String(err)); // not sent -> 'queued' (retry) or 'failed' (cap)
          logger.warn({ id: item.id, agent: item.agent_id, err }, "outbound failed (will retry)");
          continue;
        }
        // Post CONFIRMED past this line. A bookkeeping throw must NEVER reach markOutboundFailed.
        // Residual (accepted): if markSent throws, the row stays 'sending' and the boot reaper
        // requeues it later = at most ONE duplicate. A dup over a dropped owner message, and rare.
        try {
          markSent(item.id);
          recordOut(item.agent_id, item.channel, item.text);
          logger.info({ id: item.id, agent: item.agent_id }, "outbound sent");
        } catch (err) {
          logger.error({ id: item.id, agent: item.agent_id, err }, "outbound POSTED but bookkeeping failed — NOT requeueing");
        }
      }
    } finally {
      running = false;
    }
  };
}

/**
 * Outbound sender: drains outbound_queue and posts each message AS the agent's
 * own bot (its name + avatar) via that agent's botToken. Durable + retriable +
 * logged. This is how "Charly" replies look like they came from Charly.
 *
 * (Agent replies reach this queue via the dashboard /api/outbound endpoint or the
 * `office-say` CLI — see Phase 5; the engine itself can also enqueue here.)
 */
export function startSlackSender(cfg: EngineConfig): () => void {
  const botTokens = new Map<string, string>();
  for (const a of loadAgents(cfg)) {
    if (a.slack?.botToken) botTokens.set(a.id, a.slack.botToken);
  }
  const webByAgent = new Map<string, WebClient>();
  const web = (agentId: string): WebClient | null => {
    const tok = botTokens.get(agentId);
    if (!tok) return null;
    let w = webByAgent.get(agentId);
    if (!w) {
      w = new WebClient(tok);
      webByAgent.set(agentId, w);
    }
    return w;
  };

  let stopped = false;
  const tick = makeOutboundTick({
    post: (item) =>
      web(item.agent_id)!.chat.postMessage({ channel: item.channel, text: item.text }).then(() => undefined),
    hasWeb: (agentId) => web(agentId) !== null,
  });

  const handle = setInterval(() => {
    if (!stopped) void tick();
  }, TICK_MS);
  logger.info({ agents: botTokens.size }, "slack sender started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
