import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { totalmem, freemem, cpus, loadavg, uptime as osUptime, homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { AgentDef, EngineConfig, MemoryTier } from "../types.js";
import { getDb } from "../db/index.js";
import { loadAgents } from "../agents.js";
import { loadScheduledTasks } from "../scheduler/index.js";
import { sendAgentMessage } from "../bus/index.js";
import { enqueueOutbound } from "../queue/index.js";
import { saveMemory, searchMemories } from "../memory/store.js";
import { computeUsage, WINDOW_MS } from "./usage.js";
import { checkUpdates, applyUpdate } from "./update.js";
import { runEmergencyRestart } from "./emergency.js";
import {
  getAuthHealth,
  getLoginState,
  startLogin,
  submitCode,
  cancelLogin,
  restartSignedOutAgents,
} from "./claude-auth.js";
import { sessionNameFor, launchAgent } from "../session/session-manager.js";
import { hasSession, capturePane, killSession } from "../session/tmux.js";
import { detectPaneState } from "../session/pane-state.js";
import { isCodexBusy } from "../session/codex-runtime.js";
import { applyTune, type TuneKind } from "../session/tune.js";
import { restoreOwnerSettings } from "../session/claude-settings.js";
import { normalizeEffort } from "../session/effort.js";

// Live context fill % from the agent's most-recent Claude Code session transcript — reads the
// last turn's token usage (input + cache) against the context window. Token-free (no /context
// call). Window = 1M, matching Claude Code's own /context readout (verified on cfo + marveen).
// null if unreadable.
const CONTEXT_WINDOW = 1000000;
function contextPctFromTranscript(agentDir: string): number | null {
  try {
    const dir = join(homedir(), ".claude", "projects", agentDir.replace(/\//g, "-"));
    if (!existsSync(dir)) return null;
    let best = "";
    let bestM = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const mm = statSync(join(dir, f)).mtimeMs;
      if (mm > bestM) {
        bestM = mm;
        best = f;
      }
    }
    if (!best) return null;
    const p = join(dir, best);
    const size = statSync(p).size;
    const len = Math.min(size, 262144);
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i]!.trim();
      if (!ln) continue;
      try {
        const o = JSON.parse(ln);
        const u = o?.message?.usage ?? o?.usage;
        if (u && (u.input_tokens || u.cache_read_input_tokens)) {
          const t = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          return Math.min(100, Math.round((t / CONTEXT_WINDOW) * 100));
        }
      } catch {
        /* partial / non-JSON line */
      }
    }
    return null;
  } catch {
    return null;
  }
}
import { isKnownRuntime, listRuntimes, runtimeFor, DEFAULT_RUNTIME } from "../session/runtime.js";
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
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

/**
 * Read a request body, capped at 1MB. Returns the body string, or null if the body was too large — in
 * which case a 413 has ALREADY been sent and the caller must bail (do not write another response).
 * P1#5: the prior version called req.destroy() with no resolve, and on Node 22 destroy emits only 'close'
 * (not 'end'/'error'), so the promise hung forever and leaked the request. The 'close' handler + the latch
 * guarantee the promise always settles exactly once.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (v: string | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) {
        try {
          res.writeHead(413);
          res.end();
        } catch {
          /* headers already sent — best effort */
        }
        req.destroy();
        finish(null);
      }
    });
    req.on("end", () => finish(data));
    req.on("close", () => finish(data)); // Node 22 destroy() -> 'close' only; backstop so we never hang
    req.on("error", () => finish(null));
  });
}

export let _now = () => Date.now();
export function _setClock(fn: () => number) { _now = fn; }

interface RLEntry {
  fails: number;
  blockedUntil: number;
  lastFail: number;
  blocks: number; // how many times this IP has been blocked — drives escalating backoff
}
const rlMap = new Map<string, RLEntry>();

/** Constant-time compare of the supplied X-Proxy-Token header against the configured token. */
function proxyTokenMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch; reject first
  return timingSafeEqual(a, b);
}

