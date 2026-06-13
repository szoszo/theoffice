import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { EngineConfig, MemoryTier } from "../types.js";
import { getDb } from "../db/index.js";
import { loadAgents } from "../agents.js";
import { loadScheduledTasks } from "../scheduler/index.js";
import { sendAgentMessage } from "../bus/index.js";
import { enqueueOutbound } from "../queue/index.js";
import { saveMemory, searchMemories } from "../memory/store.js";
import { computeUsage, WINDOW_MS } from "./usage.js";
import { checkUpdates, applyUpdate } from "./update.js";
import { sessionNameFor, launchAgent } from "../session/session-manager.js";
import { hasSession, capturePane, killSession } from "../session/tmux.js";
import { detectPaneState } from "../session/pane-state.js";
import { isCodexBusy } from "../session/codex-runtime.js";
import { isKnownRuntime, listRuntimes, DEFAULT_RUNTIME } from "../session/runtime.js";
import { getOrCreateToken, checkBearer } from "./auth.js";
import { log } from "../logger.js";

const logger = log("web");
const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "..", "..", "web-ui");
const BOOT_MS = Date.now(); // for the "since restart" usage window
// Soft ceiling for codex agents: the codex runtime shares the owner's single ChatGPT (Plus) usage cap,
// so more than this many concurrent codex agents will hit the rolling 5h limit and stall. UI warns past it.
const MAX_CODEX_AGENTS = 2;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

