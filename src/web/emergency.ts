// Emergency Restart — one action that does what an operator does by hand when the fleet melts down
// into an inter-agent message storm and the owner's own messages can no longer get through:
//
//   1. SAVE   — full DB snapshot + JSON export of the entire queue (pending inbound, the stuck
//               inter-agent bus, and the failed dead-letters) + a human-readable digest. Zero data loss.
//   2. CLEAR  — delete the active inbound queue and retire the stuck bus records to a terminal state,
//               so nothing is re-injected on restart and the storm cannot immediately re-ignite.
//   3. RESTART— kill + relaunch every enabled agent (fresh panes on the isolated tmux server).
//   4. BRIEF  — enqueue a manual message to the main agent (Michael/marveen) explaining what happened,
//               pointing at the saved backup, and telling him to summarise it to the owner on Slack and
//               then STAND BY for instructions — WITHOUT blasting the other agents (that caused the storm).
//
// Triggered from the dashboard "Emergency Restart" button (POST /api/emergency-restart). Designed to be
// safe to press from a phone with no laptop nearby: everything is backed up before anything is deleted.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig } from "../types.js";
import { getDb } from "../db/index.js";
import { loadAgents } from "../agents.js";
import { launchAgent, sessionNameFor } from "../session/session-manager.js";
import { killSession } from "../session/tmux.js";
import { enqueueInbound } from "../queue/index.js";
import { logger } from "../logger.js";

export interface EmergencyResult {
  ok: boolean;
  dryRun: boolean;
  backupDir: string;
  saved: { inboundPending: number; inboundFailed: number; busPending: number; busFailed: number };
  cleared: { inbound: number; bus: number };
  restarted: string[];
  briefedAgent: string | null;
  ts: string;
}

export interface EmergencyOpts {
  /** Save-only: write the backup + digest but DON'T clear the queue, restart agents, or brief anyone.
   *  Lets the button (and its wiring) be verified safely without disrupting a healthy fleet. */
  dryRun?: boolean;
}

