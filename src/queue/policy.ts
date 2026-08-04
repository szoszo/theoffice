// Pure delivery-policy decisions, split out from the DB/tmux I/O so the rules born from the 2026-08-04
// delivery outage are unit-testable without a live fleet. Three rules:
//
//   1. Owner messages must NEVER fail silently. A source='channel' item that exhausts its delivery
//      budget (or hits a wedged pane) has to reach the owner by SOME path — a Slack fallback DM — not a
//      log line. On 2026-08-02 five source='channel' rows were markFailed with last_error='dirty-pane'
//      and simply vanished; three of them were Szoszo escalating that another agent had gone silent.
//   2. Owner messages jump the queue. listQueued was id-ASC, so a live owner message sat behind stale
//      scheduler heartbeats (incl. an already-moot 08:35 briefing). Owner (channel) sorts ahead of all.
//   3. A stale scheduler heartbeat is worth less than the turn it costs. A briefing hours late is moot;
//      drop it on drain rather than spend an agent turn on it. NEVER applies to channel/bus/manual.
//
// Import the budget constant from the queue module so the alarm text and the fail threshold can never
// drift apart.
import { MAX_DELIVERY_ATTEMPTS } from "./index.js";
import type { QueueSource } from "../types.js";

/** An owner (Slack) message must be escalated, never dropped silently, when its delivery is abandoned. */
export function shouldEscalateDroppedOwnerItem(source: string): boolean {
  return source === "channel";
}

/**
 * Sort key for the delivery drain: owner (channel) messages first, everything else after, FIFO within
 * each class (the caller still applies `id ASC` as the tie-break). 0 sorts ahead of 1.
 */
export function queueSourceRank(source: string): 0 | 1 {
  return source === "channel" ? 0 : 1;
}

/**
 * True when a QUEUED item is a scheduler heartbeat that has aged past the point of usefulness and should
 * be dropped instead of delivered. Deliberately narrow: ONLY source='scheduler'. Owner ('channel'),
 * inter-agent ('bus'), 'manual' and 'system' items are never age-dropped — they have no natural
 * expiry and dropping one is the exact failure we are fixing.
 *
 * @param source    the item's QueueSource
 * @param ageSec    how long the item has been queued (now - created_at), in seconds
 * @param maxAgeSec staleness threshold; <= 0 disables dropping entirely
 */
export function isStaleDroppableHeartbeat(source: string, ageSec: number, maxAgeSec: number): boolean {
  if (maxAgeSec <= 0) return false;
  if (source !== "scheduler") return false;
  return ageSec > maxAgeSec;
}

function preview(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return `> ${flat.slice(0, 140)}${flat.length > 140 ? "…" : ""}`;
}

/**
 * The loud owner-facing alarm for a message from the owner that was DROPPED (status=failed). Names the
 * target agent, the reason, and quotes a preview so Szoszo knows exactly which message to re-send. Pure,
 * so its shape is pinned by a test. Slack mrkdwn.
 */
export function ownerDropAlarmText(agentId: string, reason: string, prompt: string): string {
  return (
    `⚠️ I could not deliver your last message to *${agentId}* after ${MAX_DELIVERY_ATTEMPTS} attempts ` +
    `(reason: ${reason}). It is NOT lost silently — please re-send it, or tell me and I'll route it.\n` +
    preview(prompt)
  );
}

/**
 * The owner-facing alarm for a message that is still QUEUED and has NOT reached the agent after
 * `minutesWaiting` minutes — the 2026-08-04 case, where a message parks behind a modal, never attempted,
 * never failed. Worded as "not yet delivered / may be stuck" because at this point it is a stall, not a
 * confirmed drop: honest whether the agent is wedged or merely deep in a very long turn. Pure.
 */
export function ownerStallAlarmText(agentId: string, minutesWaiting: number, prompt: string): string {
  return (
    `⏳ Your message still hasn't reached *${agentId}* after ${minutesWaiting} min — it's queued but not ` +
    `delivered, so that agent may be stuck (frozen on a prompt or mid a very long turn). You are NOT ` +
    `being ignored; I'm on it. Re-send here if it's urgent and I'll route it another way.\n` +
    preview(prompt)
  );
}

/**
 * The alarm for an agent frozen on a permission/approval gate. The sweeper deliberately did NOT touch
 * it (clearing it would blind-approve the action), so a human must decide. Tells them how to look. Pure.
 */
export function permissionPromptAlarmText(agentId: string, socket: string, session: string): string {
  return (
    `⚠️ *${agentId}* is frozen on a permission/approval prompt. I did NOT touch it — clearing it would ` +
    `blind-approve whatever asked for authorisation (an edit / command / push / payment). A human needs ` +
    `to decide: \`tmux -L ${socket} attach -t ${session}\`, then approve or reject by hand. The agent ` +
    `stays frozen until then, which is the safe state.`
  );
}

// Compile-time guard: keep this list of the values we branch on honest against the QueueSource union.
// If a new source is added to types.ts, TypeScript flags this so the policy above is revisited.
const _SOURCES: Record<QueueSource, true> = {
  channel: true,
  scheduler: true,
  bus: true,
  manual: true,
  system: true,
};
void _SOURCES;