export function getClientIp(req: IncomingMessage, trustedProxyToken?: string): string {
  // X-Real-IP / X-Forwarded-For are only trustworthy when set by OUR reverse proxy. A client hitting the
  // port directly can FORGE them to evade the per-IP rate limiter or frame another IP. #6 trusted-proxy gate:
  // when a token is configured, the proxy sends `X-Proxy-Token`; a request without the matching token has its
  // forwarding headers IGNORED and falls back to the true peer. No token configured -> unchanged (backward compat).
  const forwardingTrusted = !trustedProxyToken || proxyTokenMatches(req.headers["x-proxy-token"], trustedProxyToken);
  if (forwardingTrusted) {
    // Prefer X-Real-IP: proxies set it to the real client and OVERWRITE any client-sent value. X-Forwarded-For
    // via $proxy_add_x_forwarded_for APPENDS the real IP (last entry), so use it only when X-Real-IP is absent.
    const xri = req.headers["x-real-ip"];
    if (typeof xri === "string" && xri.trim()) return xri.trim();
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1]!;
    }
  }
  return req.socket.remoteAddress || "unknown";
}

export function startServer(cfg: EngineConfig): () => void {
  const token = getOrCreateToken(cfg.paths.dashboardTokenFile);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${cfg.web.host}:${cfg.web.port}`);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      const ip = getClientIp(req, cfg.web.trustedProxyToken);
      const rl = cfg.web.rateLimit || { maxFails: 5, windowMs: 900000, blockMs: 60000, maxBlockMs: 3600000 };
      const nowMs = _now();

      // A VALID token is ALWAYS allowed through — the rate limiter only ever blocks requests that
      // FAIL auth. This is deliberate: the limiter keys on IP, but several browser tabs/devices can
      // share one IP (incl. behind a proxy), so checking the block before auth would let one stale
      // tab (old/wrong token, polling) lock out the legitimate session on the same IP. By gating the
      // block on auth failure, brute-force (no/wrong token) is still throttled while a correct token
      // can never be collateral-blocked.
      if (checkBearer(req.headers.authorization, token)) {
        if (rlMap.has(ip)) rlMap.delete(ip); // success clears any accrued strikes/blocks for this IP
      } else {
        let existing = rlMap.get(ip);
        if (existing && existing.blockedUntil > nowMs) {
          res.setHeader("Retry-After", Math.ceil((existing.blockedUntil - nowMs) / 1000).toString());
          return json(res, 429, { error: "too many attempts" });
        }
        const entry: RLEntry = (!existing || (nowMs - existing.lastFail) > rl.windowMs)
          ? { fails: 0, blockedUntil: 0, lastFail: nowMs, blocks: existing?.blocks ?? 0 }
          : existing;

        entry.fails++;
        entry.lastFail = nowMs;
        if (entry.fails >= rl.maxFails) {
          // Escalating backoff: a human who fat-fingers the token waits a short base block;
          // a real (automated) attacker doubles their wait each lockout, up to maxBlockMs.
          entry.blocks++;
          const cap = rl.maxBlockMs ?? 3600000;
          entry.blockedUntil = nowMs + Math.min(cap, rl.blockMs * Math.pow(2, entry.blocks - 1));
          entry.fails = 0; // strikes consumed; escalation now tracked by `blocks`
        }

        if (rlMap.size > 10000) {
          for (const [k, v] of rlMap.entries()) {
            if (v.blockedUntil <= nowMs && (nowMs - v.lastFail) > rl.windowMs) {
              rlMap.delete(k);
            }
          }
        }
        rlMap.set(ip, entry);
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
      let contextPct: number | null = null;
      if (running) {
        if (a.runtime === "codex") {
          // codex agents run an idle tmux HOLDER (not a Claude TUI), so pane-state can't classify them.
          // Liveness comes from the exec tracker instead: a turn in flight = busy, otherwise idle.
          state = isCodexBusy(a.id) ? "busy" : "idle";
        } else {
          const pane = capturePane(cfg.tmux.socket, session);
          state = pane ? detectPaneState(pane) : "unknown";
          // Primary: precise always-on fill % from the session transcript. Fallback: the footer
          // gauge (only visible when climbing) if the transcript can't be read.
          const tp = contextPctFromTranscript(a.dir);
          if (tp != null) contextPct = tp;
          else if (pane) {
            const used = pane.match(/(\d+)%\s*context\s*used/i);
            const left = pane.match(/(\d+)%\s*context\s*left/i);
            if (used) contextPct = Number(used[1]);
            else if (left) contextPct = 100 - Number(left[1]);
          }
        }
      }
      return {
        id: a.id,
        displayName: a.displayName,
        handle: a.id,
        role: a.role ?? "",
        color: a.color ?? null,
        enabled: a.enabled,
        model: a.model ?? "default",
        effort: a.effort ?? "default",
        profile: a.profile ?? "full",
        runtime: a.runtime ?? "claude",
        running,
        state,
        slack: a.slack ? { ready: !!(a.slack.appToken && a.slack.botToken), botUserId: a.slack.botUserId ?? null } : null,
        allowFrom: a.allowFrom ?? [],
        memories: counts[a.id] ?? 0,
        contextPct,
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
  // GET /api/host — lightweight host/engine health for the dashboard Update view (uptime, cpu, mem).
  if (path === "/api/host" && m === "GET") {
    const cores = cpus().length || 1;
    const memTotal = totalmem();
    const memFree = freemem();
    const cpuPct = Math.max(0, Math.min(100, Math.round((loadavg()[0]! / cores) * 100)));
    return json(res, 200, {
      uptimeSec: Math.round(osUptime()),
      cpuPct,
      cores,
      memUsedBytes: memTotal - memFree,
      memTotalBytes: memTotal,
      runtime: "Node · container",
      port: cfg.web.port,
    });
  }
  // POST /api/update/apply {discard?} — pull + build + restart (engine bounces after the response).
  // A dirty working tree returns {ok:false,dirty:true,files} unless discard:true is sent (auto-stash + pull).
  if (path === "/api/update/apply" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw) ?? {};
    try {
      return json(res, 200, applyUpdate({ discardLocal: b.discard === true }));
    } catch (e) {
      return json(res, 200, { ok: false, output: String((e as Error).message) });
    }
  }

  // POST /api/emergency-restart — save the whole queue, clear it, restart every enabled agent, and brief
  // the main agent to summarise to the owner. One button for "the fleet is melting down, reset it safely".
  if (path === "/api/emergency-restart" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw) ?? {};
    try {
      return json(res, 200, await runEmergencyRestart(cfg, { dryRun: b.dryRun === true }));
    } catch (e) {
      logger.error({ err: e }, "emergency-restart failed");
      return json(res, 500, { ok: false, error: String((e as Error).message) });
    }
  }

  // ---- Claude sign-in, from the dashboard (no terminal). See src/web/claude-auth.ts for the why. ----

  // GET /api/auth/health — credential state + a live per-pane signed-out scan. This is the check
  // /api/agents deliberately does NOT do: `running=true` only proves a process exists, not that it
  // can authenticate, which is why a total auth outage used to show up as a fully green dashboard.
  if (path === "/api/auth/health" && m === "GET") {
    return json(res, 200, { ...getAuthHealth(cfg), login: getLoginState() });
  }

  // POST /api/auth/login/start — spawn `claude auth login` and hand back the browser URL.
  if (path === "/api/auth/login/start" && m === "POST") {
    try {
      return json(res, 200, await startLogin(cfg));
    } catch (e) {
      logger.error({ err: e }, "login start failed");
      return json(res, 500, { ok: false, error: String((e as Error).message) });
    }
  }

  // POST /api/auth/login/code {code, restart?} — submit the pasted code; on success restart the panes
  // so they pick the new credential up (the step that makes the fix actually take effect).
  if (path === "/api/auth/login/code" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw) ?? {};
    try {
      const r = await submitCode(cfg, String(b.code ?? ""));
      if (!r.ok) return json(res, 200, r);
      const restarted = b.restart === false ? { restarted: [], failed: [] } : restartSignedOutAgents(cfg, { all: true });
      return json(res, 200, { ...r, ...restarted });
    } catch (e) {
      logger.error({ err: e }, "login code failed");
      return json(res, 500, { ok: false, error: String((e as Error).message) });
    }
  }

  // POST /api/auth/login/cancel — tear down an abandoned login session.
  if (path === "/api/auth/login/cancel" && m === "POST") {
    cancelLogin(cfg);
    return json(res, 200, { ok: true });
  }

  // POST /api/auth/restart {all?} — the "credential is fine, panes are stale" repair, on its own.
  if (path === "/api/auth/restart" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw) ?? {};
    return json(res, 200, { ok: true, ...restartSignedOutAgents(cfg, { all: b.all === true }) });
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
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw);
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
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw);
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
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw);
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
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw);
    if (!b?.from || !b?.to || !b?.content) return json(res, 400, { error: "from, to, content required" });
    const id = sendAgentMessage(b.from, b.to, b.content);
    return json(res, 200, { id });
  }
  // POST /api/messages/done {id} — target agent closes a delivered message
  if (path === "/api/messages/done" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw);
    if (!b?.id) return json(res, 400, { error: "id required" });
    const info = db.prepare(`UPDATE agent_messages SET status='done', result=?, completed_at=unixepoch() WHERE id=?`).run(b.result ?? null, b.id);
    if (info.changes === 0) return json(res, 404, { error: "message not found", id: b.id });
    return json(res, 200, { ok: true, id: b.id });
  }

  // POST /api/outbound {agent, channel, text} — agent reply path (-> outbound_queue -> Slack)
  if (path === "/api/outbound" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw);
    if (!b?.agent || !b?.channel || !b?.text) return json(res, 400, { error: "agent, channel, text required" });
    const id = enqueueOutbound(b.agent, b.channel, b.text);
    return json(res, 200, { id });
  }

  // POST /api/tune {kind, value} — office-tune's endpoint, so an agent can honour a plain-language
  // request from the owner ("switch to xhigh") without the owner learning a command syntax.
  //
  // The agent names itself in X-Office-Agent, from OFFICE_AGENT_ID in its session env. Same trust
  // model as /api/outbound above: the dashboard token is shared by every agent, so this keeps agents
  // in their own lane by convention — it is NOT a cryptographic boundary between them. Tightening
  // that would mean per-agent tokens, which is a separate change affecting office-say too.
  if (path === "/api/tune" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const body = parseJson(raw) ?? {};
    const who = String(req.headers["x-office-agent"] ?? "");
    const agent = loadAgents(cfg).find((a) => a.id === who);
    if (!agent) return json(res, 400, { error: "unknown calling agent", agent: who });
    const kind = body.kind === "model" || body.kind === "effort" ? (body.kind as TuneKind) : null;
    if (!kind) return json(res, 400, { error: "kind must be model or effort" });
    return tuneAgent(cfg, res, agent, kind, String(body.value ?? ""));
  }

  // GET /api/queue — inbound queue snapshot
  if (path === "/api/queue" && m === "GET") {
    const rows = db.prepare(`SELECT status, COUNT(*) n FROM inbound_queue GROUP BY status`).all() as { status: string; n: number }[];
    const recent = db.prepare(`SELECT id, agent_id, source, status, attempts, substr(prompt,1,80) preview, created_at FROM inbound_queue ORDER BY id DESC LIMIT 50`).all();
    return json(res, 200, { byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])), recent });
  }

  // --- agent control (write) : /api/agents/<id>/<action> ---
  const am = path.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/(model|effort|runtime|enabled|restart|start|stop|cleanreset)$/);
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
    if (action === "cleanreset") {
      // Fire-and-forget the handoff+reset+summary orchestrator (background python).
      // It tells the agent to write HANDOFF.md, waits, restarts it via this same API,
      // then tells it to re-read the handoff and office-say Szoszo a summary.
      try {
        spawn("python3", ["/opt/claude/theoffice/tenant/agents/darryl/tools/clean-reset/clean_reset.py", id],
          { detached: true, stdio: "ignore" }).unref();
      } catch { /* best-effort */ }
      return json(res, 200, { ok: true, action, note: "handoff + reset started; Slack summary in a few minutes" });
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
    const raw = await readBody(req, res); if (raw === null) return;
    const body = parseJson(raw) ?? {};
    // model / effort: persist to agent.json FIRST (durable truth, survives restart), then tune the
    // LIVE pane so the agent keeps its conversation. Deliberately no killSession here — that was the
    // old behaviour and it threw away the agent's context on every model change.
    if (action === "model" || action === "effort") {
      const rawVal = action === "model" ? body.model : body.effort;
      return tuneAgent(cfg, res, agent, action, typeof rawVal === "string" ? rawVal : "default");
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
    const raw = await readBody(req, res); if (raw === null) return;
    const body = parseJson(raw) ?? {};
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

  // --- kanban metadata patch : PATCH /api/kanban/<id> {priority?, project?} ---
  // METADATA ONLY, by design. The grooming task (issue #21 §2) uses this to re-prioritize / re-project a
  // card. It deliberately CANNOT touch status/title/parent/assignee: no done-bypass, no rewrite, no
  // re-parent. The SET clause is built only from these two hardcoded column literals (never from request
  // keys), and only the values are bound — so an off-scope field in the body is silently inert, not an update.
  const kp = path.match(/^\/api\/kanban\/([^/]+)$/);
  if (kp && m === "PATCH") {
    const raw = await readBody(req, res); if (raw === null) return;
    const body = parseJson(raw) ?? {};
    const sets: string[] = [];
    const vals: unknown[] = [];
    if ("priority" in body) {
      if (!["low", "normal", "high", "urgent"].includes(body.priority)) return json(res, 400, { error: "bad priority" });
      sets.push("priority=?"); vals.push(body.priority);
    }
    if ("project" in body) {
      const p = body.project;
      if (p !== null && (typeof p !== "string" || p.length > 120)) return json(res, 400, { error: "bad project (string <=120 or null)" });
      sets.push("project=?"); vals.push(p);
    }
    if (sets.length === 0) return json(res, 400, { error: "no updatable fields (priority/project only)" });
    const id = decodeURIComponent(kp[1]!);
    const info = db.prepare(`UPDATE kanban_cards SET ${sets.join(", ")}, updated_at=unixepoch() WHERE id=?`).run(...vals, id);
    if (info.changes === 0) return json(res, 404, { error: "card not found", id });
    return json(res, 200, { ok: true, id });
  }

  // --- memory category update : /api/memories/<id>/category {category} — live hot->cold reclass path ---
  const mc = path.match(/^\/api\/memories\/([^/]+)\/category$/);
  if (mc && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const b = parseJson(raw) ?? {};
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
/**
 * The owner's own default Claude settings, which a tune injection would otherwise overwrite.
 * Read from config so it is not hardcoded; falls back to the CLI's own default effort.
 */
function ownerCanonicalSettings(cfg: EngineConfig): { model?: string; effortLevel?: string } {
  // Leave these UNDEFINED when the owner has not configured them: restoreOwnerSettings then leaves the
  // owner's own settings.json untouched. Defaulting effort to "high" here would silently force-write the
  // owner's real ~/.claude/settings.json to "high" on every tune, even if they never chose it.
  return { model: cfg.owner.claudeModel, effortLevel: cfg.owner.claudeEffort };
}

/**
 * Persist a model/effort pin to agent.json, then apply it to the live pane.
 *
 * Shared by the dashboard action and by office-tune, so both paths have identical semantics:
 * agent.json is the durable truth and is written even when the live injection cannot happen — a
 * failed injection therefore means "takes effect at next restart", not "lost".
 */
async function tuneAgent(
  cfg: EngineConfig,
  res: ServerResponse,
  agent: AgentDef,
  kind: TuneKind,
  wanted: string,
): Promise<void> {
  const metaPath = join(agent.dir, "agent.json");
  const meta = existsSync(metaPath) ? (parseJson(readFileSync(metaPath, "utf8")) ?? {}) : {};
  const trimmed = wanted.trim();
  const clearing = !trimmed || trimmed === "default";

  // Live injection is a CLAUDE-runtime mechanism: /model and /effort are Claude Code slash commands.
  // A codex or gemini pane would just receive that text as a prompt, so those providers keep the old
  // restart-to-apply path, and effort — which they don't have at all — is refused outright.
  const isClaude = runtimeFor(agent).id === "claude";
  if (!isClaude && kind === "effort") {
    return json(res, 400, { error: "effort is claude-only", runtime: runtimeFor(agent).id });
  }

  let value: string | undefined;
  if (!clearing) {
    if (kind === "effort") {
      value = normalizeEffort(trimmed);
      if (!value) return json(res, 400, { error: "unknown effort", effort: trimmed });
    } else {
      // A model is typed into the LIVE pane as `/model <value>` (applyTune -> tmux send-keys -l). An
      // interior newline would submit the model line and then inject arbitrary keystrokes/slash-commands
      // into the agent's conversation, so accept only a bare model token. And when the runtime enumerates
      // its models, require membership — that both closes the injection surface AND caps cost, so an agent
      // cannot pin itself (or any agent) to an off-menu / more expensive model. (effort is already an
      // allowlist above; codex enumerates no models, so it keeps the token-syntax check only.)
      if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        return json(res, 400, { error: "invalid model", model: trimmed });
      }
      const allowed = runtimeFor(agent).models;
      if (allowed.length > 0 && !allowed.includes(trimmed)) {
        return json(res, 400, { error: "unknown model for runtime", model: trimmed, allowed });
      }
      value = trimmed;
    }
  }

  if (clearing) delete meta[kind];
  else meta[kind] = value;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Clearing a pin has no live equivalent (there is no "unset" slash command), so it takes effect at
  // the next launch — say so rather than pretending it applied now.
  if (clearing) {
    return json(res, 200, {
      ok: true,
      [kind]: "default",
      applied: false,
      note: "cleared; applies at next restart",
    });
  }

  // non-claude providers: no slash-command channel, so restart the session to pick the value up
  if (!isClaude) {
    const session = sessionNameFor(agent.id);
    killSession(cfg.tmux.socket, session);
    const fresh = loadAgents(cfg).find((a) => a.id === agent.id);
    if (fresh) launchAgent(cfg, fresh);
    return json(res, 200, {
      ok: true,
      [kind]: value,
      applied: true,
      note: `restarted ${agent.id} to apply (this provider has no live-switch path)`,
    });
  }

  const tuned = await applyTune(cfg.tmux.socket, sessionNameFor(agent.id), kind, value!);
  if (tuned.ok) await restoreOwnerSettings(ownerCanonicalSettings(cfg));
  return json(res, 200, {
    ok: true,
    [kind]: value,
    applied: tuned.ok,
    note: tuned.ok
      ? tuned.message
      : `saved; not applied live (${tuned.reason}) — takes effect at next restart`,
  });
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
  if (rel.endsWith("/")) rel += "index.html"; // serve dir index (e.g. /mc/ -> /mc/index.html)
  // prevent path traversal
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(UI_DIR, safe);
  // Must be a FILE, not merely something that exists: a directory (e.g. /mc, the Mission Control dir)
  // passes existsSync, then readFileSync throws EISDIR out of the request handler — an unauthenticated
  // GET would take the whole engine down. statSync-as-file collapses "missing" and "not a file" into 404.
  const st = file.startsWith(UI_DIR) ? statSync(file, { throwIfNoEntry: false }) : undefined;
  if (!st?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}
