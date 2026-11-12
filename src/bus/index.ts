import type { EngineConfig } from "../types.js";
import { getDb } from "../db/index.js";
import { enqueueInbound } from "../queue/index.js";
import { displayNameFor, loadAgents } from "../agents.js";
import { log } from "../logger.js";

const logger = log("bus");
const TICK_MS = 3000;
// --- Anti-loop circuit breaker (added 2026-06-15 after the inter-agent loop incident) ---
// Rolling window in which we count inter-agent traffic. Env-tunable.
const BRK_WINDOW_SEC = Number(process.env.BUS_BREAKER_WINDOW_SEC) || 300;
// Max messages a single directed-or-reverse PAIR may exchange in the window before
// excess messages are HELD (not delivered) — this cuts the reply feedback that drives ping-pong.
const BRK_PAIR_LIMIT = Number(process.env.BUS_BREAKER_PAIR_LIMIT) || 8;
// Max TOTAL inter-agent messages created in the window before the whole bus auto-halts delivery.
const BRK_GLOBAL_LIMIT = Number(process.env.BUS_BREAKER_GLOBAL_LIMIT) || 40;
// Latch so we log/alert once per trip, not every tick.
let breakerTripped = false;
// Captured at startBus so wrap() can resolve sender display names. Display-only; routing uses the id.
let busCfg: EngineConfig | null = null;

/** Queue an inter-agent message (an agent delegating to another). */
export function sendAgentMessage(from: string, to: string, content: string): number {
  const r = getDb()
    .prepare(`INSERT INTO agent_messages (from_agent, to_agent, content) VALUES (?, ?, ?)`)
    .run(from, to, content);
  return Number(r.lastInsertRowid);
}

interface PendingMsg {
  id: number;
  from_agent: string;
  to_agent: string;
  content: string;
}


// --- BUS DROP NOTICE (owner GO 2026-11-13; Toby SAFE with 5 conditions) ---
// The breaker marks messages failed (or, in a GLOBAL trip, leaves them pending) SILENTLY: the sender never learns. Now the SENDER
// gets ONE short notice in its own inbound queue. Rules that keep it safe: it goes through enqueueInbound (NEVER an agent_messages row:
// the pair count above counts every row both ways, so a row would feed the breaker); the dedup key lives in the queue, so the rate limit
// survives restarts; it is never sent to the recipient; it is skipped when sender == recipient or either side is not a live agent.
let liveCheckOverride: ((id: string) => boolean) | null = null;
/** test hook: replace the "is this a live agent" check (null = the real roster) */
export function __setBusLiveCheck(fn: ((id: string) => boolean) | null): void { liveCheckOverride = fn; }
function isLiveAgent(id: string): boolean {
  if (liveCheckOverride) return liveCheckOverride(id);
  if (!busCfg) return true; // no roster captured (unit tests without startBus): cannot judge, do not block
  return loadAgents(busCfg).some((a) => a.id === id && a.enabled);
}
function noticeDropped(m: PendingMsg, reason: string): void {
  if (m.from_agent === m.to_agent || !isLiveAgent(m.from_agent) || !isLiveAgent(m.to_agent)) return;
  try {
    enqueueInbound({
      agentId: m.from_agent,
      source: "manual",
      prompt: `[BUS DROPPED #${m.id} to ${m.to_agent}] ${reason}. Not delivered. No reply needed; do not message ${m.to_agent} about it. Wait ~5 min, then send ONE bundled message (the dropped ones still count in the window, so an instant resend is dropped again).`,
      dedupKey: `bus-drop:${m.from_agent}:${m.to_agent}:${Math.floor(Date.now() / (BRK_WINDOW_SEC * 1000))}`,
    });
  } catch (err) {
    logger.error({ err }, "bus drop notice: enqueue failed");
  }
}
/** GLOBAL trip: pending messages stay pending (silent). One notice per sender per trip (dedup bucket = the trip's start window). */
function noticeHeld(senders: Map<string, { id: number; to: string; n: number }>): void {
  for (const [from, h] of senders) {
    if (from === h.to || !isLiveAgent(from) || !isLiveAgent(h.to)) continue;
    try {
      enqueueInbound({
        agentId: from,
        source: "manual",
        prompt: `[BUS HELD] The whole bus is over its traffic limit, so your pending message(s) (e.g. #${h.id} to ${h.to}, ${h.n} in all) are held and go out when it clears (~5 min). No reply needed; do not resend and do not message anyone about it.`,
        dedupKey: `bus-held:${from}:${tripBucket}`,
      });
    } catch (err) {
      logger.error({ err }, "bus held notice: enqueue failed");
    }
  }
}
let tripBucket = 0;

function wrap(m: PendingMsg): string {
  // DISPLAY ONLY: show the sender's human name to the recipient. Routing still uses m.from_agent (the id).
  const from = busCfg ? displayNameFor(busCfg, m.from_agent) : m.from_agent;
  return `[Inter-agent message from ${from} (agent id "${m.from_agent}") — this is another AGENT on the team, NOT your owner]: ${m.content}\n\nIf you need to reply, send it BACK TO THE SENDER over the bus (POST /api/messages with "to":"${m.from_agent}"). Do NOT answer on your owner Slack channel — the owner is not part of this thread and should not receive it. When finished, mark this message done (POST /api/messages/done {"id":${m.id}}). If no reply is needed, just mark it done.`;
}