export function startServer(cfg: EngineConfig): () => void {
  const token = getOrCreateToken(cfg.paths.dashboardTokenFile);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${cfg.web.host}:${cfg.web.port}`);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      if (!checkBearer(req.headers.authorization, token)) {
        return json(res, 401, { error: "unauthorized" });
      }
      try {
        return await handleApi(cfg, req, res, path, url);
      } catch (err) {
        logger.error({ err, path }, "api error");
        return json(res, 500, { error: "server error" });
      }
    }
    return serveStatic(res, path);
  };

  // Listen on the primary port (agents/LAN use this) and any extra ports — e.g. a
  // legacy port a pre-existing reverse-proxy/tunnel already targets. Same handler.
  const extra = (process.env.OFFICE_EXTRA_PORTS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== cfg.web.port);
  const ports = [cfg.web.port, ...extra];
  const servers = ports.map((p) => {
    const s = createServer(handler);
    s.on("error", (err) => logger.error({ err, port: p }, "listen error"));
    s.listen(p, cfg.web.host, () => logger.info({ host: cfg.web.host, port: p }, "dashboard listening"));
    return s;
  });
  logger.info({ tokenFile: cfg.paths.dashboardTokenFile }, "dashboard API token ready");

  return () => servers.forEach((s) => s.close());
}

async function handleApi(
  cfg: EngineConfig,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL
): Promise<void> {
  const db = getDb();
  const m = req.method ?? "GET";

  // GET /api/overview
  if (path === "/api/overview" && m === "GET") {
    const memTotal = (db.prepare(`SELECT COUNT(*) n FROM memories`).get() as { n: number }).n;
    const byTier = Object.fromEntries(
      (db.prepare(`SELECT category, COUNT(*) n FROM memories GROUP BY category`).all() as { category: string; n: number }[]).map((r) => [r.category, r.n])
    );
    const kanban = db.prepare(`SELECT status, COUNT(*) n FROM kanban_cards WHERE archived_at IS NULL GROUP BY status`).all() as { status: string; n: number }[];
    const queued = (db.prepare(`SELECT COUNT(*) n FROM inbound_queue WHERE status='queued'`).get() as { n: number }).n;
    const pendingMsgs = (db.prepare(`SELECT COUNT(*) n FROM agent_messages WHERE status='pending'`).get() as { n: number }).n;
    const logs = (db.prepare(`SELECT COUNT(*) n FROM daily_logs`).get() as { n: number }).n;
    const agents = loadAgents(cfg);
    const tasks = loadScheduledTasks(cfg);
    return json(res, 200, {
      memories: memTotal,
      memoryByTier: byTier,
      kanban: Object.fromEntries(kanban.map((k) => [k.status, k.n])),
      agents: agents.length,
      agentsEnabled: agents.filter((a) => a.enabled).length,
      queued,
      pendingMessages: pendingMsgs,
      dailyLogs: logs,
      schedulesEnabled: tasks.filter((t) => t.enabled).length,
      schedulesTotal: tasks.length,
      channel: cfg.channel.provider,
    });
  }

  // GET /api/runtimes — registered providers (id, label, selectable models) for the dashboard flip control,
  // plus the soft codex ceiling so the UI can warn before the owner blows the shared ChatGPT cap.
  if (path === "/api/runtimes" && m === "GET") {
    return json(res, 200, { runtimes: listRuntimes(), maxCodexAgents: MAX_CODEX_AGENTS });
  }

  // GET /api/agents — enriched for the command center (live state, model, profile, memory count)
  if (path === "/api/agents" && m === "GET") {
    const counts = Object.fromEntries(
      (db.prepare(`SELECT agent_id, COUNT(*) n FROM memories GROUP BY agent_id`).all() as { agent_id: string; n: number }[]).map((r) => [r.agent_id, r.n])
    );
    const agents = loadAgents(cfg).map((a) => {
      const session = sessionNameFor(a.id);
      const running = hasSession(cfg.tmux.socket, session);
      let state = "offline";
      if (running) {
        if (a.runtime === "codex") {
          // codex agents run an idle tmux HOLDER (not a Claude TUI), so pane-state can't classify them.
          // Liveness comes from the exec tracker instead: a turn in flight = busy, otherwise idle.
          state = isCodexBusy(a.id) ? "busy" : "idle";
        } else {
          const pane = capturePane(cfg.tmux.socket, session);
          state = pane ? detectPaneState(pane) : "unknown";
        }
      }
      return {
        id: a.id,
        displayName: a.displayName,
        enabled: a.enabled,
        model: a.model ?? "default",
        profile: a.profile ?? "full",
        runtime: a.runtime ?? "claude",
        running,
        state,
        slack: a.slack ? { ready: !!(a.slack.appToken && a.slack.botToken), botUserId: a.slack.botUserId ?? null } : null,
        allowFrom: a.allowFrom ?? [],
        memories: counts[a.id] ?? 0,
      };
    });
    return json(res, 200, agents);
  }

  // GET /api/usage?window=1h|24h|3d|7d|restart|all  (live, per-agent)
  if (path === "/api/usage" && m === "GET") {
    const w = url.searchParams.get("window") ?? "24h";
    let cutoff = 0;
    if (w === "restart") cutoff = BOOT_MS;
    else if (w !== "all") cutoff = Date.now() - (WINDOW_MS[w] ?? WINDOW_MS["24h"]!);
    const agents = loadAgents(cfg);
    const usage = computeUsage(agents, cutoff)
      .map((u) => ({ ...u, displayName: agents.find((a) => a.id === u.id)?.displayName ?? u.id }))
      .sort((a, b) => b.output - a.output);
    return json(res, 200, { window: w, since: cutoff, bootMs: BOOT_MS, usage });
  }

  // GET /api/update/check — list commits this install is behind
  if (path === "/api/update/check" && m === "GET") {
    return json(res, 200, checkUpdates());
  }
  // POST /api/update/apply {discard?} — pull + build + restart (engine bounces after the response).
  // A dirty working tree returns {ok:false,dirty:true,files} unless discard:true is sent (auto-stash + pull).
  if (path === "/api/update/apply" && m === "POST") {
    const b = parseJson(await readBody(req)) ?? {};
    try {
      return json(res, 200, applyUpdate({ discardLocal: b.discard === true }));
    } catch (e) {
      return json(res, 200, { ok: false, output: String((e as Error).message) });
    }
  }

  // GET /api/daily-logs?agent=&limit=
  if (path === "/api/daily-logs" && m === "GET") {
    const agent = url.searchParams.get("agent");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 200);
    const rows = agent
      ? db.prepare(`SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE agent_id=? ORDER BY id DESC LIMIT ?`).all(agent, limit)
      : db.prepare(`SELECT id, agent_id, date, content, created_at FROM daily_logs ORDER BY id DESC LIMIT ?`).all(limit);
    return json(res, 200, rows);
  }
  // POST /api/daily-log (alias /api/daily-logs) — live write path; replaces raw-sqlite daily-log writes
  if ((path === "/api/daily-log" || path === "/api/daily-logs") && m === "POST") {
    const b = parseJson(await readBody(req));
    if (!b?.agentId || !b?.content) return json(res, 400, { error: "agentId and content required" });
    const date = b.date ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Budapest" });
    const r = db.prepare(`INSERT INTO daily_logs (agent_id, date, content) VALUES (?, ?, ?)`).run(b.agentId, date, b.content);
    return json(res, 200, { id: Number(r.lastInsertRowid) });
  }

  // GET /api/memories  POST /api/memories
  if (path === "/api/memories" && m === "GET") {
    const rows = searchMemories({
      agentId: url.searchParams.get("agent") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      category: (url.searchParams.get("category") as MemoryTier) ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 50),
    });
    return json(res, 200, rows);
  }
  if (path === "/api/memories" && m === "POST") {
    const b = parseJson(await readBody(req));
    if (!b?.agentId || !b?.content) return json(res, 400, { error: "agentId and content required" });
    const id = saveMemory({ agentId: b.agentId, content: b.content, category: b.category, keywords: b.keywords });
    return json(res, 200, { id });
  }

  // GET /api/kanban
  if (path === "/api/kanban" && m === "GET") {
    const status = url.searchParams.get("status");
    const rows = status
      ? db.prepare(`SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status=? ORDER BY sort_order`).all(status)
      : db.prepare(`SELECT * FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order`).all();
    return json(res, 200, rows);
  }
  // POST /api/kanban — create a card (live write path; replaces raw-sqlite card creation)
  if (path === "/api/kanban" && m === "POST") {
    const b = parseJson(await readBody(req));
    if (!b?.title) return json(res, 400, { error: "title required" });
    if (b.status && !["planned", "in_progress", "waiting", "done"].includes(b.status)) return json(res, 400, { error: "bad status" });
    if (b.priority && !["low", "normal", "high", "urgent"].includes(b.priority)) return json(res, 400, { error: "bad priority" });
    const id = randomBytes(4).toString("hex");
    db.prepare(`INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, b.title, b.description ?? null, b.status ?? "planned", b.assignee ?? null,
        b.priority ?? "normal", b.project ?? null, b.parentId ?? null);
    return json(res, 200, { id });
  }

  // GET /api/schedules
  if (path === "/api/schedules" && m === "GET") {
    return json(res, 200, loadScheduledTasks(cfg));
  }

  // GET /api/messages?to=&from=&status=&limit=  — filters are optional + composable
  if (path === "/api/messages" && m === "GET") {
    const where: string[] = [];
    const args: unknown[] = [];
    const to = url.searchParams.get("to");
    const from = url.searchParams.get("from");
    const status = url.searchParams.get("status");
    if (to) { where.push("to_agent = ?"); args.push(to); }
    if (from) { where.push("from_agent = ?"); args.push(from); }
    if (status) { where.push("status = ?"); args.push(status); }
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100), 500);
    const sql = `SELECT * FROM agent_messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...args, limit);
    return json(res, 200, rows);
  }
  if (path === "/api/messages" && m === "POST") {
    const b = parseJson(await readBody(req));
    if (!b?.from || !b?.to || !b?.content) return json(res, 400, { error: "from, to, content required" });
    const id = sendAgentMessage(b.from, b.to, b.content);
    return json(res, 200, { id });
  }
  // POST /api/messages/done {id} — target agent closes a delivered message
  if (path === "/api/messages/done" && m === "POST") {
    const b = parseJson(await readBody(req));
    if (!b?.id) return json(res, 400, { error: "id required" });
    const info = db.prepare(`UPDATE agent_messages SET status='done', result=?, completed_at=unixepoch() WHERE id=?`).run(b.result ?? null, b.id);
    if (info.changes === 0) return json(res, 404, { error: "message not found", id: b.id });
    return json(res, 200, { ok: true, id: b.id });
  }

  // POST /api/outbound {agent, channel, text} — agent reply path (-> outbound_queue -> Slack)
  if (path === "/api/outbound" && m === "POST") {
    const b = parseJson(await readBody(req));
    if (!b?.agent || !b?.channel || !b?.text) return json(res, 400, { error: "agent, channel, text required" });
    const id = enqueueOutbound(b.agent, b.channel, b.text);
    return json(res, 200, { id });
  }

  // GET /api/queue — inbound queue snapshot
  if (path === "/api/queue" && m === "GET") {
    const rows = db.prepare(`SELECT status, COUNT(*) n FROM inbound_queue GROUP BY status`).all() as { status: string; n: number }[];
    const recent = db.prepare(`SELECT id, agent_id, source, status, attempts, substr(prompt,1,80) preview, created_at FROM inbound_queue ORDER BY id DESC LIMIT 50`).all();
    return json(res, 200, { byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])), recent });
  }

  // --- agent control (write) : /api/agents/<id>/<action> ---
  const am = path.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/(model|runtime|enabled|restart|start|stop)$/);
  if (am && m === "POST") {
    const id = am[1]!, action = am[2]!;
    const agent = loadAgents(cfg).find((a) => a.id === id);
    if (!agent) return json(res, 404, { error: "no such agent" });
    const session = sessionNameFor(id);
    const relaunch = () => {
      const fresh = loadAgents(cfg).find((a) => a.id === id);
      if (fresh) launchAgent(cfg, fresh);
    };

    if (action === "restart") {
      killSession(cfg.tmux.socket, session);
      relaunch();
      return json(res, 200, { ok: true, action });
    }
    if (action === "start") {
      relaunch();
      return json(res, 200, { ok: true, action });
    }
    if (action === "stop") {
      killSession(cfg.tmux.socket, session);
      return json(res, 200, { ok: true, action });
    }

    // model / enabled edit agent.json then take effect
    const metaPath = join(agent.dir, "agent.json");
    const meta = existsSync(metaPath) ? (parseJson(readFileSync(metaPath, "utf8")) ?? {}) : {};
    const body = parseJson(await readBody(req)) ?? {};
    if (action === "model") {
      const mv = typeof body.model === "string" ? body.model : "default";
      if (mv && mv !== "default") meta.model = mv;
      else delete meta.model;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      killSession(cfg.tmux.socket, session); // restart so the new --model takes effect
      relaunch();
      return json(res, 200, { ok: true, model: mv });
    }
    if (action === "runtime") {
      // Flip the provider that drives this agent (claude / codex / ...). Optional `model` in the same
      // body lets the UI swap runtime + model atomically (one restart). Unknown providers default-resolve
      // to claude on load, but we reject them here so a typo can't silently no-op.
      const rv = typeof body.runtime === "string" ? body.runtime : DEFAULT_RUNTIME;
      if (!isKnownRuntime(rv)) return json(res, 400, { error: "unknown runtime", runtime: rv });
      if (rv === DEFAULT_RUNTIME) delete meta.runtime; // keep agent.json clean + preserve revert semantics
      else meta.runtime = rv;
      if (typeof body.model === "string") {
        if (body.model && body.model !== "default") meta.model = body.model;
        else delete meta.model;
      }
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      // GUARDRAIL (ChatGPT Plus, no Pro): the codex runtime shares the owner's single ChatGPT usage cap,
      // so >2 concurrent codex agents will hit the 5h limit and stall the fleet. Soft-warn (never block) so
      // the switch can't trap the owner — just surfaces the risk in the UI when the ceiling is crossed.
      const codexCount = loadAgents(cfg).filter((a) => a.runtime === "codex").length;
      const warning =
        rv === "codex" && codexCount > MAX_CODEX_AGENTS
          ? `${codexCount} agents now on codex. ChatGPT Plus shares one usage cap — >${MAX_CODEX_AGENTS} concurrent codex agents will hit the 5h limit and stall. Consider keeping it to ${MAX_CODEX_AGENTS}.`
          : undefined;
      killSession(cfg.tmux.socket, session); // restart so the new runtime path takes effect
      relaunch();
      return json(res, 200, { ok: true, runtime: rv, model: meta.model ?? "default", codexCount, warning });
    }
    if (action === "enabled") {
      meta.enabled = !!body.enabled;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      if (!meta.enabled) killSession(cfg.tmux.socket, session);
      return json(res, 200, { ok: true, enabled: meta.enabled });
    }
  }

  // --- kanban move : /api/kanban/<id>/status {status} ---
  const km = path.match(/^\/api\/kanban\/([^/]+)\/status$/);
  if (km && m === "POST") {
    const body = parseJson(await readBody(req)) ?? {};
    const st = body.status;
    if (!["planned", "in_progress", "waiting", "done"].includes(st)) return json(res, 400, { error: "bad status" });
    const id = decodeURIComponent(km[1]!);
    const info = db.prepare(`UPDATE kanban_cards SET status=?, updated_at=unixepoch() WHERE id=?`).run(st, id);
    if (info.changes === 0) return json(res, 404, { error: "card not found", id });
    return json(res, 200, { ok: true, id });
  }

  // --- kanban archive : /api/kanban/<id>/archive (reversible: set archived_at) ---
  const ka = path.match(/^\/api\/kanban\/([^/]+)\/archive$/);
  if (ka && m === "POST") {
    const id = decodeURIComponent(ka[1]!);
    const info = db.prepare(`UPDATE kanban_cards SET archived_at=unixepoch(), updated_at=unixepoch() WHERE id=?`).run(id);
    if (info.changes === 0) return json(res, 404, { error: "card not found", id });
    return json(res, 200, { ok: true, id });
  }

  // --- memory category update : /api/memories/<id>/category {category} — live hot->cold reclass path ---
  const mc = path.match(/^\/api\/memories\/([^/]+)\/category$/);
  if (mc && m === "POST") {
    const b = parseJson(await readBody(req)) ?? {};
    if (!["hot", "warm", "cold", "shared"].includes(b.category)) return json(res, 400, { error: "bad category" });
    const id = decodeURIComponent(mc[1]!);
    const info = db.prepare(`UPDATE memories SET category=? WHERE id=?`).run(b.category, id);
    if (info.changes === 0) return json(res, 404, { error: "memory not found", id });
    return json(res, 200, { ok: true, id, category: b.category });
  }

  return json(res, 404, { error: "not found" });
}

interface JsonBody {
  [k: string]: any;
}
function parseJson(s: string): JsonBody | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function serveStatic(res: ServerResponse, path: string): void {
  let rel = path === "/" ? "/index.html" : path;
  // prevent path traversal
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(UI_DIR, safe);
  if (!file.startsWith(UI_DIR) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}
