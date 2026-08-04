import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import {
  enqueueInbound,
  listQueued,
  reapStaleScheduler,
  listOwnerAlarmable,
  markOwnerAlarmed,
  markDelivering,
  markDelivered,
  requeue,
  requeueNoPenalty,
  markFailed,
  enqueueOutbound,
  listOutboundQueued,
  claimOutbound,
  reapStaleOutboundSending,
  markOutboundSent,
  markOutboundFailed,
} from "./index.js";

let dir: string;
const row = (id: number) =>
  getDb().prepare(`SELECT status, attempts FROM inbound_queue WHERE id=?`).get(id) as { status: string; attempts: number };
const orow = (id: number) =>
  getDb().prepare(`SELECT status, attempts FROM outbound_queue WHERE id=?`).get(id) as { status: string; attempts: number };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-queue-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("inbound attempt-math", () => {
  it("markDelivering charges exactly one attempt and flips to delivering", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "x" })!;
    expect(row(id)).toEqual({ status: "queued", attempts: 0 });
    markDelivering(id);
    expect(row(id)).toEqual({ status: "delivering", attempts: 1 });
  });

  it("requeue returns to queued WITHOUT refunding the attempt (bounded retry)", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "x" })!;
    markDelivering(id);
    requeue(id);
    expect(row(id)).toEqual({ status: "queued", attempts: 1 });
  });

  it("requeueNoPenalty refunds the attempt (usage cap never burns budget) and floors at 0", () => {
    const id = enqueueInbound({ agentId: "a", source: "manual", prompt: "x" })!;
    markDelivering(id); // attempts 1
    requeueNoPenalty(id);
    expect(row(id)).toEqual({ status: "queued", attempts: 0 });
    requeueNoPenalty(id); // already 0 -> stays 0, never negative
    expect(row(id).attempts).toBe(0);
  });

  it("markDelivered / markFailed are terminal (drop out of the queued list)", () => {
    const d = enqueueInbound({ agentId: "a", source: "manual", prompt: "d" })!;
    markDelivering(d);
    markDelivered(d);
    expect(row(d).status).toBe("delivered");
    const f = enqueueInbound({ agentId: "a", source: "manual", prompt: "f" })!;
    markDelivering(f);
    markFailed(f, "boom");
    expect(row(f).status).toBe("failed");
    const queuedIds = listQueued("a").map((i) => i.id);
    expect(queuedIds).not.toContain(d);
    expect(queuedIds).not.toContain(f);
  });
});

