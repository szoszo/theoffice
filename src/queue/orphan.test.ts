import { describe, it, expect } from "vitest";
import { decideOrphan, type OrphanRow, type SessionSnapshot, type OrphanOpts } from "./orphan.js";

/**
 * Safety tests for orphan-requeue (kanban aba29f60). Every case here is a case where getting it wrong
 * re-sends real messages to a live fleet, so the bias under test is: LEAVE unless certain.
 *
 * Anchored on the incident: owner Slack msg 9766 was delivered to marveen at 11:02:18, marveen was
 * OOM-killed at 11:36:03, and was relaunched at 11:37:59 as a NEW session with none of the context.
 * The engine considered the message handled; the owner waited 36 minutes.
 */

const NOW = 1_785_580_000;
const HOUR = 3600;

const row = (o: Partial<OrphanRow> = {}): OrphanRow => ({
  delivered_at: NOW - 600,
  session_ref: "sess-A",
  requeues: 0,
  ...o,
});
const snap = (o: Partial<SessionSnapshot> = {}): SessionSnapshot => ({ state: "absent", ref: null, ...o });
const opts = (o: Partial<OrphanOpts> = {}): OrphanOpts => ({
  lastOutboundAt: null,
  now: NOW,
  maxAgeSec: 6 * HOUR,
  maxRequeues: 1,
  ...o,
});

describe("decideOrphan — the requeue case", () => {
  it("requeues when the receiving session is CONFIRMED ABSENT and the agent never worked past it", () => {
    expect(decideOrphan(row(), snap({ state: "absent" }), opts())).toBe("requeue");
  });

  it("requeues when the agent is back but as a DIFFERENT instance — the 9766 case", () => {
    // marveen was 'present' by the time anyone looked; it was simply a new session with no context.
    // Keying on existence rather than identity would have missed the real incident entirely.
    expect(decideOrphan(row({ session_ref: "sess-A" }), snap({ state: "present", ref: "sess-B" }), opts())).toBe(
      "requeue",
    );
  });
});

describe("decideOrphan — refusals to act (the important half)", () => {
  it("NEVER requeues on 'unknown' — a timed-out tmux probe is not proof of death", () => {
    expect(decideOrphan(row(), snap({ state: "unknown" }), opts())).toBe("leave");
  });

  it("leaves the message alone while the SAME session instance is still running", () => {
    expect(decideOrphan(row({ session_ref: "sess-A" }), snap({ state: "present", ref: "sess-A" }), opts())).toBe(
      "leave",
    );
  });

  it("leaves rows with no session_ref — the 2,084 historical orphans are out of scope BY CONSTRUCTION", () => {
    expect(decideOrphan(row({ session_ref: null }), snap({ state: "absent" }), opts())).toBe("leave");
  });

  it("leaves anything older than the recency bound", () => {
    expect(decideOrphan(row({ delivered_at: NOW - 7 * HOUR }), snap(), opts({ maxAgeSec: 6 * HOUR }))).toBe("leave");
  });

  it("THE SAFETY GATE: leaves it when the agent produced output AFTER delivery (it was worked on)", () => {
    const r = row({ delivered_at: NOW - 600 });
    expect(decideOrphan(r, snap(), opts({ lastOutboundAt: NOW - 300 }))).toBe("leave");
  });

  it("still requeues when the agent's last output PREDATES delivery (genuinely unanswered)", () => {
    // The literal 9766 shape: last outbound 12 min BEFORE the message arrived.
    const r = row({ delivered_at: NOW - 600 });
    expect(decideOrphan(r, snap(), opts({ lastOutboundAt: NOW - 1320 }))).toBe("requeue");
  });

  it("a silent agent (no outbound ever) does not block the requeue", () => {
    expect(decideOrphan(row(), snap(), opts({ lastOutboundAt: null }))).toBe("requeue");
  });
});

describe("decideOrphan — the hard cap is structural, not advisory", () => {
  it("parks instead of requeuing once the cap is spent", () => {
    expect(decideOrphan(row({ requeues: 1 }), snap(), opts({ maxRequeues: 1 }))).toBe("park");
  });

  it("never returns 'requeue' twice for the same message — the kill-loop guard", () => {
    // An agent OOM-killed BY a message, then re-fed that same message on relaunch, is self-reinforcing.
    let r = row({ requeues: 0 });
    const first = decideOrphan(r, snap(), opts());
    expect(first).toBe("requeue");
    r = { ...r, requeues: r.requeues + 1 }; // as persisted by the requeue
    expect(decideOrphan(r, snap(), opts())).toBe("park");
  });

  it("a park does not decay back into a requeue however many times it is evaluated", () => {
    const r = row({ requeues: 5 });
    for (let i = 0; i < 5; i++) expect(decideOrphan(r, snap(), opts())).toBe("park");
  });

  it("refusals still outrank the cap: an unknown session parks nothing and requeues nothing", () => {
    expect(decideOrphan(row({ requeues: 9 }), snap({ state: "unknown" }), opts())).toBe("leave");
  });
});
