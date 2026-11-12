const $ = (s) => document.querySelector(s);
let TOKEN = localStorage.getItem("office_token") || "";
let AGENTS = {}; // id -> agent
let AGENTLIST = [];

async function api(path) {
  const r = await fetch(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (r.status === 429) throw new Error(`too many attempts — blocked. retry after ${r.headers.get("retry-after")}s`);
  if (r.status === 401) throw new Error("unauthorized — check the token");
  return r.json();
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "");
const nm = (id) => AGENTS[id]?.displayName || id; // human name for an agent id
const pill = (on, label) => `<span class="pill ${on ? "on" : "off"}">${esc(label || (on ? "yes" : "no"))}</span>`;
const stateBadge = (s) =>
  `<span class="pill ${s === "idle" ? "on" : s === "busy" ? "busy" : s === "offline" ? "off" : "warn"}">${esc(s)}</span>`;

function rows(head, body, raw) {
  if (!body.length) return `<div class="empty">nothing here</div>`;
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const tr = body.map((r) => `<tr>${r.map((c) => `<td>${raw ? c : esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 429) throw new Error(`too many attempts — blocked. retry after ${r.headers.get("retry-after")}s`);
  if (r.status === 401) throw new Error("unauthorized — check the token");
  return r.json();
}

const MODEL_LABEL = { default: "default", "claude-fable-5-1": "Fable 5.1", "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5", "claude-opus-5": "Opus 5", "claude-fable-5": "Fable 5", "claude-sonnet-5": "Sonnet 5", "claude-opus-4-8": "Opus 4.8", "claude-sonnet-4-6": "Sonnet 4.6", "claude-haiku-4-5": "Haiku 4.5", "claude-haiku-4-5-20251001": "Haiku 4.5" };
let RUNTIMES = [{ id: "claude", label: "Claude", models: [] }]; // populated from /api/runtimes
let MAX_CODEX = 2;
const runtimeDef = (id) => RUNTIMES.find((r) => r.id === (id || "claude")) || RUNTIMES[0];
// Selectable model ids for an agent = its provider's models (codex advertises none -> just "default").
const modelsFor = (rt) => ["default", ...(runtimeDef(rt).models || [])];

// ---- write actions (exposed for inline handlers) ----
window.setModel = async (id, sel) => {
  sel.disabled = true;
  await post(`/api/agents/${id}/model`, { model: sel.value });
  await refreshAgents();
};
window.setRuntime = async (id, sel) => {
  sel.disabled = true;
  const r = await post(`/api/agents/${id}/runtime`, { runtime: sel.value });
  if (r && r.warning) alert(r.warning); // soft guardrail: ChatGPT Plus shared-cap warning past MAX_CODEX
  await refreshAgents();
};
window.agentAction = async (id, action) => {
  if (action === "stop" && !confirm(`Stop ${nm(id)}?`)) return;
  await post(`/api/agents/${id}/${action}`, {});
  setTimeout(refreshAgents, 1500);
};
window.emergencyRestart = async (btn) => {
  if (!confirm("EMERGENCY RESTART\n\nSaves the ENTIRE queue + all messages to a backup (nothing lost), clears the queue, restarts every agent, and briefs Michael to summarise it to you on Slack.\n\nUse when the fleet is going crazy / your messages aren't getting through. Proceed?")) return;
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "🚨 Working…"; }
  try {
    const r = await post("/api/emergency-restart", {});
    if (r && r.ok) {
      alert(`Done ✅\n\n• Saved ${r.saved.inboundPending} queued + ${r.saved.busPending} bus messages (plus failed) to:\n${r.backupDir}\n• Cleared ${r.cleared.inbound} inbound + ${r.cleared.bus} bus\n• Restarted ${r.restarted.length} agents\n• Briefed ${r.briefedAgent || "—"} — he'll message you on Slack shortly.`);
    } else {
      alert("Emergency restart FAILED: " + ((r && r.error) || "unknown error") + "\nNothing was deleted if the save step failed.");
    }
  } catch (e) {
    alert("Emergency restart error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
};
window.setEnabled = async (id, enabled) => {
  await post(`/api/agents/${id}/enabled`, { enabled });
  setTimeout(refreshAgents, 800);
};
window.moveCard = async (id, sel) => {
  await post(`/api/kanban/${encodeURIComponent(id)}/status`, { status: sel.value });
  showTab("kanban");
};
window.archiveCard = async (id, title) => {
  if (!confirm(`Archive "${title}"? (reversible)`)) return;
  await post(`/api/kanban/${encodeURIComponent(id)}/archive`, {});
  showTab("kanban");
};
window.setUsageWin = (w) => {
  window._usageWin = w;
  showTab("usage");
};
window.doUpdate = async (btn, discard) => {
  const ask = discard
    ? "Discard your local code changes and update?\n\nYour edits are saved to git stash (recoverable with `git stash pop`), then overwritten by the official version."
    : "Update now? The dashboard rebuilds and briefly restarts — your agents keep running.";
  if (!confirm(ask)) return;
  btn.disabled = true;
  btn.textContent = "Updating… rebuilding (~30s)";
  try {
    const r = await post("/api/update/apply", discard ? { discard: true } : {});
    if (r.ok) {
      btn.textContent = "Updated ✓ — restarting dashboard, reloading…";
      setTimeout(() => location.reload(), 8000);
    } else if (r.dirty) {
      // Dirty working tree: explain it plainly and offer a one-click, recoverable discard-and-update.
      btn.disabled = false;
      btn.textContent = "⟳ Update now";
      let box = document.getElementById("upd-dirty");
      if (!box) { box = document.createElement("div"); box.id = "upd-dirty"; box.className = "updb"; btn.after(box); }
      box.innerHTML =
        `<p>⚠ Update blocked — you have local changes to: <code>${esc((r.files || []).join(", "))}</code>. They'd be overwritten.</p>` +
        `<button onclick="doUpdate(this, true)">Discard local changes &amp; update</button>` +
        `<p class="muted">Discard saves them to <code>git stash</code> (recoverable). Or run <code>git stash</code> in a terminal to keep them, then retry.</p>`;
    } else {
      btn.disabled = false;
      btn.textContent = "⟳ Update failed — retry";
      alert("Update failed:\n\n" + (r.output || "").slice(-1500));
    }
  } catch (e) {
    btn.textContent = "Update error (the dashboard may be restarting) — reload in a moment";
    setTimeout(() => location.reload(), 9000);
  }
};

async function refreshAgents() {
  await loadAgentsMap();
  await loadOverview();
  await showTab("agents");
}

// ---- cron -> human-readable ----
function cronHuman(expr) {
  const p = (expr || "").trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, ho, dom, mon, dow] = p;
  const pad = (n) => String(n).padStart(2, "0");
  let m;
  if (ho === "*" && mi === "*") return "every minute";
  if ((m = mi.match(/^\*\/(\d+)$/)) && ho === "*") return `every ${m[1]} min`;
  if ((m = ho.match(/^\*\/(\d+)$/))) return `every ${m[1]} h`;
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = dow === "*" ? "" : dow === "1-5" ? "weekdays" : (dow === "0,6" || dow === "6,0") ? "weekends" : dow.split(",").map((d) => dowNames[Number(d)] || d).join("/");
  const date = dom === "*" && mon === "*" ? "" : `${mon !== "*" ? (monNames[Number(mon)] || mon) + " " : ""}${dom !== "*" ? dom : ""}`.trim();
  if (/^\d+$/.test(mi) && /^[\d,]+$/.test(ho)) {
    const times = ho.split(",").map(Number).sort((a, b) => a - b).map((h) => `${pad(h)}:${pad(Number(mi))}`);
    const t = times.join(" & ");
    if (date) return `${date} at ${t}`;
    if (days) return `${days} at ${t}`;
    return `daily at ${t}`;
  }
  return expr;
}
function cronSortKey(expr) {
  const p = (expr || "").split(/\s+/);
  if (p.length !== 5) return 99999;
  if (p[1] === "*") return -1; // intervals first
  const h = Number(p[1].split(",")[0]), mi = /^\d+$/.test(p[0]) ? Number(p[0]) : 0;
  return isNaN(h) ? 99999 : h * 60 + mi;
}
function schedDesc(x) {
  return x.type === "heartbeat"
    ? "Silent background check — only messages you if it finds something worth your attention."
    : "Runs on its schedule and reports the result to you on Slack.";
}
// real, task-specific explanation: prefer the task-config description, else the
// SKILL.md frontmatter `description:`, else the by-type fallback.
function taskDesc(x) {
  if (x.description && x.description.trim()) return x.description.trim();
  const m = (x.prompt || "").match(/description:\s*(.+)/);
  if (m) {
    const d = m[1].replace(/\s*---.*$/, "").trim();
    if (d) return d;
  }
  return schedDesc(x);
}

async function loadAgentsMap() {
  AGENTLIST = await api("/api/agents");
  AGENTS = Object.fromEntries(AGENTLIST.map((a) => [a.id, a]));
  try {
    const r = await api("/api/runtimes");
    if (r && r.runtimes && r.runtimes.length) RUNTIMES = r.runtimes;
    if (r && r.maxCodexAgents) MAX_CODEX = r.maxCodexAgents;
  } catch {
    /* keep the claude-only default if the endpoint is unavailable */
  }
}

async function loadOverview() {
  const o = await api("/api/overview");
  const k = o.kanban || {}, t = o.memoryByTier || {};
  const cards = [
    ["Agents online", `${AGENTLIST.filter((a) => a.running).length}/${o.agents}`],
    ["Memories", o.memories],
    ["hot / warm / cold", `${t.hot || 0} / ${t.warm || 0} / ${t.cold || 0}`],
    ["Kanban open", (k.planned || 0) + (k.in_progress || 0) + (k.waiting || 0)],
    ["Queue", o.queued],
    ["Schedules", `${o.schedulesEnabled}/${o.schedulesTotal}`],
    ["Channel", o.channel],
  ];
  $("#overview").innerHTML = cards.map(([l, n]) => `<div class="card"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join("");
  $("#conn").textContent = "connected";
}

const TABS = {
  async agents() {
    return (
      `<div class="agrid">` +
      AGENTLIST.map(
        (a) => `
      <div class="acard">
        <div class="ahead"><span class="aname">${esc(a.displayName)}</span>${stateBadge(a.running ? a.state : "offline")}</div>
        <div class="aid">@${esc(a.id)}</div>
        <div class="arow"><span class="k">runtime</span>
          <select class="msel" onchange="setRuntime('${esc(a.id)}', this)">
            ${RUNTIMES.map((rt) => `<option value="${esc(rt.id)}"${(a.runtime || "claude") === rt.id ? " selected" : ""}>${esc(rt.label)}</option>`).join("")}
          </select></div>
        <div class="arow"><span class="k">model</span>
          ${
            runtimeDef(a.runtime).models.length
              ? `<select class="msel" onchange="setModel('${esc(a.id)}', this)">
            ${modelsFor(a.runtime).map((mm) => `<option value="${mm}"${(a.model || "default") === mm ? " selected" : ""}>${esc(MODEL_LABEL[mm] || mm)}</option>`).join("")}
          </select>`
              : `<span class="muted">provider default</span>`
          }</div>
        <div class="arow"><span class="k">profile</span><span>${a.profile === "full" ? "full access" : `<span class="pill warn">${esc(a.profile)}</span>`}</span></div>
        <div class="arow"><span class="k">slack</span><span>${a.slack ? (a.slack.ready ? pill(true, "ready") : pill(false, "no token")) : "—"}</span></div>
        <div class="arow"><span class="k">memories</span><span>${a.memories}</span></div>
        ${a.allowFrom && a.allowFrom.length ? `<div class="arow"><span class="k">shared with</span><span>${a.allowFrom.length} external</span></div>` : ""}
        <div class="aacts">
          <button class="mini" onclick="agentAction('${esc(a.id)}','restart')">Restart</button>
          ${a.running ? `<button class="mini ghost" onclick="agentAction('${esc(a.id)}','stop')">Stop</button>` : `<button class="mini" onclick="agentAction('${esc(a.id)}','start')">Start</button>`}
          <button class="mini ghost" onclick="setEnabled('${esc(a.id)}', ${!a.enabled})">${a.enabled ? "Disable" : "Enable"}</button>
        </div>
      </div>`
      ).join("") +
      `</div>`
    );
  },

  async memories() {
    const agentOpts = `<option value="">All agents</option>` + AGENTLIST.map((a) => `<option value="${esc(a.id)}">${esc(a.displayName)}</option>`).join("");
    const tiers = ["", "hot", "warm", "cold", "shared"];
    setTimeout(() => {
      const run = async () => {
        const a = $("#mem-agent").value, t = $("#mem-tier").value, q = $("#mem-q").value.trim();
        const qs = new URLSearchParams();
        if (a) qs.set("agent", a);
        if (t) qs.set("category", t);
        if (q) qs.set("q", q);
        qs.set("limit", "150");
        const r = await api("/api/memories?" + qs.toString());
        $("#mem-results").innerHTML = r.length
          ? r.map((x) => `
            <div class="mem">
              <div class="memhead"><span class="pill tier-${esc(x.category)}">${esc(x.category)}</span> <b>${esc(nm(x.agent_id))}</b> <span class="muted">${when(x.created_at)}</span></div>
              <details><summary>${esc(x.content).slice(0, 170)}${x.content.length > 170 ? "…" : ""}</summary><div class="full">${esc(x.content)}</div>${x.keywords ? `<div class="kw">🔑 ${esc(x.keywords)}</div>` : ""}</details>
            </div>`).join("")
          : `<div class="empty">no memories match</div>`;
      };
      $("#mem-go").onclick = run;
      ["mem-agent", "mem-tier"].forEach((id) => ($("#" + id).onchange = run));
      $("#mem-q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
      run();
    }, 0);
    return `
      <div class="ctl">
        <select id="mem-agent">${agentOpts}</select>
        <select id="mem-tier">${tiers.map((t) => `<option value="${t}">${t || "All tiers"}</option>`).join("")}</select>
        <input id="mem-q" type="text" placeholder="search keywords/content…"/>
        <button id="mem-go">Filter</button>
      </div>
      <div id="mem-results"></div>`;
  },

  async kanban() {
    const cards = await api("/api/kanban");
    const cols = [["planned", "Planned"], ["in_progress", "In progress"], ["waiting", "Waiting"], ["done", "Done"]];
    const byStatus = Object.fromEntries(cols.map(([s]) => [s, []]));
    cards.forEach((c) => (byStatus[c.status] || (byStatus[c.status] = [])).push(c));
    return (
      `<div class="board">` +
      cols.map(([s, label]) => `
        <div class="col">
          <div class="colhead">${label}<span class="count">${(byStatus[s] || []).length}</span></div>
          ${(byStatus[s] || []).map((c) => `
            <div class="kcard pri-${esc(c.priority)}">
              <div class="ktitle">${esc(c.title)}</div>
              <div class="kmeta"><span class="pill pri-b-${esc(c.priority)}">${esc(c.priority)}</span>${c.assignee ? ` <span class="muted">${esc(nm(c.assignee))}</span>` : ""}${c.project ? ` · ${esc(c.project)}` : ""}</div>
              ${c.description ? `<details><summary>details</summary><div class="full">${esc(c.description)}</div></details>` : ""}
              <div class="kactrow">
                <select class="ksel" onchange="moveCard('${esc(c.id)}', this)">
                  ${[["planned", "Planned"], ["in_progress", "In progress"], ["waiting", "Waiting"], ["done", "Done"]].map(([v, lbl]) => `<option value="${v}"${c.status === v ? " selected" : ""}>→ ${lbl}</option>`).join("")}
                </select>
                <button class="mini ghost xbtn" title="Archive" onclick="archiveCard('${esc(c.id)}', ${JSON.stringify(c.title).replace(/"/g, "&quot;")})">✕</button>
              </div>
            </div>`).join("")}
        </div>`).join("") +
      `</div>`
    );
  },

  async schedules() {
    const s = await api("/api/schedules");
    const byTime = (a, b) => cronSortKey(a.schedule) - cronSortKey(b.schedule);
    const en = s.filter((x) => x.enabled).sort(byTime);
    const dis = s.filter((x) => !x.enabled).sort(byTime);
    const card = (x) => `
      <div class="sched">
        <div class="schhead"><b>${esc(x.name)}</b> <span class="pill ${x.type === "task" ? "on" : ""}">${esc(x.type)}</span> <span class="muted">${esc(nm(x.agent))}</span></div>
        <div class="schtime">🕒 <b>${esc(cronHuman(x.schedule))}</b> <span class="muted">(${esc(x.schedule)})</span></div>
        <div class="schdesc">${esc(taskDesc(x))}</div>
      </div>`;
    return `<h3 class="sect">✅ Enabled — ${en.length} (sorted by time of day)</h3>` +
      (en.map(card).join("") || `<div class="empty">none</div>`) +
      `<h3 class="sect">⏸ Disabled — ${dis.length}</h3>` +
      (dis.map(card).join("") || `<div class="empty">none</div>`);
  },

  async queue() {
    const q = await api("/api/queue");
    const summary = Object.entries(q.byStatus || {}).map(([k, v]) => `${k}: ${v}`).join("  ·  ") || "empty";
    return `<p class="muted">${esc(summary)}</p>` + rows(["Agent", "Source", "Status", "Try", "Preview"], q.recent.map((x) => [esc(nm(x.agent_id)), esc(x.source), `<span class="pill">${esc(x.status)}</span>`, x.attempts, esc(x.preview)]), true);
  },

  async messages() {
    const m = await api("/api/messages");
    return m.length
      ? `<div class="msgs">` + m.map((x) => `
        <details class="msg">
          <summary><b>${esc(nm(x.from_agent))}</b> → <b>${esc(nm(x.to_agent))}</b> <span class="pill">${esc(x.status)}</span> <span class="muted">${when(x.created_at)}</span>
            <div class="mprev">${esc(x.content).slice(0, 100)}${x.content.length > 100 ? "…" : ""}</div></summary>
          <div class="full">${esc(x.content)}</div>
          ${x.result ? `<div class="muted lbl">result</div><div class="full">${esc(x.result)}</div>` : ""}
        </details>`).join("") + `</div>`
      : `<div class="empty">no messages</div>`;
  },

  async usage() {
    const win = window._usageWin || "24h";
    const wins = [["1h", "1h"], ["24h", "24h"], ["3d", "3d"], ["7d", "7d"], ["restart", "since restart"], ["all", "all"]];
    const d = await api("/api/usage?window=" + win);
    const fmt = (n) => (n || 0).toLocaleString();
    const btns = `<div class="ctl">` + wins.map(([v, l]) => `<button class="winbtn${v === win ? " active" : ""}" onclick="setUsageWin('${v}')">${l}</button>`).join("") + `</div>`;
    const tot = d.usage.reduce((a, x) => ({ o: a.o + x.output, i: a.i + x.input, t: a.t + x.turns, cr: a.cr + x.cacheRead, cc: a.cc + x.cacheWrite }), { o: 0, i: 0, t: 0, cr: 0, cc: 0 });
    const na = (x, v) => (x.tracked === false ? "n/a" : fmt(v));
    const body = d.usage.map((x) => [esc(x.displayName), na(x, x.turns), na(x, x.output), na(x, x.input), na(x, x.cacheRead), na(x, x.cacheWrite), na(x, x.thinking)]);
    const th = d.usage.reduce((n, x) => n + (x.thinking || 0), 0);
    body.push([`<b>TOTAL</b>`, `<b>${fmt(tot.t)}</b>`, `<b>${fmt(tot.o)}</b>`, `<b>${fmt(tot.i)}</b>`, `<b>${fmt(tot.cr)}</b>`, `<b>${fmt(tot.cc)}</b>`, `<b>${fmt(th)}</b>`]);
    return btns + `<p class="muted">window: <b>${esc(win)}</b> · output tokens = the headline figure (flat-rate subscription — usage signal, not billed per token)</p>` +
      rows(["Agent", "Turns", "Output", "Input", "Cache read", "Cache write", "Thinking (codex/gemini)"], body, true);
  },

  async updates() {
    const d = await api("/api/update/check");
    if (d.error) return `<div class="empty">${esc(d.error)}</div>`;
    if (!d.behind) return `<div class="empty">✓ You're up to date<br><span class="muted">current build: ${esc(d.current)}</span></div>`;
    const list = d.commits
      .map((c) => `<div class="upd"><div class="updh"><b>${esc(c.subject)}</b> <span class="muted">${esc(c.hash)}</span></div>${c.body ? `<div class="updb">${esc(c.body)}</div>` : ""}</div>`)
      .join("");
    return `<p><b>${d.behind}</b> update${d.behind > 1 ? "s" : ""} available — you're on <code>${esc(d.current)}</code>:</p>${list}
      <button id="do-update" onclick="doUpdate(this)">⟳ Update now</button>
      <p class="muted">It pulls the latest, rebuilds, and briefly restarts the dashboard. Your agents keep running.</p>`;
  },

  async logs() {
    const l = await api("/api/daily-logs?limit=80");
    return l.length
      ? `<div class="msgs">` + l.map((x) => `
        <details class="msg"><summary><b>${esc(nm(x.agent_id))}</b> <span class="muted">${esc(x.date)}</span></summary><div class="full">${esc(x.content)}</div></details>`).join("") + `</div>`
      : `<div class="empty">no daily logs yet</div>`;
  },
};

async function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  try {
    $("#panel").innerHTML = await TABS[name]();
  } catch (e) {
    $("#panel").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------------- Claude sign-in (no terminal needed) ----------------
// The whole fleet shares ONE Claude credential. When it lapses every agent goes silent while
// /api/agents still reports them "running" — process liveness is not authentication. This banner is
// driven by /api/auth/health, which inspects the credential AND the live panes.
let AUTH = null;
// Guards the poll from re-rendering over a half-typed code (the PKCE challenge is bound to one session).
let AUTH_UI_BUSY = false;

async function refreshAuth() {
  try { AUTH = await api("/api/auth/health"); } catch { return; }
  renderAuthBanner();
}

function renderAuthBanner() {
  const host = $("#auth-banner");
  if (!host || AUTH_UI_BUSY) return;
  if (!AUTH || AUTH.ok) { host.innerHTML = ""; host.style.display = "none"; return; }
  const warn = AUTH.status === "expiring-soon";
  const restartOnly = AUTH.restartWouldFix === true;
  const action = restartOnly
    ? `<button onclick="authRestart(this)" style="background:#f59e0b;color:#111;border:0;border-radius:8px;padding:9px 13px;font-weight:800;cursor:pointer">↻ Restart signed-out agents</button>`
    : `<button onclick="authSignIn()" style="background:#fff;color:#111;border:0;border-radius:8px;padding:9px 13px;font-weight:800;cursor:pointer">🔑 Sign in to Claude</button>`;
  host.style.display = "block";
  host.innerHTML = `
    <div style="background:${warn ? "#7c5e10" : "#7f1d1d"};border:1px solid ${warn ? "#b8860b" : "#dc2626"};
                border-radius:10px;padding:12px 14px;margin:0 0 14px;color:#fff;display:flex;gap:12px;
                align-items:center;flex-wrap:wrap">
      <div style="font-size:20px">${warn ? "⏳" : "🔴"}</div>
      <div style="flex:1;min-width:220px">
        <div style="font-weight:800;margin-bottom:2px">${warn ? "Claude login expiring" : restartOnly ? "Agents need a restart" : "Fleet cannot authenticate"}</div>
        <div style="font-size:13px;opacity:.92">${esc(AUTH.message || "")}</div>
      </div>${action}
    </div>`;
}

window.authSignIn = async () => {
  const host = $("#auth-banner");
  AUTH_UI_BUSY = true;
  host.innerHTML = `<div style="background:#1f2937;border:1px solid #374151;border-radius:10px;padding:14px;margin:0 0 14px;color:#e5e7eb">Starting sign-in…</div>`;
  let r;
  try { r = await post("/api/auth/login/start", {}); }
  catch (e) { AUTH_UI_BUSY = false; alert("Could not start sign-in: " + e.message); return renderAuthBanner(); }
  if (!r || !r.ok || !r.url) { AUTH_UI_BUSY = false; alert("Could not start sign-in: " + ((r && r.error) || "unknown error")); return renderAuthBanner(); }
  host.innerHTML = `
    <div style="background:#12233a;border:1px solid #1d4ed8;border-radius:10px;padding:14px;margin:0 0 14px;color:#e5e7eb">
      <div style="font-weight:800;margin-bottom:8px">🔑 Sign in to Claude — 2 steps</div>
      <div style="font-size:13px;margin-bottom:6px"><b>1.</b> Open this link and approve:</div>
      <a href="${esc(r.url)}" target="_blank" rel="noopener" style="display:inline-block;background:#2563eb;color:#fff;
         text-decoration:none;border-radius:8px;padding:10px 16px;font-weight:800;margin-bottom:12px">Open sign-in page ↗</a>
      <div style="font-size:13px;margin-bottom:6px"><b>2.</b> Paste the code it gives you:</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="auth-code" type="text" autocomplete="off" spellcheck="false" placeholder="paste code here"
               style="flex:1;min-width:240px;background:#0b1220;color:#e5e7eb;border:1px solid #334155;
                      border-radius:8px;padding:10px" />
        <button onclick="authSubmitCode(this)" style="background:#10b981;color:#04231a;border:0;border-radius:8px;
                padding:10px 16px;font-weight:800;cursor:pointer">Finish sign-in</button>
        <button onclick="authCancel()" style="background:transparent;color:#94a3b8;border:1px solid #334155;
                border-radius:8px;padding:10px 14px;cursor:pointer">Cancel</button>
      </div>
      <div id="auth-msg" style="font-size:13px;color:#fca5a5;margin-top:8px"></div>
    </div>`;
  const el = $("#auth-code"); if (el) el.focus();
};

window.authSubmitCode = async (btn) => {
  const code = ($("#auth-code")?.value || "").trim();
  const msg = $("#auth-msg");
  if (!code) { msg.textContent = "Paste the code first."; return; }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Signing in…";
  msg.style.color = "#93c5fd"; msg.textContent = "Verifying the code and restarting agents…";
  try {
    const r = await post("/api/auth/login/code", { code });
    if (r && r.ok) {
      AUTH_UI_BUSY = false;
      const n = (r.restarted || []).length;
      $("#auth-banner").innerHTML = `<div style="background:#064e3b;border:1px solid #10b981;border-radius:10px;
        padding:14px;margin:0 0 14px;color:#d1fae5"><b>✅ Signed in — fleet is back.</b> Restarted ${n} agent(s)
        onto the new login.</div>`;
      setTimeout(refreshAuth, 5000);
      return;
    }
    msg.style.color = "#fca5a5";
    msg.textContent = (r && r.error) || "Sign-in failed. Start again for a fresh link.";
  } catch (e) {
    msg.style.color = "#fca5a5"; msg.textContent = "Error: " + e.message;
  } finally { btn.disabled = false; btn.textContent = label; }
};

window.authCancel = async () => {
  try { await post("/api/auth/login/cancel", {}); } catch { /* best effort */ }
  AUTH_UI_BUSY = false;
  renderAuthBanner();
};

function restartSummary(r) {
  const lines = [`Restarted ${(r.restarted || []).length} agent(s).`];
  if ((r.skippedBusy || []).length) lines.push(`Left alone (mid-task): ${r.skippedBusy.join(", ")}`);
  if ((r.failed || []).length) lines.push(`Failed: ${r.failed.join(", ")}`);
  return lines.join("\n");
}

window.authRestart = async (btn) => {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Restarting…";
  try {
    const r = await post("/api/auth/restart", {});
    // Report the skipped ones too. Without this a run that touched nothing because every candidate
    // was mid-task reads as "Restarted 0 agent(s)" — no reason given, so the obvious move is to
    // press the button again, and again.
    alert(r && r.ok ? restartSummary(r) : "Restart failed.");
  } catch (e) { alert("Restart failed: " + e.message); }
  finally { btn.disabled = false; btn.textContent = label; setTimeout(refreshAuth, 3000); }
};

async function connect() {
  try {
    await loadAgentsMap();
    await loadOverview();
    await showTab("agents");
    await refreshAuth();
  } catch (e) {
    $("#conn").textContent = e.message;
  }
}

$("#save").addEventListener("click", () => {
  TOKEN = $("#token").value.trim();
  localStorage.setItem("office_token", TOKEN);
  connect();
});
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
setInterval(() => { if (TOKEN) refreshAuth(); }, 20000);
if (TOKEN) {
  $("#token").value = TOKEN;
  connect();
}
