import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import {
  enqueueInbound,
  listQueued,
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