/** ISO timestamp with filesystem-safe characters (colons -> nothing), e.g. 20260717T213154Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

export async function runEmergencyRestart(cfg: EngineConfig, opts: EmergencyOpts = {}): Promise<EmergencyResult> {
  const dryRun = opts.dryRun === true;
  const ts = new Date().toISOString();
  const db = getDb();
  const backupDir = join(cfg.paths.storeDir, `queue-backup-${dryRun ? "dryrun-" : ""}${stamp()}`);
  mkdirSync(backupDir, { recursive: true });
  logger.warn({ backupDir, dryRun }, "emergency-restart: starting");

  // ---------- 1. SAVE ----------
  // Full consistent DB snapshot (better-sqlite3 handles the WAL for us).
  await db.backup(join(backupDir, "theoffice.db.snapshot"));

  type Row = Record<string, unknown>;
  const inboundPending = db
    .prepare(`SELECT * FROM inbound_queue WHERE status IN ('queued','delivering') ORDER BY id`)
    .all() as Row[];
  const inboundFailed = db.prepare(`SELECT * FROM inbound_queue WHERE status='failed' ORDER BY id`).all() as Row[];
  const busPending = db
    .prepare(`SELECT * FROM agent_messages WHERE status IN ('pending','delivered') ORDER BY id`)
    .all() as Row[];
  const busFailed = db.prepare(`SELECT * FROM agent_messages WHERE status='failed' ORDER BY id`).all() as Row[];

  writeFileSync(join(backupDir, "inbound_pending.json"), JSON.stringify(inboundPending, null, 2));
  writeFileSync(join(backupDir, "inbound_failed.json"), JSON.stringify(inboundFailed, null, 2));
  writeFileSync(join(backupDir, "bus_pending.json"), JSON.stringify(busPending, null, 2));
  writeFileSync(join(backupDir, "bus_failed.json"), JSON.stringify(busFailed, null, 2));
  writeFileSync(join(backupDir, "QUEUE-DIGEST.md"), buildDigest(cfg, ts, inboundPending, busPending, {
    inboundPending: inboundPending.length,
    inboundFailed: inboundFailed.length,
    busPending: busPending.length,
    busFailed: busFailed.length,
  }));

  if (dryRun) {
    logger.warn({ backupDir }, "emergency-restart: DRY RUN — saved only, nothing cleared/restarted");
    return {
      ok: true,
      dryRun: true,
      backupDir,
      saved: {
        inboundPending: inboundPending.length,
        inboundFailed: inboundFailed.length,
        busPending: busPending.length,
        busFailed: busFailed.length,
      },
      cleared: { inbound: 0, bus: 0 },
      restarted: [],
      briefedAgent: null,
      ts,
    };
  }

  // ---------- 2. CLEAR ----------
  const clearedInbound = db
    .prepare(`DELETE FROM inbound_queue WHERE status IN ('queued','delivering')`)
    .run().changes;
  const clearedBus = db
    .prepare(
      `UPDATE agent_messages
          SET status='done',
              result=COALESCE(result,'')||' [cleared: emergency-restart ${ts}]',
              completed_at=unixepoch()
        WHERE status IN ('pending','delivered')`,
    )
    .run().changes;
  logger.warn({ clearedInbound, clearedBus }, "emergency-restart: queue cleared");

  // ---------- 3. RESTART every enabled agent ----------
  const restarted: string[] = [];
  for (const agent of loadAgents(cfg).filter((a) => a.enabled)) {
    try {
      killSession(cfg.tmux.socket, sessionNameFor(agent.id));
      launchAgent(cfg, agent);
      restarted.push(agent.id);
    } catch (err) {
      logger.error({ err, agent: agent.id }, "emergency-restart: relaunch failed");
    }
  }
  logger.warn({ restarted }, "emergency-restart: agents relaunched");

  // ---------- 4. BRIEF the main agent ----------
  const mainId = cfg.mainAgentId;
  const mainAgent = loadAgents(cfg).find((a) => a.id === mainId && a.enabled);
  let briefedAgent: string | null = null;
  if (mainAgent) {
    const { channel, user } = ownerReplyContext(cfg, mainId);
    enqueueInbound({
      agentId: mainId,
      source: "manual",
      prompt: buildBrief(cfg, backupDir, {
        inboundPending: inboundPending.length,
        busPending: busPending.length,
        clearedInbound,
        clearedBus,
        restarted,
      }),
      replyChannel: channel ?? undefined,
      replyUser: user ?? undefined,
    });
    briefedAgent = mainId;
  } else {
    logger.error({ mainId }, "emergency-restart: main agent not found/enabled — no brief enqueued");
  }

  logger.warn({ backupDir, restarted: restarted.length, briefedAgent }, "emergency-restart: complete");
  return {
    ok: true,
    dryRun: false,
    backupDir,
    saved: {
      inboundPending: inboundPending.length,
      inboundFailed: inboundFailed.length,
      busPending: busPending.length,
      busFailed: busFailed.length,
    },
    cleared: { inbound: clearedInbound, bus: clearedBus },
    restarted,
    briefedAgent,
    ts,
  };
}

/** The channel/user the main agent should answer the owner on: last-replied DM, else owner slack id. */
function ownerReplyContext(cfg: EngineConfig, mainId: string): { channel: string | null; user: string | null } {
  const user = cfg.owner.slackUserId ?? null;
  try {
    const f = join(cfg.paths.agentsDir, mainId, ".reply-context");
    if (existsSync(f)) {
      const ch = readFileSync(f, "utf8").trim();
      if (ch) return { channel: ch, user };
    }
  } catch {
    /* best-effort */
  }
  return { channel: user, user }; // fall back to the owner id as the DM target
}

interface Counts {
  inboundPending: number;
  inboundFailed: number;
  busPending: number;
  busFailed: number;
}

const AGENT_IDS_SQL_SAFE = /^[a-z0-9_-]+$/;

