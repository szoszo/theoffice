import { randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";
import { sendAgentMessage } from "../bus/index.js";
import { isDueNow, minuteKey } from "../scheduler/cron.js";
import { log } from "../logger.js";

/**
 * Owner Board v1.1 (spec: tenant/agents/marveen/OWNER-BOARD-SPEC.md, owner GO 2026-09-27). A board only
 * the owner uses: agents post short cards, he answers via a per-card comment thread and picks a tray
 * (NOW or BATCH) per answer. Sends bundle ALL of one agent's unsent comments for a tray into ONE bus
 * message, so an agent is woken at most once per send. Fully separate from kanban_cards (hard constraint):
 * no shared table, no shared endpoint, the migration script only READS kanban_cards.
 */

const logger = log("owner-cards");

export const KINDS = ["question", "task", "project", "fyi"] as const;
export type CardKind = (typeof KINDS)[number];
export const STATUSES = ["open", "answered", "sent", "closed", "dropped"] as const;
export type CardStatus = (typeof STATUSES)[number];
export const CLOSE_VIA = ["board", "slack", "agent", "kanban"] as const;

export const MAX_TITLE = 80;
export const MAX_BODY = 600;
export const MAX_OPTIONS = 5;
export const MAX_OPTION_LEN = 40;
export const MAX_COMMENT = 10000;

export interface OpResult {
  ok: boolean;
  code?: number;
  error?: string;
  id?: string | number;
}

export interface CardRow {
  id: string;
  kind: CardKind;
  agent: string;
  project: string | null;
  title: string;
  body: string | null;
  options: string | null;
  status: CardStatus;
  closed_via: string | null;
  source_kanban_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CommentRow {
  id: number;
  card_id: string;
  author: string;
  text: string;
  tray: "now" | "batch" | null;
  sent_at: number | null;
  created_at: number;
}

// ---------------- create ----------------

export interface CreateArgs {
  agent: string;
  kind: string;
  title: string;
  body?: string | null;
  project?: string | null;
  options?: string[] | null;
}

/** knownAgents is injected (not loaded here) so this stays a pure, testable function — no EngineConfig needed. */
export function createCard(a: CreateArgs, knownAgents: readonly string[]): OpResult {
  if (!(KINDS as readonly string[]).includes(a.kind)) {
    return { ok: false, code: 400, error: `kind must be one of ${KINDS.join("|")} (got ${JSON.stringify(a.kind)})` };
  }
  if (!knownAgents.includes(a.agent)) {
    return { ok: false, code: 400, error: `unknown agent '${a.agent}'` };
  }
  if (!a.title || a.title.length > MAX_TITLE) {
    return { ok: false, code: 400, error: `title required and must be <= ${MAX_TITLE} chars (got ${a.title?.length ?? 0})` };
  }
  if (a.body != null && a.body.length > MAX_BODY) {
    return { ok: false, code: 400, error: `body must be <= ${MAX_BODY} chars (got ${a.body.length})` };
  }
  let optionsJson: string | null = null;
  if (a.options != null) {
    if (
      !Array.isArray(a.options) ||
      a.options.length > MAX_OPTIONS ||
      a.options.some((o) => typeof o !== "string" || o.length > MAX_OPTION_LEN)
    ) {
      return {
        ok: false,
        code: 400,
        error: `options must be an array of at most ${MAX_OPTIONS} strings, each <= ${MAX_OPTION_LEN} chars`,
      };
    }
    optionsJson = JSON.stringify(a.options);
  }
  const id = randomBytes(4).toString("hex");
  getDb()
    .prepare(
      `INSERT INTO owner_cards (id, kind, agent, project, title, body, options) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, a.kind, a.agent, a.project ?? null, a.title, a.body ?? null, optionsJson);
  return { ok: true, id };
}

// ---------------- read ----------------

export interface CardWithComments {
  card: CardRow;
  comments: CommentRow[];
}

export function getCard(id: string): CardWithComments | null {
  const card = getDb().prepare(`SELECT * FROM owner_cards WHERE id=?`).get(id) as CardRow | undefined;
  if (!card) return null;
  const comments = getDb()
    .prepare(`SELECT * FROM owner_card_comments WHERE card_id=? ORDER BY created_at ASC, id ASC`)
    .all(id) as CommentRow[];
  return { card, comments };
}

export interface ListArgs {
  status?: string | null;
  all?: boolean;
}

const SEVEN_DAYS_SEC = 7 * 86400;

/** Default: everything except sent/closed/dropped older than 7 days. all=1 returns everything. */
export function listCards(a: ListArgs = {}): (CardRow & { comment_count: number })[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (a.status) {
    where.push("status = ?");
    args.push(a.status);
  }
  if (!a.all) {
    where.push("(status NOT IN ('sent','closed','dropped') OR updated_at >= unixepoch() - ?)");
    args.push(SEVEN_DAYS_SEC);
  }
  const sql = `SELECT c.*, (SELECT COUNT(*) FROM owner_card_comments occ WHERE occ.card_id=c.id) AS comment_count
               FROM owner_cards c ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY c.created_at DESC`;
  return getDb().prepare(sql).all(...args) as (CardRow & { comment_count: number })[];
}

// ---------------- comments ----------------

export interface OwnerCommentArgs {
  author: "szoszo";
  text: string;
  tray: "now" | "batch";
}
export interface AgentCommentArgs {
  author: string;
  text: string;
  needs_you?: 0 | 1;
}

export function addComment(cardId: string, a: OwnerCommentArgs | AgentCommentArgs): OpResult {
  const card = getDb().prepare(`SELECT status FROM owner_cards WHERE id=?`).get(cardId) as { status: CardStatus } | undefined;
  if (!card) return { ok: false, code: 404, error: `card not found: ${cardId}` };
  if (card.status === "dropped") return { ok: false, code: 409, error: `card is dropped (current status: ${card.status})` };
  if (!a.text || a.text.length < 1 || a.text.length > MAX_COMMENT) {
    return { ok: false, code: 400, error: `text must be 1-${MAX_COMMENT} chars (got ${a.text?.length ?? 0})` };
  }

  const isOwner = a.author === "szoszo";
  if (isOwner) {
    const tray = (a as OwnerCommentArgs).tray;
    if (tray !== "now" && tray !== "batch") {
      return { ok: false, code: 400, error: `owner comment requires tray 'now' or 'batch' (got ${JSON.stringify(tray)})` };
    }
    const r = getDb()
      .prepare(`INSERT INTO owner_card_comments (card_id, author, text, tray) VALUES (?, 'szoszo', ?, ?)`)
      .run(cardId, a.text, tray);
    getDb().prepare(`UPDATE owner_cards SET status='answered', updated_at=unixepoch() WHERE id=?`).run(cardId);
    return { ok: true, id: Number(r.lastInsertRowid) };
  }

  // agent comment: tray is always NULL. needs_you=1 reopens; without it, status is untouched.
  const needsYou = (a as AgentCommentArgs).needs_you === 1;
  const r = getDb()
    .prepare(`INSERT INTO owner_card_comments (card_id, author, text, tray) VALUES (?, ?, ?, NULL)`)
    .run(cardId, a.author, a.text);
  if (needsYou) {
    getDb().prepare(`UPDATE owner_cards SET status='open', updated_at=unixepoch() WHERE id=?`).run(cardId);
  } else {
    getDb().prepare(`UPDATE owner_cards SET updated_at=unixepoch() WHERE id=?`).run(cardId);
  }
  return { ok: true, id: Number(r.lastInsertRowid) };
}

export interface PatchCommentArgs {
  text?: string;
  tray?: "now" | "batch";
}

/** Owner-only in practice: no CLI verb and no UI surface exposes this to an agent. Guarded here on sent_at. */
export function patchComment(commentId: number, a: PatchCommentArgs): OpResult {
  const row = getDb().prepare(`SELECT sent_at FROM owner_card_comments WHERE id=?`).get(commentId) as
    | { sent_at: number | null }
    | undefined;
  if (!row) return { ok: false, code: 404, error: `comment not found: ${commentId}` };
  if (row.sent_at !== null) return { ok: false, code: 409, error: `comment already sent` };

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (a.text !== undefined) {
    if (!a.text || a.text.length > MAX_COMMENT) return { ok: false, code: 400, error: `text must be 1-${MAX_COMMENT} chars` };
    sets.push("text=?");
    vals.push(a.text);
  }
  if (a.tray !== undefined) {
    if (a.tray !== "now" && a.tray !== "batch") return { ok: false, code: 400, error: `tray must be 'now' or 'batch'` };
    sets.push("tray=?");
    vals.push(a.tray);
  }
  if (sets.length === 0) return { ok: false, code: 400, error: "no updatable fields (text/tray only)" };
  getDb().prepare(`UPDATE owner_card_comments SET ${sets.join(", ")} WHERE id=?`).run(...vals, commentId);
  return { ok: true, id: commentId };
}

// ---------------- drop / close ----------------

export function dropCard(id: string, a: { note?: string } = {}): OpResult {
  const card = getDb().prepare(`SELECT status FROM owner_cards WHERE id=?`).get(id) as { status: CardStatus } | undefined;
  if (!card) return { ok: false, code: 404, error: `card not found: ${id}` };
  if (card.status !== "open" && card.status !== "answered") {
    return { ok: false, code: 409, error: `card must be open or answered to drop (current status: ${card.status})` };
  }
  const text = `DROPPED: ${a.note || "no note"}. Do not raise this again.`;
  getDb().prepare(`INSERT INTO owner_card_comments (card_id, author, text, tray) VALUES (?, 'szoszo', ?, 'now')`).run(id, text);
  getDb().prepare(`UPDATE owner_cards SET status='dropped', updated_at=unixepoch() WHERE id=?`).run(id);
  return { ok: true, id };
}

export function closeCard(id: string, a: { via: "slack" | "agent"; note?: string }): OpResult {
  if (a.via !== "slack" && a.via !== "agent") {
    return { ok: false, code: 400, error: `via must be 'slack' or 'agent'` };
  }
  const card = getDb().prepare(`SELECT status FROM owner_cards WHERE id=?`).get(id) as { status: CardStatus } | undefined;
  if (!card) return { ok: false, code: 404, error: `card not found: ${id}` };
  if (card.status !== "open") {
    return { ok: false, code: 409, error: `card must be open to close (current status: ${card.status})` };
  }
  getDb().prepare(`UPDATE owner_cards SET status='closed', closed_via=?, updated_at=unixepoch() WHERE id=?`).run(a.via, id);
  return { ok: true, id };
}

// ---------------- send / bundling ----------------

interface UnsentRow {
  comment_id: number;
  text: string;
  created_at: number;
  card_id: string;
  title: string;
  agent: string;
}

/** Pure: build one agent's full bundle text from its unsent rows (already filtered/ordered by the caller). */
export function buildBundle(rows: Pick<UnsentRow, "card_id" | "title" | "text">[]): string {
  const byCard = new Map<string, { title: string; texts: string[] }>();
  for (const r of rows) {
    if (!byCard.has(r.card_id)) byCard.set(r.card_id, { title: r.title, texts: [] });
    byCard.get(r.card_id)!.texts.push(r.text);
  }
  const header = `[Owner answers — ${rows.length}] Reply only if you must ask something back: office-card comment <id> "<text>" ask`;
  const blocks = [...byCard.entries()].map(([id, { title, texts }]) => `── ${id} "${title}"\n${texts.join("\n")}`);
  return [header, ...blocks].join("\n");
}

export interface SendDeps {
  /** injectable for tests (per-agent failure isolation, test 7) — defaults to the real bus send. */
  send?: (from: string, to: string, content: string) => number;
}

export interface SendResult {
  sent: number;
  agents: number;
}

/**
 * Select unsent owner comments in `tray`, group by card agent, send ONE bus message per agent with the
 * full text of every comment (no truncation), then mark those comments + their cards terminal. A throwing
 * send for one agent leaves that agent's comments unsent (retried on the next send) and does not affect
 * the others.
 */
export function sendTray(tray: "now" | "batch", deps: SendDeps = {}): SendResult {
  const send = deps.send ?? sendAgentMessage;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT occ.id AS comment_id, occ.text, occ.created_at, c.id AS card_id, c.title, c.agent
       FROM owner_card_comments occ JOIN owner_cards c ON c.id = occ.card_id
       WHERE occ.author='szoszo' AND occ.tray=? AND occ.sent_at IS NULL
       ORDER BY occ.created_at ASC, occ.id ASC`
    )
    .all(tray) as UnsentRow[];

  if (rows.length === 0) return { sent: 0, agents: 0 };

  const byAgent = new Map<string, UnsentRow[]>();
  for (const r of rows) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
    byAgent.get(r.agent)!.push(r);
  }

  let sent = 0;
  let agents = 0;
  for (const [agent, list] of byAgent) {
    const text = buildBundle(list);
    try {
      send("szoszo-board", agent, text);
    } catch (err) {
      logger.warn({ err, agent, tray }, "owner-board send failed for one agent — comments left unsent, others proceed");
      continue;
    }
    const commentIds = list.map((r) => r.comment_id);
    const cardIds = [...new Set(list.map((r) => r.card_id))];
    const tx = db.transaction(() => {
      for (const cid of commentIds) db.prepare(`UPDATE owner_card_comments SET sent_at=unixepoch() WHERE id=?`).run(cid);
      for (const crd of cardIds) {
        db.prepare(`UPDATE owner_cards SET status = CASE WHEN status='dropped' THEN 'dropped' ELSE 'sent' END, updated_at=unixepoch() WHERE id=?`).run(crd);
      }
    });
    tx();
    sent += list.length;
    agents += 1;
  }
  return { sent, agents };
}

// ---------------- linkify (escape first, then linkify — mirrors web-ui/mc/app.js renderText) ----------------

const HTML_ESCAPE_RX = /[&<>"]/g;
const HTML_ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const URL_RX = /(https?:\/\/[^\s<]+)/g;

export function renderText(s: string): string {
  const escaped = String(s ?? "").replace(HTML_ESCAPE_RX, (c) => HTML_ESCAPE_MAP[c]!);
  return escaped.replace(URL_RX, (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`);
}

// ---------------- batch timer ----------------

export const DEFAULT_BATCH_CRON = ["0 6 * * *", "0 14 * * *", "30 20 * * *"];

/** Minimal structural type — avoids adding a field to the shared EngineConfig type for this one config knob. */
export interface OwnerBoardCronCfg {
  owner: { timezone: string };
  ownerBoard?: { batchCron?: string[] };
}

/**
 * Pure ticker: given a monotonic nowMs stream, fires `onDue` at most once per matching minute across all
 * cron entries. Guard is IN-MEMORY only (spec: "store last fire in memory"), so a restart can re-fire the
 * current minute at most once — acceptable, matches the spec's explicit choice not to persist this.
 */
export function createBatchTicker(cronExprs: string[], tz: string, onDue: () => void): (nowMs: number) => void {
  let lastFiredMinute: number | null = null;
  return (nowMs: number) => {
    const mk = minuteKey(nowMs);
    if (lastFiredMinute === mk) return;
    for (const expr of cronExprs) {
      if (isDueNow(expr, nowMs, tz)) {
        lastFiredMinute = mk;
        onDue();
        return;
      }
    }
  };
}

const BATCH_TICK_MS = 20_000;

/** Wired next to startScheduler in engine start-up. Calls sendTray('batch') on each due minute. */
export function startOwnerBoardBatch(cfg: OwnerBoardCronCfg): () => void {
  const cronExprs = cfg.ownerBoard?.batchCron ?? DEFAULT_BATCH_CRON;
  const tick = createBatchTicker(cronExprs, cfg.owner.timezone, () => {
    try {
      const res = sendTray("batch");
      if (res.sent > 0) logger.info(res, "owner-board batch send");
    } catch (err) {
      logger.error({ err }, "owner-board batch tick error");
    }
  });
  const handle = setInterval(() => tick(Date.now()), BATCH_TICK_MS);
  logger.info({ cronExprs, tz: cfg.owner.timezone }, "owner-board batch timer started");
  return () => clearInterval(handle);
}
