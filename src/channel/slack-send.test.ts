import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { enqueueOutbound } from "../queue/index.js";
import { makeOutboundTick } from "./slack-send.js";

// A postMessage stub that hangs until released — models a Slack call slower than TICK_MS, which is
// the exact condition that let the next interval fire mid-post and re-drain the still-'queued' row.
function hangingPost() {
  const releases: Array<() => void> = [];
  const calls: Array<{ agent_id: string; channel: string; text: string }> = [];
  const post = vi.fn(async (item: { agent_id: string; channel: string; text: string }) => {
    calls.push(item);
    await new Promise<void>((r) => releases.push(r));
  });
  return { post, calls, releaseAll: () => releases.forEach((r) => r()) };
}

let dir: string;
const orow = (id: number) =>
  getDb().prepare(`SELECT status, attempts FROM outbound_queue WHERE id=?`).get(id) as { status: string; attempts: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-slacksend-"));
  openDb(join(dir, "test.db"));
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("outbound double-post race", () => {
  it("two overlapping ticks post ONE queued row exactly once (slow postMessage)", async () => {
    const id = enqueueOutbound("a", "C123", "long message that Slack accepts slowly");
    const { post, releaseAll } = hangingPost();
    const tick = makeOutboundTick({ post, hasWeb: () => true });

    // Tick A starts, claims the row, calls post -> hangs (Slack still working).
    const a = tick();
    // Tick B fires 1.5s later while A's post is still in flight — the real interval overlap.
    const b = tick();
    // Let both drains finish.
    releaseAll();
    await Promise.all([a, b]);

    expect(post).toHaveBeenCalledTimes(1); // exactly one Slack post for one queued row
    expect(orow(id).status).toBe("sent");
  });

  // Toby's required pair. A bookkeeping throw AFTER a confirmed post must never requeue+repost.
  it("T1: recordOutbound throws after a successful post -> row stays sent, ONE post, no re-post", async () => {
    const id = enqueueOutbound("a", "C123", "hi");
    const post = vi.fn(async () => {});
    const tick = makeOutboundTick({
      post,
      hasWeb: () => true,
      recordOut: () => { throw new Error("conversation-db write failed"); }, // throws AFTER markSent
    });
    await tick(); // post ok -> markSent sets 'sent' -> recordOut throws -> logged, NOT requeued
    await tick(); // second tick: 'sent' row must not be re-selected
    expect(post).toHaveBeenCalledTimes(1);
    expect(orow(id).status).toBe("sent"); // not flipped back to queued
  });

  it("T2: markOutboundSent throws after a successful post -> ONE post, no re-post (row sits 'sending' for the reaper)", async () => {
    const id = enqueueOutbound("a", "C123", "hi");
    const post = vi.fn(async () => {});
    const tick = makeOutboundTick({
      post,
      hasWeb: () => true,
      markSent: () => { throw new Error("db locked (SQLITE_BUSY)"); }, // throws right after the post
    });
    await tick(); // post ok -> markSent throws -> logged, NOT requeued; row remains 'sending'
    await tick(); // second tick: 'sending' row must NOT be re-selected (listOutboundQueued is status='queued')
    expect(post).toHaveBeenCalledTimes(1); // the accepted residual is a reaper-driven dup at NEXT BOOT, never a mid-run re-post
    expect(orow(id).status).toBe("sending"); // pending the boot reaper, not requeued mid-run
  });
});
