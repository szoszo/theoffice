import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
