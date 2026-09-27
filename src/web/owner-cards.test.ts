import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, getDb } from "../db/index.js";
import {
  createCard,
  getCard,
  listCards,
  addComment,
  patchComment,
  dropCard,
  closeCard,
  sendTray,
  renderText,
  createBatchTicker,
  DEFAULT_BATCH_CRON,
  MAX_TITLE,
  MAX_BODY,
  MAX_OPTIONS,
} from "./owner-cards.js";
import { migrateOwnerCards } from "../../scripts/migrate-owner-cards.js";

const AGENTS = ["cfo", "pam", "darryl", "marveen"];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-cards-"));
  openDb(join(dir, "test.db")); // runs migrations -> owner_cards + owner_card_comments exist
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM owner_card_comments").run();
  db.prepare("DELETE FROM owner_cards").run();
  db.prepare("DELETE FROM kanban_cards").run();
  db.prepare("DELETE FROM agent_messages").run();
});

function mkCard(agent = "cfo", overrides: Partial<Parameters<typeof createCard>[0]> = {}) {
  const r = createCard({ agent, kind: "question", title: "t", body: "b", ...overrides }, AGENTS);
  expect(r.ok).toBe(true);
  return r.id as string;
}

describe("1. create() validation", () => {
  it("rejects title > 80 chars", () => {
    const r = createCard({ agent: "cfo", kind: "question", title: "x".repeat(81) }, AGENTS);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
    expect(r.error).toContain(String(MAX_TITLE));
  });
  it("rejects body > 600 chars", () => {
    const r = createCard({ agent: "cfo", kind: "question", title: "t", body: "x".repeat(601) }, AGENTS);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
    expect(r.error).toContain(String(MAX_BODY));
  });
  it("rejects more than 5 options", () => {
    const r = createCard({ agent: "cfo", kind: "question", title: "t", options: ["a", "b", "c", "d", "e", "f"] }, AGENTS);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
    expect(r.error).toContain(String(MAX_OPTIONS));
  });
  it("rejects an unknown kind", () => {
    const r = createCard({ agent: "cfo", kind: "bogus", title: "t" }, AGENTS);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
    expect(r.error).toContain("kind");
  });
  it("rejects an unknown agent", () => {
    const r = createCard({ agent: "ghost", kind: "question", title: "t" }, AGENTS);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
    expect(r.error).toContain("agent");
  });
});