function buildDigest(
  cfg: EngineConfig,
  ts: string,
  inboundPending: Array<Record<string, unknown>>,
  busPending: Array<Record<string, unknown>>,
  c: Counts,
): string {
  const realIds = new Set(loadAgents(cfg).map((a) => a.id).filter((id) => AGENT_IDS_SQL_SAFE.test(id)));
  const owner = inboundPending.filter((r) => r.source === "channel");
  const phantom = inboundPending.filter((r) => !realIds.has(String(r.agent_id)));
  const fmt = (u: unknown) => (u ? new Date(Number(u) * 1000).toLocaleString() : "");
  const one = (s: unknown, n = 120) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

  const lines: string[] = [];
  lines.push(`# Queue snapshot — ${ts}`);
  lines.push("");
  lines.push("Captured by Emergency Restart the instant the fleet was frozen.");
  lines.push("Full DB: theoffice.db.snapshot. Full rows: inbound_pending.json / bus_pending.json / *_failed.json.");
  lines.push("");
  lines.push("## Counts");
  lines.push(`- inbound queue pending (queued/delivering): ${c.inboundPending}`);
  lines.push(`- inbound queue failed (dead-letter): ${c.inboundFailed}`);
  lines.push(`- inter-agent bus pending (pending/delivered): ${c.busPending}`);
  lines.push(`- inter-agent bus failed (dead-letter): ${c.busFailed}`);
  lines.push("");
  lines.push(`## ⭐ OWNER (${cfg.owner.displayName}) messages stuck undelivered — READ FIRST`);
  lines.push("```");
  if (owner.length === 0) lines.push("(none)");
  for (const r of owner) lines.push(`${fmt(r.created_at)}  -> ${r.agent_id}  ${one(r.prompt)}`);
  lines.push("```");
  lines.push("");
  lines.push("## Phantom / undeliverable agent_ids (can never deliver — pure poison)");
  lines.push("```");
  if (phantom.length === 0) lines.push("(none)");
  for (const r of phantom) lines.push(`${fmt(r.created_at)}  -> ${r.agent_id} (${r.source})  ${one(r.prompt, 60)}`);
  lines.push("```");
  lines.push("");
  lines.push("## Pending inter-agent bus (first 60)");
  lines.push("```");
  if (busPending.length === 0) lines.push("(none)");
  for (const r of busPending.slice(0, 60)) {
    lines.push(`${fmt(r.created_at)}  ${r.from_agent} -> ${r.to_agent} [${r.status}]  ${one(r.content, 70)}`);
  }
  lines.push("```");
  return lines.join("\n");
}

function buildBrief(
  cfg: EngineConfig,
  backupDir: string,
  d: { inboundPending: number; busPending: number; clearedInbound: number; clearedBus: number; restarted: string[] },
): string {
  const owner = cfg.owner.displayName;
  return `[OPERATOR MESSAGE — Emergency Restart was just triggered from the dashboard. Not from another agent. Read fully before doing anything. Priority #1.]

WHAT HAPPENED
The fleet was frozen by an EMERGENCY RESTART because it went into an inter-agent message storm — agents generating bus/coordination messages faster than they could be consumed, the queue backing up (including messages addressed to phantom ids that can never deliver), and ${owner}'s own Slack messages barely getting through. ${owner} (or an automated guard) hit the Emergency Restart button to break the loop.

WHAT THE SYSTEM ALREADY DID — no data lost
1. Saved a full DB snapshot + the ENTIRE queue to: ${backupDir}
   - QUEUE-DIGEST.md  (human-readable — READ THIS FIRST)
   - inbound_pending.json (${d.inboundPending} undelivered inbound, incl. ${owner}'s stuck messages)
   - bus_pending.json (${d.busPending} stuck inter-agent messages) + inbound_failed.json + bus_failed.json + theoffice.db.snapshot
2. Cleared the active queue: deleted ${d.clearedInbound} pending inbound, retired ${d.clearedBus} stuck bus records. The queue is now EMPTY.
3. Restarted all ${d.restarted.length} enabled agents (clean idle panes). The BUS_BREAKER circuit breaker is active.

YOUR TASK NOW
a) READ ${backupDir}/QUEUE-DIGEST.md (open the JSON dumps for detail). Note any REAL in-flight work that got cleared so nothing important is silently dropped (owner messages, watering/rental/finance items, etc.).
b) Send ${owner} a SHORT plain-language summary on Slack (your normal owner DM): (1) what happened / root cause, (2) that the full queue is saved at ${backupDir} and the queue is clean + all agents restarted, (3) a brief bulleted list of anything still needing a decision or that must be redone, (4) that you are standing by for instructions.
c) Then STOP and WAIT for ${owner}'s instructions.

CRITICAL GUARDRAIL — do NOT re-ignite the storm.
The incident was runaway agent-to-agent chatter. Do NOT blast the other agents with bus messages. Keep inter-agent messaging at essentially ZERO right now. Just read the digest, summarise to ${owner} on Slack, and wait. If other agents need briefing, propose it to ${owner} first — do not do it unprompted.`;
}