/**
 * Move every 'pending' inter-agent message into the target's inbound queue and
 * flip it to 'delivered'. Idempotent (dedup key `bus:<id>`), so a message is
 * never enqueued twice and never stuck 'pending' forever (the v1 bug). The
 * target agent flips it to 'done' via the dashboard API when finished.
 */
export function deliverPendingMessages(): number {
  const db = getDb();
  // GLOBAL BREAKER: if total inter-agent traffic in the window floods past the limit,
  // halt ALL delivery (cuts the feedback that sustains a runaway loop), wake Michael once,
  // and auto-reset on the first tick where traffic is back below the limit.
  const recentTotal = (db
    .prepare(`SELECT COUNT(*) n FROM agent_messages WHERE created_at > unixepoch() - ?`)
    .get(BRK_WINDOW_SEC) as { n: number }).n;
  if (recentTotal >= BRK_GLOBAL_LIMIT) {
    if (!breakerTripped) {
      breakerTripped = true;
      tripBucket = Math.floor(Date.now() / (BRK_WINDOW_SEC * 1000));
      logger.fatal({ recentTotal, limit: BRK_GLOBAL_LIMIT, windowSec: BRK_WINDOW_SEC }, "BUS CIRCUIT BREAKER TRIPPED — inter-agent flood; delivery halted");
      try {
        enqueueInbound({
          agentId: "marveen",
          source: "manual",
          prompt: `[BUS CIRCUIT BREAKER TRIPPED] ${recentTotal} inter-agent messages in ${BRK_WINDOW_SEC}s (limit ${BRK_GLOBAL_LIMIT}). The bus AUTO-HALTED delivery to stop a loop. Find the looping pair (SELECT from_agent,to_agent,COUNT(*) n FROM agent_messages WHERE created_at>unixepoch()-${BRK_WINDOW_SEC} GROUP BY 1,2 ORDER BY n DESC), fix the cause, summarize, and tell ${busCfg?.owner.displayName ?? "the owner"}. Do NOT just resume.`,
          dedupKey: `breaker-trip:${Math.floor(Date.now() / 60000)}`,
        });
      } catch (err) {
        logger.error({ err }, "breaker: failed to wake michael");
      }
    }
    const held = db.prepare(`SELECT id, from_agent, to_agent FROM agent_messages WHERE status='pending' ORDER BY id ASC LIMIT 100`).all() as PendingMsg[];
    const senders = new Map<string, { id: number; to: string; n: number }>();
    for (const m of held) { const h = senders.get(m.from_agent); if (h) h.n++; else senders.set(m.from_agent, { id: m.id, to: m.to_agent, n: 1 }); }
    noticeHeld(senders);
    return 0;
  } else if (breakerTripped) {
    breakerTripped = false;
    logger.warn({ recentTotal }, "bus circuit breaker reset — traffic back to normal");
  }

  const pending = db
    .prepare(`SELECT id, from_agent, to_agent, content FROM agent_messages WHERE status='pending' ORDER BY id ASC LIMIT 100`)
    .all() as PendingMsg[];
  let n = 0;
  for (const m of pending) {
    // PAIR BREAKER: count traffic between this from<->to (both directions) in the window.
    // Over the limit => HOLD this message (mark failed, don't deliver) so the pair can't ping-pong.
    const pairCount = (db
      .prepare(`SELECT COUNT(*) n FROM agent_messages WHERE created_at > unixepoch() - ? AND ((from_agent=? AND to_agent=?) OR (from_agent=? AND to_agent=?))`)
      .get(BRK_WINDOW_SEC, m.from_agent, m.to_agent, m.to_agent, m.from_agent) as { n: number }).n;
    if (pairCount > BRK_PAIR_LIMIT) {
      db.prepare(`UPDATE agent_messages SET status='failed', result=?, completed_at=unixepoch() WHERE id=?`)
        .run(`circuit-breaker: ${m.from_agent}<->${m.to_agent} exceeded ${BRK_PAIR_LIMIT}/${BRK_WINDOW_SEC}s`, m.id);
      logger.warn({ id: m.id, from: m.from_agent, to: m.to_agent, pairCount }, "bus PAIR breaker: held looping message (not delivered)");
      noticeDropped(m, `circuit breaker: more than ${BRK_PAIR_LIMIT} messages between ${m.from_agent} and ${m.to_agent} in ${BRK_WINDOW_SEC / 60} minutes`);
      continue;
    }
    const id = enqueueInbound({ agentId: m.to_agent, source: "bus", prompt: wrap(m), dedupKey: `bus:${m.id}` });
    db.prepare(`UPDATE agent_messages SET status='delivered', delivered_at=unixepoch() WHERE id=?`).run(m.id);
    if (id != null) n++;
    logger.info({ id: m.id, from: m.from_agent, to: m.to_agent }, "inter-agent message delivered to queue");
  }
  return n;
}

export function startBus(cfg: EngineConfig): () => void {
  busCfg = cfg;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      deliverPendingMessages();
    } catch (err) {
      logger.error({ err }, "bus tick error");
    }
  };
  const handle = setInterval(tick, TICK_MS);
  logger.info({ tickMs: TICK_MS }, "inter-agent bus started");
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