describe("2. owner comments", () => {
  it("owner comment on an open card moves it to answered", () => {
    const id = mkCard();
    const r = addComment(id, { author: "szoszo", text: "answer", tray: "now" });
    expect(r.ok).toBe(true);
    expect(getCard(id)!.card.status).toBe("answered");
  });
  it("owner comment without tray -> 400", () => {
    const id = mkCard();
    const r = addComment(id, { author: "szoszo", text: "answer" } as any);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
  });
  it("text > 10000 chars -> 400", () => {
    const id = mkCard();
    const r = addComment(id, { author: "szoszo", text: "x".repeat(10001), tray: "now" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(400);
  });
});

describe("3. send('now') bundling", () => {
  it("3 unsent comments on 2 cfo cards + 1 pam card -> exactly 2 messages, cfo's has both headers + full text", () => {
    const c1 = mkCard("cfo", { title: "cfo card one" });
    const c2 = mkCard("cfo", { title: "cfo card two" });
    const p1 = mkCard("pam", { title: "pam card" });
    const bigText = "y".repeat(5000);
    addComment(c1, { author: "szoszo", text: "short answer one", tray: "now" });
    addComment(c2, { author: "szoszo", text: bigText, tray: "now" });
    addComment(p1, { author: "szoszo", text: "pam answer", tray: "now" });

    const res = sendTray("now");
    expect(res.sent).toBe(3);
    expect(res.agents).toBe(2);

    const msgs = getDb().prepare(`SELECT * FROM agent_messages WHERE from_agent='szoszo-board'`).all() as any[];
    expect(msgs.length).toBe(2);
    const cfoMsg = msgs.find((m) => m.to_agent === "cfo")!;
    expect(cfoMsg).toBeTruthy();
    expect(cfoMsg.content).toContain("cfo card one");
    expect(cfoMsg.content).toContain("cfo card two");
    expect(cfoMsg.content).toContain("short answer one");
    expect(cfoMsg.content).toContain(bigText); // in FULL, no truncation
    const pamMsg = msgs.find((m) => m.to_agent === "pam")!;
    expect(pamMsg.content).toContain("pam answer");
  });
});

describe("4. send() respects tray", () => {
  it("send('now') ignores batch comments and vice versa", () => {
    const id = mkCard("cfo");
    addComment(id, { author: "szoszo", text: "now-answer", tray: "now" });
    addComment(id, { author: "szoszo", text: "batch-answer", tray: "batch" });

    const now = sendTray("now");
    expect(now.sent).toBe(1);
    const afterNow = getDb().prepare(`SELECT * FROM agent_messages`).all() as any[];
    expect(afterNow.length).toBe(1);
    expect(afterNow[0].content).toContain("now-answer");
    expect(afterNow[0].content).not.toContain("batch-answer");

    const batch = sendTray("batch");
    expect(batch.sent).toBe(1);
    const afterBatch = getDb().prepare(`SELECT * FROM agent_messages`).all() as any[];
    expect(afterBatch.length).toBe(2);
  });
});

describe("5. drop", () => {
  it("drop -> next send('now') includes DROPPED; status stays dropped; comment sent_at set", () => {
    const id = mkCard("cfo");
    const dr = dropCard(id, { note: "no longer relevant" });
    expect(dr.ok).toBe(true);
    expect(getCard(id)!.card.status).toBe("dropped");

    const res = sendTray("now");
    expect(res.sent).toBe(1);
    const msg = getDb().prepare(`SELECT * FROM agent_messages WHERE from_agent='szoszo-board'`).get() as any;
    expect(msg.content).toContain("DROPPED");

    expect(getCard(id)!.card.status).toBe("dropped");
    const comment = getDb().prepare(`SELECT * FROM owner_card_comments WHERE card_id=?`).get(id) as any;
    expect(comment.sent_at).not.toBeNull();
  });
});

describe("6. send() with zero comments", () => {
  it("returns 0 calls", () => {
    const res = sendTray("now");
    expect(res).toEqual({ sent: 0, agents: 0 });
  });
});

describe("7. per-agent send failure isolation", () => {
  it("a throwing send for one agent leaves its comments unsent + card answered, still sends others", () => {
    const cfoId = mkCard("cfo");
    const pamId = mkCard("pam");
    addComment(cfoId, { author: "szoszo", text: "to cfo", tray: "now" });
    addComment(pamId, { author: "szoszo", text: "to pam", tray: "now" });

    const res = sendTray("now", {
      send: (from, to, content) => {
        if (to === "cfo") throw new Error("boom");
        return getDb().prepare(`INSERT INTO agent_messages (from_agent, to_agent, content) VALUES (?, ?, ?)`).run(from, to, content).lastInsertRowid as number;
      },
    });
    expect(res.sent).toBe(1);
    expect(res.agents).toBe(1);

    expect(getCard(cfoId)!.card.status).toBe("answered"); // unsent, untouched
    const cfoComment = getDb().prepare(`SELECT * FROM owner_card_comments WHERE card_id=?`).get(cfoId) as any;
    expect(cfoComment.sent_at).toBeNull();

    expect(getCard(pamId)!.card.status).toBe("sent");
  });
});

describe("8. agent comments and needs_you", () => {
  it("needs_you=1 on a sent card -> open; without it -> unchanged", () => {
    const id = mkCard("cfo");
    addComment(id, { author: "szoszo", text: "answer", tray: "now" });
    sendTray("now");
    expect(getCard(id)!.card.status).toBe("sent");

    addComment(id, { author: "cfo", text: "follow-up question", needs_you: 1 });
    expect(getCard(id)!.card.status).toBe("open");

    // reset to sent, then comment WITHOUT needs_you
    getDb().prepare(`UPDATE owner_cards SET status='sent' WHERE id=?`).run(id);
    addComment(id, { author: "cfo", text: "done, thanks" });
    expect(getCard(id)!.card.status).toBe("sent");
  });
});

describe("9. PATCH an already-sent comment", () => {
  it("-> 409", () => {
    const id = mkCard("cfo");
    addComment(id, { author: "szoszo", text: "answer", tray: "now" });
    const comment = getDb().prepare(`SELECT id FROM owner_card_comments WHERE card_id=?`).get(id) as any;
    sendTray("now");
    const r = patchComment(comment.id, { text: "edited" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(409);
  });
  it("allows editing an unsent comment", () => {
    const id = mkCard("cfo");
    addComment(id, { author: "szoszo", text: "answer", tray: "now" });
    const comment = getDb().prepare(`SELECT id FROM owner_card_comments WHERE card_id=?`).get(id) as any;
    const r = patchComment(comment.id, { text: "edited", tray: "batch" });
    expect(r.ok).toBe(true);
    const row = getDb().prepare(`SELECT * FROM owner_card_comments WHERE id=?`).get(comment.id) as any;
    expect(row.text).toBe("edited");
    expect(row.tray).toBe("batch");
  });
});

describe("10. close", () => {
  it("close via slack from open -> closed", () => {
    const id = mkCard("cfo");
    const r = closeCard(id, { via: "slack" });
    expect(r.ok).toBe(true);
    const c = getCard(id)!.card;
    expect(c.status).toBe("closed");
    expect(c.closed_via).toBe("slack");
  });
  it("close from a non-open status -> 409 naming current status", () => {
    const id = mkCard("cfo");
    closeCard(id, { via: "slack" });
    const r = closeCard(id, { via: "slack" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(409);
    expect(r.error).toContain("closed");
  });
});

describe("11. renderText — escape then linkify", () => {
  it("a <script> tag renders as text, never HTML", () => {
    const out = renderText("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
  it("a bare URL renders as a clickable link", () => {
    const out = renderText("see https://x.y/a?b=1 for details");
    expect(out).toContain('<a href="https://x.y/a?b=1"');
    expect(out).toContain("target=\"_blank\"");
  });
});

describe("12. migration of old owner cards", () => {
  it("migrates only assignee='szoszo' rows, maps status/closed_via, is idempotent", () => {
    const db = getDb();
    const ins = db.prepare(
      `INSERT INTO kanban_cards (id, title, description, status, assignee, archived_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    ins.run("k1", "live planned for szoszo", "d1", "planned", "szoszo", null);
    ins.run("k2", "done for szoszo", "d2", "done", "szoszo", null);
    ins.run("k3", "archived waiting for szoszo", "d3", "waiting", "szoszo", Math.floor(Date.now() / 1000));
    ins.run("k4", "darryl's own card", "d4", "planned", "darryl", null);
    const kanbanCountBefore = (db.prepare(`SELECT COUNT(*) n FROM kanban_cards`).get() as any).n;

    const first = migrateOwnerCards();
    expect(first.migrated).toBe(3);
    expect(first.open).toBe(1);
    expect(first.closed).toBe(2);
    expect(first.skipped).toBe(0);

    const rows = db.prepare(`SELECT * FROM owner_cards ORDER BY source_kanban_id`).all() as any[];
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.agent === "marveen" && r.kind === "task")).toBe(true);
    expect(rows.find((r) => r.source_kanban_id === "k1")!.status).toBe("open");
    expect(rows.find((r) => r.source_kanban_id === "k2")!.status).toBe("closed");
    expect(rows.find((r) => r.source_kanban_id === "k2")!.closed_via).toBe("kanban");
    expect(rows.find((r) => r.source_kanban_id === "k3")!.status).toBe("closed");
    expect(rows.find((r) => r.source_kanban_id === "k4")).toBeUndefined();

    const second = migrateOwnerCards();
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(3);

    const kanbanCountAfter = (db.prepare(`SELECT COUNT(*) n FROM kanban_cards`).get() as any).n;
    expect(kanbanCountAfter).toBe(kanbanCountBefore); // read-only on kanban_cards
  });
});

describe("13. batch timer", () => {
  it("fires once at 06:00 Budapest, not twice in the same minute, not at 06:00 UTC", () => {
    let fires = 0;
    const tick = createBatchTicker(DEFAULT_BATCH_CRON, "Europe/Budapest", () => { fires++; });

    // 2026-09-27 06:00 Europe/Budapest == 04:00 UTC (CEST, UTC+2)
    const at0600Budapest = Date.parse("2026-09-27T04:00:00.000Z");
    tick(at0600Budapest);
    expect(fires).toBe(1);
    tick(at0600Budapest + 30_000); // same minute, second tick
    expect(fires).toBe(1);

    // 06:00 UTC is 08:00 Budapest — not one of the three cron times
    fires = 0;
    const tick2 = createBatchTicker(DEFAULT_BATCH_CRON, "Europe/Budapest", () => { fires++; });
    tick2(Date.parse("2026-09-27T06:00:00.000Z"));
    expect(fires).toBe(0);
  });
});

describe("14. sanity: default agent listing helper is not required for kanban", () => {
  it("owner_cards table is fully separate from kanban_cards (no shared writes)", () => {
    const before = (getDb().prepare(`SELECT COUNT(*) n FROM kanban_cards`).get() as any).n;
    mkCard("cfo");
    const after = (getDb().prepare(`SELECT COUNT(*) n FROM kanban_cards`).get() as any).n;
    expect(after).toBe(before);
  });
});