describe("outbound state-machine", () => {
  it("enqueue -> queued -> sent", () => {
    const id = enqueueOutbound("a", "C123", "hi");
    expect(orow(id).status).toBe("queued");
    expect(listOutboundQueued().map((i) => i.id)).toContain(id);
    markOutboundSent(id);
    expect(orow(id).status).toBe("sent");
    expect(listOutboundQueued().map((i) => i.id)).not.toContain(id);
  });

  it("claimOutbound is atomic: for one queued row exactly one of two claimers wins", () => {
    const id = enqueueOutbound("a", "C123", "hi");
    const first = claimOutbound(id);
    const second = claimOutbound(id); // overlapping tick / second process
    expect([first, second].filter(Boolean).length).toBe(1); // exactly one claim succeeds
    expect(orow(id).status).toBe("sending");
    expect(listOutboundQueued().map((i) => i.id)).not.toContain(id); // claimed row drops out of the queued list
    markOutboundSent(id); // terminalize so this 'sending' row doesn't leak into the reaper test (shared DB)
  });

  it("reapStaleOutboundSending requeues a row orphaned in 'sending' (never drops an owner message)", () => {
    const id = enqueueOutbound("a", "C123", "hi");
    expect(claimOutbound(id)).toBe(true); // now 'sending', then the process 'dies' before markOutboundSent
    const recovered = reapStaleOutboundSending();
    expect(recovered).toBe(1);
    expect(orow(id).status).toBe("queued"); // back in the queue for retry, not lost
    expect(listOutboundQueued().map((i) => i.id)).toContain(id);
  });

  it("markOutboundFailed requeues with +1 attempt until the cap, then fails (only acts on a CLAIMED row)", () => {
    const id = enqueueOutbound("a", "C123", "hi");
    // markOutboundFailed now guards on status='sending', so a real retry cycle is claim -> fail:
    // claim (queued->sending), then fail (sending->queued, attempts++). attempts 0->5 stay 'queued'
    // (CASE WHEN attempts>=5 evaluated on the OLD value); the call seeing attempts=5 flips to 'failed'.
    for (let i = 1; i <= 5; i++) {
      expect(claimOutbound(id)).toBe(true); // queued -> sending
      markOutboundFailed(id, "net"); // sending -> queued
      expect(orow(id)).toEqual({ status: "queued", attempts: i }); // still retryable
    }
    expect(claimOutbound(id)).toBe(true); // queued -> sending
    markOutboundFailed(id, "net"); // now sees attempts=5 -> failed terminal
    expect(orow(id).status).toBe("failed");
    expect(orow(id).attempts).toBe(6);
  });

  it("markOutboundFailed CANNOT resurrect a terminal row (defence-in-depth WHERE status='sending' guard)", () => {
    const id = enqueueOutbound("a", "C123", "hi");
    claimOutbound(id);
    markOutboundSent(id); // row is now terminal 'sent'
    markOutboundFailed(id, "late throw"); // must be a NO-OP: cannot flip a sent row back to queued
    expect(orow(id).status).toBe("sent"); // stayed sent, not resurrected
  });
});

// helper: backdate a row's created_at so staleness can be exercised deterministically
const backdate = (id: number, secsAgo: number) =>
  getDb().prepare(`UPDATE inbound_queue SET created_at=unixepoch()-? WHERE id=?`).run(secsAgo, id);

describe("listQueued delivery-priority (owner channel first)", () => {
  it("returns source='channel' ahead of older non-channel rows, FIFO within class", () => {
    // Enqueue in an order that would put the owner message LAST under a flat id-ASC.
    const sched1 = enqueueInbound({ agentId: "z", source: "scheduler", prompt: "heartbeat-1" })!;
    const bus1 = enqueueInbound({ agentId: "z", source: "bus", prompt: "peer-1" })!;
    const owner1 = enqueueInbound({ agentId: "z", source: "channel", prompt: "owner-first" })!;
    const owner2 = enqueueInbound({ agentId: "z", source: "channel", prompt: "owner-second" })!;
    const ids = listQueued("z").map((i) => i.id);
    // both owner messages ahead of the two older non-channel rows...
    expect(ids.indexOf(owner1)).toBeLessThan(ids.indexOf(sched1));
    expect(ids.indexOf(owner1)).toBeLessThan(ids.indexOf(bus1));
    expect(ids.indexOf(owner2)).toBeLessThan(ids.indexOf(sched1));
    // ...and FIFO among themselves (owner1 enqueued before owner2), and among the rest (sched before bus)
    expect(ids.indexOf(owner1)).toBeLessThan(ids.indexOf(owner2));
    expect(ids.indexOf(sched1)).toBeLessThan(ids.indexOf(bus1));
  });
});

