import type { EngineConfig } from "../types.js";
import { getDb } from "../db/index.js";
import { enqueueInbound } from "../queue/index.js";
import { displayNameFor } from "../agents.js";
import { log } from "../logger.js";

const logger = log("bus");
const TICK_MS = 3000;
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

function wrap(m: PendingMsg): string {
  // DISPLAY ONLY: show the sender's human name to the recipient. Routing still uses m.from_agent (the id).
  const from = busCfg ? displayNameFor(busCfg, m.from_agent) : m.from_agent;
  return `[Message from ${from}]: ${m.content}\n\nHandle this and reply on your channel. When finished, mark it done.`;
}

/**
 * Move every 'pending' inter-agent message into the target's inbound queue and
 * flip it to 'delivered'. Idempotent (dedup key `bus:<id>`), so a message is
 * never enqueued twice and never stuck 'pending' forever (the v1 bug). The
 * target agent flips it to 'done' via the dashboard API when finished.
 */
export function deliverPendingMessages(): number {
  const db = getDb();
  const pending = db
    .prepare(`SELECT id, from_agent, to_agent, content FROM agent_messages WHERE status='pending' ORDER BY id ASC LIMIT 100`)
    .all() as PendingMsg[];
  let n = 0;
  for (const m of pending) {
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
