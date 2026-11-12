import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import { enqueueInbound, listQueued } from "../queue/index.js";
import { sendAgentMessage, deliverPendingMessages } from "./index.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-bus-"));
  openDb(join(dir, "test.db"));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("inbound queue dedup", () => {
  it("enqueues once per dedup key", () => {
    const a = enqueueInbound({ agentId: "cfo", source: "channel", prompt: "hi", dedupKey: "k1" });
    const b = enqueueInbound({ agentId: "cfo", source: "channel", prompt: "hi again", dedupKey: "k1" });
    expect(a).toBeTypeOf("number");
    expect(b).toBeUndefined(); // suppressed
  });

  it("allows multiple null-dedup items", () => {
    const a = enqueueInbound({ agentId: "pam", source: "manual", prompt: "one" });
    const b = enqueueInbound({ agentId: "pam", source: "manual", prompt: "two" });
    expect(a).toBeTypeOf("number");
    expect(b).toBeTypeOf("number");
  });
});

describe("inter-agent bus", () => {
  it("delivers pending messages to the queue and flips status to delivered", () => {
    const msgId = sendAgentMessage("jim", "ryan", "pull the Q2 lead list");
    deliverPendingMessages();

    const status = (getDb().prepare(`SELECT status FROM agent_messages WHERE id=?`).get(msgId) as { status: string }).status;
    expect(status).toBe("delivered");

    const queuedForRyan = listQueued("ryan");
    // wrap() now prefixes "[Message from <sender>]" — the sender's display name when a cfg is available,
    // else the raw agent id (here "jim", since deliverPendingMessages runs without startBus capturing cfg).
    expect(queuedForRyan.some((q) => q.prompt.includes("pull the Q2 lead list") && q.prompt.includes("from jim"))).toBe(true);
  });

  it("is idempotent — re-running does not double-enqueue", () => {
    const before = listQueued("ryan").length;
    deliverPendingMessages(); // nothing pending now
    expect(listQueued("ryan").length).toBe(before);
  });
});

// --- BUS DROP NOTICE (owner GO 2026-11-13, Toby SAFE with 5 conditions): the sender hears ONE short notice when the bus drops its message ---
import { __setBusLiveCheck } from "./index.js";

const noticesFor = (agent: string) => listQueued(agent, 200).filter((q) => q.prompt.startsWith("[BUS DROPPED") || q.prompt.startsWith("[BUS HELD"));
const rows = () => (getDb().prepare(`SELECT COUNT(*) n FROM agent_messages`).get() as { n: number }).n;
const send = (from: string, to: string, n: number) => { for (let i = 0; i < n; i++) sendAgentMessage(from, to, `bulk ${i}`); };

describe("bus drop notice", () => {
  beforeEach(() => { getDb().prepare(`DELETE FROM agent_messages`).run(); getDb().prepare(`DELETE FROM inbound_queue`).run(); __setBusLiveCheck(null); });
  it("9+ messages on one pair: the breaker drops the excess, the SENDER gets exactly one notice, no new agent_messages rows, nothing to the recipient", () => {
    __setBusLiveCheck(null);
    send("pam1", "toby1", 12);
    const before = rows();
    deliverPendingMessages();
    expect(rows()).toBe(before); // the notice is never an agent_messages row (it would feed the pair count)
    const failed = (getDb().prepare(`SELECT COUNT(*) n FROM agent_messages WHERE from_agent='pam1' AND status='failed'`).get() as { n: number }).n;
    expect(failed).toBeGreaterThan(0);
    const n = noticesFor("pam1");
    expect(n.length).toBe(1);
    expect(n[0].prompt).toMatch(/no reply needed/i);
    expect(n[0].prompt).toMatch(/do not message toby1 about it/i);
    expect(n[0].prompt).toMatch(/wait ~?5 min.*ONE bundle/i);
    expect(noticesFor("toby1").length).toBe(0);
    expect(listQueued("toby1", 200).some((q) => /BUS DROPPED/.test(q.prompt))).toBe(false);
  });

  it("a restart inside the window still gives one notice (the dedup key lives in the queue, not in memory)", () => {
    send("pam1", "toby1", 12); deliverPendingMessages();
    expect(noticesFor("pam1").length).toBe(1);
    send("pam1", "toby1", 5); deliverPendingMessages(); deliverPendingMessages(); // more drops later in the same window, and a "restart" (the module has no memory of the first notice)
    expect(noticesFor("pam1").length).toBe(1);
  });

  it("no notice when sender == recipient, when the recipient is not a live agent, or when the sender is not a live agent", () => {
    __setBusLiveCheck((id) => id !== "ghost1" && id !== "watchd1");
    send("ann1", "ann1", 12); deliverPendingMessages();
    expect(noticesFor("ann1").length).toBe(0);
    send("bob1", "ghost1", 12); deliverPendingMessages();
    expect(noticesFor("bob1").length).toBe(0);
    send("watchd1", "toby1", 12); deliverPendingMessages();
    expect(noticesFor("watchd1").length).toBe(0);
    __setBusLiveCheck(null);
  });

  it("GLOBAL trip: messages stay pending (silent today); now each distinct sender gets ONE notice per trip, none to recipients", () => {
    __setBusLiveCheck(null);
    send("s1", "r1", 25); send("s2", "r2", 25);
    const pendingBefore = (getDb().prepare(`SELECT COUNT(*) n FROM agent_messages WHERE status='pending'`).get() as { n: number }).n;
    expect(deliverPendingMessages()).toBe(0);
    expect((getDb().prepare(`SELECT COUNT(*) n FROM agent_messages WHERE status='pending'`).get() as { n: number }).n).toBe(pendingBefore);
    deliverPendingMessages();
    expect(noticesFor("s1").length).toBe(1);
    expect(noticesFor("s2").length).toBe(1);
    expect(noticesFor("r1").length).toBe(0);
  });
});