describe("reapStaleScheduler", () => {
  it("fails only stale queued scheduler rows; leaves fresh scheduler and non-scheduler alone", () => {
    const staleSched = enqueueInbound({ agentId: "s", source: "scheduler", prompt: "moot briefing" })!;
    const freshSched = enqueueInbound({ agentId: "s", source: "scheduler", prompt: "recent heartbeat" })!;
    const staleOwner = enqueueInbound({ agentId: "s", source: "channel", prompt: "old owner msg" })!;
    const staleBus = enqueueInbound({ agentId: "s", source: "bus", prompt: "old peer msg" })!;
    backdate(staleSched, 3 * 60 * 60); // 3h old
    backdate(staleOwner, 3 * 60 * 60);
    backdate(staleBus, 3 * 60 * 60);
    // freshSched left at ~now
    const dropped = reapStaleScheduler(2 * 60 * 60); // 2h threshold
    expect(dropped).toBe(1); // only the stale scheduler row
    expect(row(staleSched).status).toBe("failed");
    expect(row(freshSched).status).toBe("queued"); // too young
    expect(row(staleOwner).status).toBe("queued"); // owner never age-dropped
    expect(row(staleBus).status).toBe("queued"); // bus never age-dropped
  });

  it("maxAgeSec <= 0 disables the sweep entirely (no rows touched)", () => {
    const s = enqueueInbound({ agentId: "s2", source: "scheduler", prompt: "old" })!;
    backdate(s, 10 * 60 * 60);
    expect(reapStaleScheduler(0)).toBe(0);
    expect(reapStaleScheduler(-1)).toBe(0);
    expect(row(s).status).toBe("queued");
  });
});

const setAlarmedAgo = (id: number, secsAgo: number) =>
  getDb().prepare(`UPDATE inbound_queue SET owner_alarmed_at=unixepoch()-? WHERE id=?`).run(secsAgo, id);
const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe("listOwnerAlarmable — an owner message must never go unheard (dropped OR merely stuck)", () => {
  const STALE = 15 * 60; // 15 min
  const REALARM = 30 * 60; // 30 min

  it("returns a DROPPED (failed) channel row that was never alarmed, once", () => {
    const id = enqueueInbound({ agentId: "d", source: "channel", prompt: "dropped owner msg" })!;
    markFailed(id, "dirty-pane");
    const got = listOwnerAlarmable(STALE, REALARM).find((r) => r.id === id)!;
    expect(got).toBeTruthy();
    expect(got.dropped).toBe(true);
    // once alarmed, it drops out
    markOwnerAlarmed(id);
    expect(ids(listOwnerAlarmable(STALE, REALARM))).not.toContain(id);
  });

  it("returns a QUEUED channel row older than staleSec — THE 2026-08-04 CASE (never failed, just stuck)", () => {
    const stuck = enqueueInbound({ agentId: "q", source: "channel", prompt: "queued behind a modal" })!;
    const fresh = enqueueInbound({ agentId: "q", source: "channel", prompt: "just arrived" })!;
    backdate(stuck, STALE + 60); // 16 min old, still status=queued
    const got = listOwnerAlarmable(STALE, REALARM);
    expect(ids(got)).toContain(stuck);
    expect(got.find((r) => r.id === stuck)!.dropped).toBe(false); // a stall, not a drop
    expect(ids(got)).not.toContain(fresh); // too young
  });

  it("a stuck queued row alarmed recently is NOT re-alarmed until realarmSec passes", () => {
    const id = enqueueInbound({ agentId: "r", source: "channel", prompt: "still stuck" })!;
    backdate(id, STALE + 600);
    setAlarmedAgo(id, REALARM - 60); // alarmed 29 min ago (< 30 min realarm)
    expect(ids(listOwnerAlarmable(STALE, REALARM))).not.toContain(id);
    setAlarmedAgo(id, REALARM + 60); // now 31 min ago -> due again
    expect(ids(listOwnerAlarmable(STALE, REALARM))).toContain(id);
  });

  it("never returns non-channel rows, delivered rows, or fresh queued rows", () => {
    const sched = enqueueInbound({ agentId: "n", source: "scheduler", prompt: "hb" })!;
    markFailed(sched, "whatever"); // failed but NOT channel
    const bus = enqueueInbound({ agentId: "n", source: "bus", prompt: "peer" })!;
    backdate(bus, STALE + 600); // old but NOT channel
    const delivered = enqueueInbound({ agentId: "n", source: "channel", prompt: "handled" })!;
    markDelivering(delivered);
    markDelivered(delivered);
    backdate(delivered, STALE + 600);
    const got = ids(listOwnerAlarmable(STALE, REALARM));
    expect(got).not.toContain(sched);
    expect(got).not.toContain(bus);
    expect(got).not.toContain(delivered);
  });
});
