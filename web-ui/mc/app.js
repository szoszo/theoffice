/* The Office — Mission Control. "Refined Ops" front-end.
   Single-user internal dashboard, vanilla JS. Theme/accent/density live entirely
   in CSS custom properties set on :root by applyTheme(); every view reads var(--token).
   All numbers are wired to the live engine API; nothing is hard-coded per agent. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let TOKEN = localStorage.getItem("office_token") || "";

// ---------------- API ----------------
async function api(path) {
  const r = await fetch(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (r.status === 429) throw new Error(`rate limited — retry after ${r.headers.get("retry-after")}s`);
  if (r.status === 401) throw new Error("unauthorized — check the token");
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 429) throw new Error(`rate limited — retry after ${r.headers.get("retry-after")}s`);
  if (r.status === 401) throw new Error("unauthorized — check the token");
  return r.json();
}

// ---------------- format helpers ----------------
const fmtInt = (n) => (n || 0).toLocaleString();
function fmtTokens(n) {
  if (n === "n/a" || n == null) return "n/a";
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 100 ? Math.round(k) : k.toFixed(1)).toString().replace(/\.0$/, "") + "k";
}
const pad2 = (n) => String(n).padStart(2, "0");
function fmtClock(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}
function ago(tsSec) {
  if (!tsSec) return "";
  const s = Math.floor(Date.now() / 1000 - tsSec);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function fmtDur(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
function hexToRgba(hex, a) {
  const h = String(hex || "#000").replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------------- theme tokens (from design-tokens.json) ----------------
const TOKENS = {
  dark: { bg: "#0b0c0e", bg2: "#0f1113", surface: "#151719", surface2: "#1c1f23", border: "#23262b", border2: "#34383e", text: "#e9ebee", dim: "#9aa1a8", faint: "#646a70", ok: "#3ddc91", warn: "#f5b14c", danger: "#f6776b", info: "#6ea8ff" },
  light: { bg: "#f3f4f6", bg2: "#eaecef", surface: "#ffffff", surface2: "#f6f7f9", border: "#e4e7ea", border2: "#d3d7db", text: "#15181b", dim: "#5c636a", faint: "#929aa1", ok: "#0f9d63", warn: "#bd7a08", danger: "#d6453a", info: "#2f6fe0" },
};
const ACCENTS = {
  green: { dark: "#3ddc91", light: "#0f9d63" },
  blue: { dark: "#6ea8ff", light: "#2f6fe0" },
  amber: { dark: "#f5b14c", light: "#bd7a08" },
  violet: { dark: "#b69bff", light: "#6f51e6" },
};
const SWATCH = { green: "#3ddc91", blue: "#6ea8ff", amber: "#f5b14c", violet: "#b69bff" };
const ACCENT_SOFT_A = { dark: 0.16, light: 0.12 };
const ACCENT_LINE_A = { dark: 0.45, light: 0.35 };
const DENSITY = { cozy: { pad: "18px", gap: "15px", cardMin: "312px" }, compact: { pad: "13px", gap: "10px", cardMin: "272px" } };

let PREFS = {
  theme: localStorage.getItem("office_theme") || "dark",
  density: localStorage.getItem("office_density") || "cozy",
  accent: localStorage.getItem("office_accent") || "green",
};
let CUR = {}; // resolved current color values, for alpha composition in JS

function applyTheme() {
  const t = PREFS.theme === "light" ? "light" : "dark";
  const tk = TOKENS[t];
  const accentHex = (ACCENTS[PREFS.accent] || ACCENTS.green)[t];
  const den = DENSITY[PREFS.density] || DENSITY.cozy;
  const root = document.documentElement.style;
  Object.entries(tk).forEach(([k, v]) => root.setProperty("--" + k, v));
  root.setProperty("--accent", accentHex);
  root.setProperty("--accentSoft", hexToRgba(accentHex, ACCENT_SOFT_A[t]));
  root.setProperty("--accentLine", hexToRgba(accentHex, ACCENT_LINE_A[t]));
  root.setProperty("--accentDim", hexToRgba(accentHex, 0.35));
  root.setProperty("--okSoft", hexToRgba(tk.ok, 0.12));
  root.setProperty("--faintSoft", hexToRgba(tk.faint, 0.16));
  root.setProperty("--pad", den.pad);
  root.setProperty("--gap", den.gap);
  root.setProperty("--cardMin", den.cardMin);
  document.documentElement.style.colorScheme = t;
  CUR = { ...tk, accent: accentHex };
}
function setPref(k, v) {
  PREFS[k] = v;
  localStorage.setItem("office_" + k, v);
  applyTheme();
  renderHeader();
}

// ---------------- data ----------------
let AGENTLIST = [], AGENTS = {}, OVERVIEW = {}, USAGE = {}, HOST = {}, SCHEDULES = [];
let AUTH = null;                   // /api/auth/health — drives the sign-in banner
let RUNTIMES = [{ id: "claude", label: "Claude Code", models: [], efforts: [] }];
let MAX_CODEX = 2;
let CURRENT_TAB = "agents";
const RESTARTING = new Set();      // agent ids in optimistic restart
const RUN_SINCE = {};              // agent id -> ms first observed running (client-side elapsed)

const PALETTE = ["#3ddc91", "#6ea8ff", "#f5b14c", "#b69bff", "#f6776b", "#5ad1c8", "#e88adb", "#8fd24c"];
function colorFor(idOrAgent) {
  const a = typeof idOrAgent === "string" ? AGENTS[idOrAgent] : idOrAgent;
  const id = a ? a.id : idOrAgent;
  if (a && a.color) return a.color;
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const nm = (id) => AGENTS[id]?.displayName || id;
const initialOf = (s) => String(s || "?").trim().charAt(0).toUpperCase();

// engine state -> design status
function statusOf(a) {
  if (RESTARTING.has(a.id)) return "restarting";
  if (!a.enabled) return "disabled";
  if (!a.running) return "offline";
  if (a.state === "busy") return "running";
  if (a.state === "idle") return "idle";
  return "unknown";
}
const STATUS = {
  running: { color: "info", pulse: true }, idle: { color: "ok", pulse: false },
  unknown: { color: "warn", pulse: false }, offline: { color: "danger", pulse: false },
  restarting: { color: "accent", pulse: true }, disabled: { color: "faint", pulse: false },
};
const statusHex = (st) => CUR[STATUS[st].color] || CUR.accent;
function activityCopy(a, st) {
  switch (st) {
    case "running": return "Working…";
    case "restarting": return "Restarting runtime…";
    case "unknown": return "Status unknown — cold start";
    case "offline": return "Stopped";
    case "disabled": return "Disabled";
    default: return "Idle — awaiting tasks";
  }
}

async function refreshData() {
  const [agents, overview, usage, host, schedules, runtimes, auth] = await Promise.all([
    api("/api/agents"),
    api("/api/overview").catch(() => ({})),
    api("/api/usage?window=24h").catch(() => ({ usage: [] })),
    api("/api/host").catch(() => ({})),
    api("/api/schedules").catch(() => ([])),
    api("/api/runtimes").catch(() => null),
    api("/api/auth/health").catch(() => null),
  ]);
  if (auth) AUTH = auth;
  AGENTLIST = agents;
  AGENTS = Object.fromEntries(agents.map((a) => [a.id, a]));
  OVERVIEW = overview || {};
  USAGE = Object.fromEntries((usage.usage || []).map((u) => [u.id, u]));
  HOST = host || {};
  SCHEDULES = Array.isArray(schedules) ? schedules : [];
  if (runtimes && runtimes.runtimes && runtimes.runtimes.length) RUNTIMES = runtimes.runtimes;
  if (runtimes && runtimes.maxCodexAgents) MAX_CODEX = runtimes.maxCodexAgents;
  const now = Date.now();
  agents.forEach((a) => {
    const running = statusOf(a) === "running";
    if (running && !RUN_SINCE[a.id]) RUN_SINCE[a.id] = now;
    if (!running) delete RUN_SINCE[a.id];
  });
}

// ---------------- header ----------------
function seg(group, opts) {
  return `<div class="seg">` + opts.map(([v, l]) =>
    `<button class="${PREFS[group] === v ? "active" : ""}" onclick="setPref('${group}','${v}')">${l}</button>`).join("") + `</div>`;
}
function renderHeader() {
  $("#hwrap").innerHTML = `
    <div class="brand">
      <div class="glyph">O</div>
      <div class="wordmark"><div class="t1">The Office</div><div class="t2">Mission Control</div></div>
    </div>
    <div class="controls">
      <button id="emergency-btn" onclick="emergencyRestart(this)" title="Save the whole queue, wipe it, restart every agent, and have Michael brief you"
              style="flex:0 0 auto;background:#dc2626;color:#fff;border:0;border-radius:9px;padding:9px 13px;
                     font-weight:800;font-size:13px;letter-spacing:.2px;cursor:pointer;box-shadow:0 1px 0 rgba(0,0,0,.25)">
        🚨 Emergency Restart
      </button>
      <div class="connpill" id="connpill">
        <span class="dot"></span><b>connected</b>
        <span class="sep"></span><span class="host">${esc(location.host || "local")}</span>
        <span class="clock" id="clock">${fmtClock(new Date())}</span>
      </div>
      ${seg("theme", [["dark", "Dark"], ["light", "Light"]])}
      ${seg("density", [["cozy", "Cozy"], ["compact", "Compact"]])}
      <div class="swatches">
        ${Object.entries(SWATCH).map(([k, hex]) =>
          `<button class="${PREFS.accent === k ? "active" : ""}" style="background:${hex}" title="${k}" onclick="setPref('accent','${k}')"></button>`).join("")}
      </div>
    </div>`;
}

// ---------------- stat strip ----------------
function renderStrip() {
  const o = OVERVIEW, t = o.memoryByTier || {}, k = o.kanban || {};
  const onlineN = AGENTLIST.filter((a) => a.running).length;
  const totalN = o.agents ?? AGENTLIST.length;
  const hot = t.hot || 0, warm = t.warm || 0, cold = t.cold || 0;
  const memTot = (o.memories ?? (hot + warm + cold)) || 0;
  const sg = (n, c) => memTot ? `<span style="width:${(n / memTot * 100).toFixed(1)}%;background:${c}"></span>` : "";
  const tokToday = AGENTLIST.reduce((s, a) => { const u = USAGE[a.id]; return s + (u && u.tracked !== false ? (u.output || 0) : 0); }, 0);
  const kOpen = (k.planned || 0) + (k.in_progress || 0) + (k.waiting || 0);
  const queued = o.queued || 0;
  const schEn = o.schedulesEnabled ?? SCHEDULES.filter((s) => s.enabled).length;
  const schTot = o.schedulesTotal ?? SCHEDULES.length;
  const next = nextSchedule();

  const cards = [
    `<div class="stat"><div class="big tnum">${onlineN} <span class="sub">/ ${totalN}</span></div><div class="lbl">Agents online</div>
       <div class="dotrow">${AGENTLIST.map((a) => `<span class="d" style="background:${colorFor(a)};opacity:${a.running ? 1 : .35}"></span>`).join("")}</div></div>`,
    `<div class="stat"><div class="big tnum">${fmtInt(memTot)}</div><div class="lbl">Memories</div>
       <div class="segbar">${sg(hot, CUR.danger)}${sg(warm, CUR.warn)}${sg(cold, CUR.info)}</div>
       <div class="cap">${hot} hot · ${warm} warm · ${cold} cold</div></div>`,
    `<div class="stat"><div class="big tnum">${fmtTokens(tokToday)}</div><div class="lbl">Tokens · 24h</div>
       <div class="cap"><span class="livedot"></span>live · across ${onlineN} agent${onlineN === 1 ? "" : "s"}</div></div>`,
    `<div class="stat"><div class="big tnum">${kOpen}</div><div class="lbl">Kanban open</div>
       <div class="cap">${k.in_progress || 0} in progress · ${k.waiting || 0} review</div></div>`,
    `<div class="stat"><div class="big tnum">${queued}</div><div class="lbl">Queue</div>
       <div class="cap">${queued ? queued + " waiting" : `<span class="ok">clear</span>`}</div></div>`,
    `<div class="stat"><div class="big tnum">${schEn} <span class="sub">/ ${schTot}</span></div><div class="lbl">Schedules</div>
       <div class="cap">${next ? "next · " + esc(next) : "none scheduled"}</div></div>`,
  ];
  $("#strip").innerHTML = cards.join("");
}

// ---------------- tabs ----------------
const TAB_DEFS = [
  ["agents", "Agents"], ["memory", "Memory"], ["kanban", "Kanban"], ["schedules", "Schedules"],
  ["queue", "Queue"], ["messages", "Messages"], ["usage", "Usage"], ["logs", "Logs"], ["update", "Update"],
];
function tabBadge(id) {
  const o = OVERVIEW, k = o.kanban || {};
  if (id === "memory") return o.memories || 0;
  if (id === "kanban") return (k.planned || 0) + (k.in_progress || 0) + (k.waiting || 0);
  if (id === "schedules") return o.schedulesEnabled || 0;
  if (id === "queue") return o.queued || 0;
  return 0;
}
function renderTabs() {
  $("#tabs").innerHTML = TAB_DEFS.map(([id, label]) => {
    const b = tabBadge(id);
    return `<button class="${CURRENT_TAB === id ? "active" : ""}" data-tab="${id}" onclick="showTab('${id}')">${label}${b > 0 ? `<span class="badge">${b}</span>` : ""}</button>`;
  }).join("");
}

async function showTab(name) {
  CURRENT_TAB = name;
  renderTabs();
  try {
    $("#panel").innerHTML = await VIEWS[name]();
  } catch (e) {
    $("#panel").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------------- views ----------------
const MODEL_LABEL = { default: "default", "claude-opus-5": "Opus 5", "claude-fable-5": "Fable 5", "claude-sonnet-5": "Sonnet 5", "claude-opus-4-8": "Opus 4.8", "claude-haiku-4-5": "Haiku 4.5" };
const runtimeDef = (id) => RUNTIMES.find((r) => r.id === (id || "claude")) || RUNTIMES[0];

function agentCard(a) {
  const st = statusOf(a);
  const sc = statusHex(st);
  const col = colorFor(a);
  const u = USAGE[a.id];
  const tokens = u ? (u.tracked === false ? "n/a" : fmtTokens(u.output || 0)) : "n/a";
  const role = a.role || (a.displayName.match(/\(([^)]+)\)/)?.[1]) || "";
  const name = a.displayName.replace(/\s*\([^)]*\)\s*$/, "");
  const pulse = STATUS[st].pulse ? `--dc:${hexToRgba(sc, .55)};animation:pulseDot 1.6s ease-out infinite;` : "";
  const elapsedHtml = st === "running"
    ? `<span class="elapsed" data-id="${esc(a.id)}">${fmtElapsed(Date.now() - (RUN_SINCE[a.id] || Date.now()))}</span>` : "";

  const rdef = runtimeDef(a.runtime);
  const models = rdef.models || [];
  let modelOpts = ["default", ...models];
  if (a.model && !modelOpts.includes(a.model)) modelOpts = [a.model, ...modelOpts];
  const modelSel = models.length
    ? `<select onchange="setModel('${esc(a.id)}', this)">${modelOpts.map((mm) => `<option value="${esc(mm)}"${(a.model || "default") === mm ? " selected" : ""}>${esc(MODEL_LABEL[mm] || mm)}</option>`).join("")}</select>`
    : `<select disabled title="provider-managed model"><option>${esc(MODEL_LABEL[a.model] || a.model || "provider default")}</option></select>`;

  // Providers without an effort knob (codex, gemini) advertise an empty list -> no control at all,
  // rather than a dropdown that silently does nothing.
  const efforts = rdef.efforts || [];
  let effortOpts = ["default", ...efforts];
  if (a.effort && !effortOpts.includes(a.effort)) effortOpts = [a.effort, ...effortOpts];
  const effortSel = efforts.length
    ? `<div class="r"><span class="k">effort</span><select onchange="setEffort('${esc(a.id)}', this)">${effortOpts.map((ee) => `<option value="${esc(ee)}"${(a.effort || "default") === ee ? " selected" : ""}>${esc(ee)}</option>`).join("")}</select></div>`
    : "";

  const canStop = a.running;
  return `<div class="acard${a.enabled ? "" : " disabled"}">
    <div class="ahead">
      <div class="coin" style="background:${col}">${esc(initialOf(name))}</div>
      <div class="nameblock">
        <div class="nameline"><span class="nm">${esc(name)}</span><span class="hd">@${esc(a.handle || a.id)}</span></div>
        ${role ? `<div class="role">${esc(role)}</div>` : ""}
      </div>
      <span class="sbadge" style="background:${hexToRgba(sc, .14)};color:${sc}"><span class="dot" style="background:${sc};${pulse}"></span>${esc(st)}</span>
    </div>
    <div class="activity">
      <span class="dot" style="background:${sc}"></span>
      <span class="txt" style="color:${st === "idle" || st === "offline" || st === "disabled" ? "var(--dim)" : sc}">${esc(activityCopy(a, st))}</span>
      ${elapsedHtml}
    </div>
    <div class="selrow">
      <div class="r"><span class="k">runtime</span>
        <select onchange="setRuntime('${esc(a.id)}', this)">${RUNTIMES.map((rt) => `<option value="${esc(rt.id)}"${(a.runtime || "claude") === rt.id ? " selected" : ""}>${esc(rt.label)}</option>`).join("")}</select></div>
      <div class="r"><span class="k">model</span>${modelSel}</div>
      ${effortSel}
    </div>
    <div class="tiles">
      <div class="tile" style="flex:1"><div class="tl">context</div><div class="tv tnum" style="${a.contextPct != null ? (a.contextPct >= 85 ? "color:#dc2626" : a.contextPct >= 70 ? "color:#d97706" : "color:#16a34a") : "color:#16a34a;font-size:13px"}">${a.contextPct != null ? a.contextPct + "%" : "ok"}</div></div>
      <div class="tile" style="flex:1"><div class="tl">memories</div><div class="tv tnum">${a.memories ?? 0}</div></div>
      <div class="tile" style="flex:1.2"><div class="tl">tokens 24h</div><div class="tv tnum">${tokens}</div></div>
      <div class="tile" style="flex:1"><div class="tl">profile</div><div class="tv" style="font-size:13px">${a.profile === "full" ? "full" : esc(a.profile)}</div></div>
    </div>
    <div class="acts">
      <button class="primary" onclick="agentAction('${esc(a.id)}','restart')">Restart</button>
      <button class="ghost" title="Write handoff → restart fresh → re-read it → Slack you a summary" onclick="cleanReset('${esc(a.id)}')">↻ Handoff</button>
      ${canStop ? `<button class="ghost" onclick="agentAction('${esc(a.id)}','stop')">Stop</button>` : `<button class="ghost" onclick="agentAction('${esc(a.id)}','start')">Start</button>`}
      <button class="ghost ${a.enabled ? "danger" : ""}" onclick="setEnabled('${esc(a.id)}', ${!a.enabled})">${a.enabled ? "Disable" : "Enable"}</button>
    </div>
  </div>`;
}

const TIER_COLOR = { hot: "danger", warm: "warn", cold: "info", shared: "accent" };
function authorChip(id) {
  const c = colorFor(id);
  return `<div class="author"><span class="sq" style="background:${c}">${esc(initialOf(nm(id)))}</span><span class="an">${esc(nm(id))}</span></div>`;
}

const VIEWS = {
  async agents() {
    return `<div class="agrid">${AGENTLIST.map(agentCard).join("")}</div>`;
  },

  async memory() {
    const t = OVERVIEW.memoryByTier || {};
    const tot = OVERVIEW.memories || 0;
    const chips = [["", "All", tot], ["hot", "Hot", t.hot || 0], ["warm", "Warm", t.warm || 0], ["cold", "Cold", t.cold || 0]];
    const active = window._memTier || "";
    setTimeout(() => {
      const run = async () => {
        const q = ($("#mem-q")?.value || "").trim();
        const qs = new URLSearchParams();
        if (window._memTier) qs.set("category", window._memTier);
        if (q) qs.set("q", q);
        qs.set("limit", "150");
        const r = await api("/api/memories?" + qs.toString());
        $("#mem-list").innerHTML = r.length
          ? r.map((x) => {
            const tc = CUR[TIER_COLOR[x.category]] || CUR.info;
            return `<div class="memrow">
              <span class="tier" style="background:${hexToRgba(tc, .15)};color:${tc}">${esc(x.category)}</span>
              <span class="memtext" onclick="this.classList.toggle('open')">${esc(x.content)}</span>
              ${authorChip(x.agent_id)}
              <span class="ago">${ago(x.created_at)}</span>
            </div>`;
          }).join("")
          : `<div class="empty">no memories match</div>`;
      };
      const s = $("#mem-q"); if (s) s.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
      run();
    }, 0);
    return `<div class="filterrow">
        ${chips.map(([v, l, n]) => `<button class="chip${active === v ? " active" : ""}" onclick="setMemTier('${v}')">${l} ${n}</button>`).join("")}
        <input id="mem-q" class="search" type="text" placeholder="search memories…" />
      </div>
      <div class="panelcard" id="mem-list"></div>`;
  },

  async kanban() {
    const cards = await api("/api/kanban");
    const cols = [["planned", "Backlog"], ["in_progress", "In progress"], ["waiting", "Review"], ["done", "Done"]];
    const by = Object.fromEntries(cols.map(([s]) => [s, []]));
    cards.forEach((c) => (by[c.status] || (by[c.status] = [])).push(c));
    return `<div class="board">${cols.map(([s, label]) => `
      <div class="kcol">
        <div class="kcolhead">${label}<span class="cnt">${(by[s] || []).length}</span></div>
        ${(by[s] || []).map((c) => `
          <div class="kcard" style="--ac:${c.assignee ? colorFor(c.assignee) : "var(--border2)"}">
            <div class="kt">${esc(c.title)}</div>
            <div class="kmeta">${c.assignee ? `<span class="coin-s" style="background:${colorFor(c.assignee)}">${esc(initialOf(nm(c.assignee)))}</span><span class="who">${esc(nm(c.assignee))}</span>` : `<span class="who">unassigned</span>`}${c.project ? `<span class="who">· ${esc(c.project)}</span>` : ""}</div>
            <select onchange="moveCard('${esc(c.id)}', this)">${cols.map(([v, l]) => `<option value="${v}"${c.status === v ? " selected" : ""}>→ ${l}</option>`).join("")}</select>
          </div>`).join("")}
      </div>`).join("")}</div>`;
  },

  async schedules() {
    const s = SCHEDULES.length ? SCHEDULES : await api("/api/schedules");
    const byTime = (a, b) => cronSortKey(a.schedule) - cronSortKey(b.schedule);
    const en = s.filter((x) => x.enabled).sort(byTime);
    const dis = s.filter((x) => !x.enabled).sort(byTime);
    const row = (x, on) => {
      const c = colorFor(x.agent);
      return `<div class="sched" onclick="this.classList.toggle('open')" title="Tap to see the full prompt">
        <div class="coin" style="background:${c}">${esc(initialOf(nm(x.agent)))}</div>
        <div class="sb"><div class="sn">${esc(x.name)}</div><div class="sm">${esc(nm(x.agent))} · ${esc(cronHuman(x.schedule))}</div></div>
        <div class="next"><span class="ml">next run</span><span class="nv">${on ? esc(nextRunLabel(x.schedule)) : "—"}</span></div>
        ${on ? `<span class="onpill"><span class="dot"></span>on</span>` : `<span class="offpill">off</span>`}
        <div class="schedmore">
          <div class="smeta">
            <span>${esc(x.type || "task")}</span>
            <span>${esc(nm(x.agent))}</span>
            <span class="mono">${esc(x.schedule)}</span>
            <span>${on ? "enabled" : "disabled"}</span>
          </div>
          <pre class="sprompt">${esc(x.prompt || "(no prompt stored for this task)")}</pre>
        </div>
      </div>`;
    };
    return `<div class="sectlabel">Enabled — ${en.length}</div>${en.map((x) => row(x, true)).join("") || `<div class="empty">none</div>`}
      ${dis.length ? `<div class="sectlabel">Disabled — ${dis.length}</div>${dis.map((x) => row(x, false)).join("")}` : ""}`;
  },

  async queue() {
    const q = await api("/api/queue");
    const active = (q.recent || []).filter((x) => x.status === "queued" || x.status === "processing");
    if (!active.length) {
      return `<div class="emptybig"><div class="ring"><span class="d"></span></div><div class="h">Queue is clear</div><div class="m">No inbound work waiting — every message has been picked up.</div></div>`;
    }
    return `<div class="panelcard">${active.map((x) => `
      <div class="msgrow"><span class="coin-s" style="background:${colorFor(x.agent_id)}">${esc(initialOf(nm(x.agent_id)))}</span>
        <div class="mb"><div class="mh"><span class="from">${esc(nm(x.agent_id))}</span><span class="to">· ${esc(x.source)}</span><span class="ago">try ${x.attempts}</span></div>
        <div class="mt">${esc(x.preview)}</div></div></div>`).join("")}</div>`;
  },

  async messages() {
    const m = await api("/api/messages?limit=60");
    if (!m.length) return `<div class="empty">no messages on the bus yet</div>`;
    return `<div class="panelcard">${m.map((x) => `
      <div class="msgrow">
        <span class="coin-s" style="background:${colorFor(x.from_agent)}">${esc(initialOf(nm(x.from_agent)))}</span>
        <div class="mb">
          <div class="mh"><span class="from">${esc(nm(x.from_agent))}</span><span class="arrow">→</span><span class="to">${esc(nm(x.to_agent))}</span><span class="ago">${ago(x.created_at)}</span></div>
          <div class="mt">${esc(x.content)}</div>
          ${x.result ? `<div class="mr">${esc(x.result)}</div>` : ""}
        </div>
      </div>`).join("")}</div>`;
  },

  async usage() {
    const win = window._usageWin || "24h";
    const wins = [["1h", "1h"], ["24h", "24h"], ["3d", "3d"], ["7d", "7d"], ["restart", "since restart"], ["all", "all"]];
    const d = await api("/api/usage?window=" + win);
    const rows = (d.usage || []).slice().sort((a, b) => b.output - a.output);
    const maxOut = Math.max(1, ...rows.map((r) => r.tracked === false ? 0 : r.output));
    const byAgent = rows.map((r) => {
      const c = colorFor(r.id);
      const na = r.tracked === false;
      const w = na ? 0 : (r.output / maxOut * 100);
      return `<div class="abar"><div class="top"><span class="lab"><span class="sq" style="background:${c}"></span>${esc(nm(r.id))}</span><span class="val">${na ? "n/a" : fmtTokens(r.output)}</span></div>
        <div class="track"><div class="fill" style="width:${w}%;background:${c}"></div></div></div>`;
    }).join("");

    const rtTotals = {};
    rows.forEach((r) => { if (r.tracked === false) return; const a = AGENTS[r.id]; const rt = (a && a.runtime) || "claude"; rtTotals[rt] = (rtTotals[rt] || 0) + (r.output || 0); });
    const rtSum = Object.values(rtTotals).reduce((a, b) => a + b, 0) || 1;
    const rtColor = { claude: "#6ea8ff", gemini: "#f5b14c", codex: "#b69bff" };
    const byRuntime = RUNTIMES.map((rt) => {
      const v = rtTotals[rt.id] || 0; const pct = (v / rtSum * 100);
      return `<div class="abar"><div class="top"><span class="lab"><span class="sq" style="background:${rtColor[rt.id] || "#888"}"></span>${esc(rt.label)}</span><span class="val">${Math.round(pct)}%</span></div>
        <div class="track"><div class="fill" style="width:${pct}%;background:${rtColor[rt.id] || "#888"}"></div></div></div>`;
    }).join("");

    const codexN = AGENTLIST.filter((a) => (a.runtime === "codex") && a.running).length;
    const btns = `<div class="filterrow">${wins.map(([v, l]) => `<button class="chip${v === win ? " active" : ""}" onclick="setUsageWin('${v}')">${l}</button>`).join("")}</div>`;

    return btns + `<div class="ugrid">
      <div class="upanel"><h4>By agent · ${esc(win)}</h4>${byAgent || `<div class="empty">no usage</div>`}
        <div class="note">Output tokens — the headline figure. Non-Claude runtimes keep no transcript, shown as n/a.</div></div>
      <div style="display:grid;gap:14px">
        <div class="upanel"><h4>By runtime</h4>${byRuntime}</div>
        <div class="upanel"><h4>Codex concurrency</h4><div class="concur tnum">${codexN} <span class="sub">/ ${MAX_CODEX} slots</span></div>
          <div class="note">Capped at ${MAX_CODEX} agents due to OpenAI's 5-hour limit. The engine enforces this automatically.</div></div>
      </div>
    </div>`;
  },

  async logs() {
    const l = await api("/api/daily-logs?limit=60");
    if (!l.length) return `<div class="empty">no logs yet</div>`;
    const lines = l.slice().reverse().map((x) => {
      const time = x.created_at ? fmtClock(new Date(x.created_at * 1000)) : (x.date || "");
      const first = String(x.content || "").split("\n")[0].slice(0, 220);
      return `<div class="ln"><span class="lt">${esc(time)}</span> <span class="lv INFO">LOG</span> <span class="ls">${esc(x.agent_id)}</span> ${esc(first)}</div>`;
    }).join("");
    return `<div class="logterm">${lines}<div class="ln"><span class="cursor"></span></div></div>`;
  },

  async update() {
    const [d, host] = await Promise.all([api("/api/update/check").catch((e) => ({ error: e.message })), api("/api/host").catch(() => ({}))]);
    const ver = d.current ? "build " + d.current : "—";
    const upToDate = !d.error && !d.behind;
    const left = `<div class="upanel">
      <span class="ml">theoffice.service</span>
      <div class="ver">${esc(ver)}</div>
      <div style="margin-top:8px">${d.error ? `<span class="offpill">${esc(d.error)}</span>` : upToDate ? `<span class="pill-ok"><span style="width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block"></span>up to date</span>` : `<span class="onpill" style="background:var(--accentSoft);color:var(--accent)"><span class="dot" style="background:var(--accent)"></span>${d.behind} update${d.behind > 1 ? "s" : ""} available</span>`}</div>
      ${!upToDate && !d.error && d.commits ? `<div class="divider"></div><span class="ml">Recent changes</span><div class="changes">${d.commits.map((c, i) => `<div class="crow"><span class="ctag${i === 0 ? " cur" : ""}">${esc(c.hash)}</span><span class="cdesc">${esc(c.subject)}</span></div>`).join("")}</div>` : ""}
      <div class="btnrow">
        <button class="primary" onclick="showTab('update')">Check for updates</button>
        ${!upToDate && !d.error ? `<button class="ghost" id="do-update" onclick="doUpdate(this)">⟳ Update now</button>` : ""}
      </div>
    </div>`;

    const memPct = host.memTotalBytes ? Math.round(host.memUsedBytes / host.memTotalBytes * 100) : 0;
    const memGB = (b) => (b / 1e9).toFixed(1);
    const meterColor = (p) => p >= 85 ? "var(--danger)" : p >= 60 ? "var(--warn)" : "var(--ok)";
    const right = `<div class="upanel"><h4>Host</h4>
      <div class="kv"><span class="kvk">Uptime</span><span class="kvv">${fmtDur(host.uptimeSec)}</span></div>
      <div class="kv"><span class="kvk">CPU</span><span><span class="kvv">${host.cpuPct ?? 0}% · ${host.cores ?? "?"} vCPU</span><div class="meter"><div class="mf" style="width:${host.cpuPct || 0}%;background:${meterColor(host.cpuPct || 0)}"></div></div></span></div>
      <div class="kv"><span class="kvk">Memory</span><span><span class="kvv">${host.memTotalBytes ? `${memGB(host.memUsedBytes)} / ${memGB(host.memTotalBytes)} GB` : "—"}</span><div class="meter"><div class="mf" style="width:${memPct}%;background:${meterColor(memPct)}"></div></div></span></div>
      <div class="kv"><span class="kvk">Runtime</span><span class="kvv">${esc(host.runtime || "Node")}</span></div>
      <div class="kv"><span class="kvk">Endpoint</span><span class="kvv">:${host.port ?? 3430}</span></div>
    </div>`;
    return `<div class="updgrid">${left}${right}</div>`;
  },
};

// ---------------- actions ----------------
window.setPref = setPref;
window.showTab = showTab;
window.setMemTier = (v) => { window._memTier = v; showTab("memory"); };
window.setUsageWin = (w) => { window._usageWin = w; showTab("usage"); };

// A tune is persisted to agent.json even when it can't be injected into the live pane (agent busy,
// stopped, or the command was swallowed). Surface that instead of silently implying it took effect.
window.setModel = async (id, sel) => {
  sel.disabled = true;
  const r = await post(`/api/agents/${id}/model`, { model: sel.value });
  if (r && r.applied === false && r.note) alert(r.note);
  await softRefresh();
};
window.setEffort = async (id, sel) => {
  sel.disabled = true;
  const r = await post(`/api/agents/${id}/effort`, { effort: sel.value });
  if (r && r.applied === false && r.note) alert(r.note);
  await softRefresh();
};
window.setRuntime = async (id, sel) => {
  sel.disabled = true;
  const r = await post(`/api/agents/${id}/runtime`, { runtime: sel.value });
  if (r && r.warning) alert(r.warning);
  await softRefresh();
};
window.agentAction = async (id, action) => {
  if (action === "stop" && !confirm(`Stop ${nm(id)}?`)) return;
  if (action === "restart") {
    RESTARTING.add(id);
    if (CURRENT_TAB === "agents") await showTab("agents");
    await post(`/api/agents/${id}/restart`, {}).catch(() => {});
    setTimeout(async () => { RESTARTING.delete(id); delete RUN_SINCE[id]; await softRefresh(); }, 1700);
    return;
  }
  await post(`/api/agents/${id}/${action}`, {}).catch(() => {});
  setTimeout(softRefresh, 1200);
};
window.setEnabled = async (id, enabled) => {
  if (!enabled && !confirm(`Disable ${nm(id)}?`)) return;
  await post(`/api/agents/${id}/enabled`, { enabled });
  setTimeout(softRefresh, 800);
};
window.cleanReset = async (id) => {
  if (!confirm(`Handoff + Reset ${nm(id)}?\n\nWrites a handoff doc → restarts with fresh context → re-reads the handoff → Slack-summaries you. Takes a couple minutes.`)) return;
  const r = await post(`/api/agents/${id}/cleanreset`, {}).catch(() => null);
  alert(r && r.ok ? `Handoff + Reset started for ${nm(id)}. You'll get the Slack summary in a few minutes.` : `Could not start handoff + reset for ${nm(id)}.`);
  setTimeout(softRefresh, 1500);
};
// ---------------- Claude sign-in (no terminal needed) ----------------
// The fleet shares ONE Claude credential. When it expires every agent goes silent at once while the
// dashboard still shows them "running" — so this banner is driven by /api/auth/health, which actually
// inspects the credential AND the live panes, rather than by the process-liveness check.

// Set while the sign-in form is on screen. The 15s poll must NOT re-render over it — that would wipe
// the code the owner is part-way through pasting, and the PKCE challenge is bound to that one session.
let AUTH_UI_BUSY = false;

function renderAuthBanner() {
  const host = $("#auth-banner");
  if (!host) return;
  if (AUTH_UI_BUSY) return;
  if (!AUTH || AUTH.ok) { host.innerHTML = ""; host.style.display = "none"; return; }

  const warn = AUTH.status === "expiring-soon";
  // "credential is fine, panes are stale" is a one-tap restart — don't send the owner through a login.
  const restartOnly = AUTH.restartWouldFix === true;
  const bg = warn ? "#7c5e10" : "#7f1d1d";
  const bd = warn ? "#b8860b" : "#dc2626";
  const icon = warn ? "⏳" : "🔴";
  const action = restartOnly
    ? `<button onclick="authRestart(this)" style="background:#f59e0b;color:#111;border:0;border-radius:9px;padding:10px 14px;font-weight:800;font-size:13px;cursor:pointer">↻ Restart signed-out agents</button>`
    : `<button onclick="authSignIn()" style="background:#fff;color:#111;border:0;border-radius:9px;padding:10px 14px;font-weight:800;font-size:13px;cursor:pointer">🔑 Sign in to Claude</button>`;

  host.style.display = "block";
  host.innerHTML = `
    <div style="background:${bg};border:1px solid ${bd};border-radius:12px;padding:12px 14px;margin:0 0 12px;
                display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:#fff">
      <div style="font-size:20px;line-height:1">${icon}</div>
      <div style="flex:1;min-width:200px">
        <div style="font-weight:800;font-size:14px;margin-bottom:2px">
          ${warn ? "Claude login expiring" : restartOnly ? "Agents need a restart" : "Fleet cannot authenticate"}
        </div>
        <div style="font-size:12.5px;opacity:.92">${esc(AUTH.message || "")}</div>
      </div>
      ${action}
    </div>`;
}

/** Step 1: ask the engine to start `claude auth login` and show the link to open in a browser. */
window.authSignIn = async () => {
  const host = $("#auth-banner");
  AUTH_UI_BUSY = true;
  host.innerHTML = `<div style="background:#1f2937;border:1px solid #374151;border-radius:12px;padding:14px;margin:0 0 12px;color:#e5e7eb;font-size:13px">Starting sign-in… (a few seconds)</div>`;
  let r;
  try { r = await post("/api/auth/login/start", {}); }
  catch (e) { AUTH_UI_BUSY = false; alert("Could not start sign-in: " + e.message); return renderAuthBanner(); }
  if (!r || !r.ok || !r.url) { AUTH_UI_BUSY = false; alert("Could not start sign-in: " + ((r && r.error) || "unknown error")); return renderAuthBanner(); }

  host.innerHTML = `
    <div style="background:#12233a;border:1px solid #1d4ed8;border-radius:12px;padding:14px;margin:0 0 12px;color:#e5e7eb">
      <div style="font-weight:800;font-size:14px;margin-bottom:8px">🔑 Sign in to Claude — 2 steps</div>
      <div style="font-size:13px;margin-bottom:6px"><b>1.</b> Open this link and approve:</div>
      <a href="${esc(r.url)}" target="_blank" rel="noopener"
         style="display:block;background:#2563eb;color:#fff;text-align:center;text-decoration:none;
                border-radius:9px;padding:12px;font-weight:800;font-size:14px;margin-bottom:6px">Open sign-in page ↗</a>
      <button onclick="authCopyUrl(this)" data-url="${esc(r.url)}"
              style="width:100%;background:transparent;color:#93c5fd;border:1px solid #1d4ed8;border-radius:9px;
                     padding:8px;font-size:12px;cursor:pointer;margin-bottom:12px">Copy link instead</button>
      <div style="font-size:13px;margin-bottom:6px"><b>2.</b> Paste the code it gives you:</div>
      <input id="auth-code" type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false"
             placeholder="paste code here"
             style="width:100%;box-sizing:border-box;background:#0b1220;color:#e5e7eb;border:1px solid #334155;
                    border-radius:9px;padding:12px;font-size:15px;margin-bottom:8px" />
      <div style="display:flex;gap:8px">
        <button onclick="authSubmitCode(this)"
                style="flex:1;background:#10b981;color:#04231a;border:0;border-radius:9px;padding:12px;
                       font-weight:800;font-size:14px;cursor:pointer">Finish sign-in</button>
        <button onclick="authCancel()"
                style="flex:0 0 auto;background:transparent;color:#94a3b8;border:1px solid #334155;
                       border-radius:9px;padding:12px 14px;font-size:13px;cursor:pointer">Cancel</button>
      </div>
      <div id="auth-msg" style="font-size:12.5px;color:#fca5a5;margin-top:8px"></div>
    </div>`;
  const el = $("#auth-code");
  if (el) { el.focus(); el.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#auth-msg").parentElement.querySelector("button[onclick^='authSubmitCode']").click(); }); }
};

window.authCopyUrl = async (btn) => {
  const url = btn.dataset.url || "";
  try { await navigator.clipboard.writeText(url); btn.textContent = "Copied ✓"; }
  catch { prompt("Copy this link:", url); }
};

/** Step 2: hand the pasted code to the waiting CLI, then restart every agent onto the new credential. */
window.authSubmitCode = async (btn) => {
  const input = $("#auth-code");
  const msg = $("#auth-msg");
  const code = (input && input.value || "").trim();
  if (!code) { msg.textContent = "Paste the code first."; return; }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Signing in…";
  msg.style.color = "#93c5fd"; msg.textContent = "Verifying the code and restarting agents…";
  try {
    const r = await post("/api/auth/login/code", { code });
    if (r && r.ok) {
      const n = (r.restarted || []).length;
      AUTH_UI_BUSY = false;
      $("#auth-banner").innerHTML = `
        <div style="background:#064e3b;border:1px solid #10b981;border-radius:12px;padding:14px;margin:0 0 12px;color:#d1fae5">
          <div style="font-weight:800;font-size:14px">✅ Signed in — fleet is back</div>
          <div style="font-size:12.5px;margin-top:4px">Restarted ${n} agent${n === 1 ? "" : "s"} onto the new login. Give them a few seconds, then message them as normal.</div>
        </div>`;
      setTimeout(softRefresh, 4000);
      return;
    }
    msg.style.color = "#fca5a5";
    msg.textContent = (r && r.error) || "Sign-in failed. Start again to get a fresh link.";
  } catch (e) {
    msg.style.color = "#fca5a5";
    msg.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
};

window.authCancel = async () => {
  try { await post("/api/auth/login/cancel", {}); } catch { /* best effort */ }
  AUTH_UI_BUSY = false;
  renderAuthBanner();
};

/** Credential is valid, panes are stale — the case a plain restart genuinely fixes. */
window.authRestart = async (btn) => {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Restarting…";
  try {
    const r = await post("/api/auth/restart", {});
    alert(r && r.ok ? `Restarted ${(r.restarted || []).length} agent(s).` : "Restart failed.");
  } catch (e) {
    alert("Restart failed: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
    setTimeout(softRefresh, 3000);
  }
};

window.emergencyRestart = async (btn) => {
  if (!confirm("EMERGENCY RESTART\n\nThis will:\n• save the ENTIRE queue + all messages to a backup (nothing lost)\n• clear the queue\n• restart every agent\n• brief Michael to summarise it to you on Slack\n\nUse this when the fleet is going crazy / your messages aren't getting through. Proceed?")) return;
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
    setTimeout(softRefresh, 2000);
  }
};
window.moveCard = async (id, sel) => { await post(`/api/kanban/${encodeURIComponent(id)}/status`, { status: sel.value }); await showTab("kanban"); renderStrip(); renderTabs(); };
window.doUpdate = async (btn) => {
  if (!confirm("Update now? The dashboard rebuilds and briefly restarts — your agents keep running.")) return;
  btn.disabled = true; btn.textContent = "Updating… (~30s)";
  try {
    const r = await post("/api/update/apply", {});
    if (r.ok) { btn.textContent = "Updated ✓ — reloading…"; setTimeout(() => location.reload(), 8000); }
    else if (r.dirty) { btn.disabled = false; btn.textContent = "⟳ Update now"; alert("Update blocked — local changes to: " + (r.files || []).join(", ")); }
    else { btn.disabled = false; btn.textContent = "⟳ Update failed — retry"; alert("Update failed:\n\n" + (r.output || "").slice(-1200)); }
  } catch { btn.textContent = "restarting — reload in a moment"; setTimeout(() => location.reload(), 9000); }
};

// ---------------- cron helpers ----------------
function cronHuman(expr) {
  const p = (expr || "").trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, ho, dom, mon, dow] = p;
  let m;
  if (ho === "*" && mi === "*") return "every minute";
  if ((m = mi.match(/^\*\/(\d+)$/)) && ho === "*") return `every ${m[1]} min`;
  if ((m = ho.match(/^\*\/(\d+)$/))) return `every ${m[1]} h`;
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = dow === "*" ? "" : dow === "1-5" ? "weekdays" : (dow === "0,6" || dow === "6,0") ? "weekends" : dow.split(",").map((d) => dowNames[Number(d)] || d).join("/");
  if (/^\d+$/.test(mi) && /^[\d,]+$/.test(ho)) {
    const times = ho.split(",").map(Number).sort((a, b) => a - b).map((h) => `${pad2(h)}:${pad2(Number(mi))}`).join(" & ");
    if (days) return `${days} at ${times}`;
    return `daily at ${times}`;
  }
  return expr;
}
function cronSortKey(expr) {
  const p = (expr || "").split(/\s+/);
  if (p.length !== 5) return 99999;
  if (p[1] === "*") return -1;
  const h = Number(p[1].split(",")[0]), mi = /^\d+$/.test(p[0]) ? Number(p[0]) : 0;
  return isNaN(h) ? 99999 : h * 60 + mi;
}
function cronFieldMatch(val, field) {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    let m;
    if ((m = part.match(/^\*\/(\d+)$/))) { if (val % Number(m[1]) === 0) return true; }
    else if ((m = part.match(/^(\d+)-(\d+)$/))) { if (val >= Number(m[1]) && val <= Number(m[2])) return true; }
    else if (Number(part) === val) return true;
  }
  return false;
}
function nextCronDate(expr, from) {
  const p = (expr || "").trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = p;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (cronFieldMatch(d.getMinutes(), mi) && cronFieldMatch(d.getHours(), ho) &&
        cronFieldMatch(d.getDate(), dom) && cronFieldMatch(d.getMonth() + 1, mon) && cronFieldMatch(d.getDay(), dow)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
function nextRunLabel(expr) {
  const d = nextCronDate(expr, new Date());
  if (!d) return cronHuman(expr);
  const diff = Math.floor((d.getTime() - Date.now()) / 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} · in ${fmtDur(diff)}`;
}
function nextSchedule() {
  const en = SCHEDULES.filter((s) => s.enabled).map((s) => ({ s, d: nextCronDate(s.schedule, new Date()) })).filter((x) => x.d);
  if (!en.length) return "";
  en.sort((a, b) => a.d - b.d);
  const x = en[0];
  return `${x.s.name.split(" ").slice(0, 2).join(" ")} ${pad2(x.d.getHours())}:${pad2(x.d.getMinutes())}`;
}

// ---------------- live tick + polling ----------------
function tick() {
  const c = $("#clock"); if (c) c.textContent = fmtClock(new Date());
  document.querySelectorAll(".elapsed[data-id]").forEach((el) => {
    const id = el.dataset.id; if (RUN_SINCE[id]) el.textContent = fmtElapsed(Date.now() - RUN_SINCE[id]);
  });
}
async function softRefresh() {
  await refreshData();
  renderAuthBanner();
  renderStrip(); renderTabs();
  if (CURRENT_TAB === "agents") await showTab("agents");
}
async function poll() {
  try { await softRefresh(); } catch { /* transient */ }
}

// ---------------- connect / gate ----------------
function showGate(msg) {
  $("#app").classList.add("hidden");
  $("#gate").classList.remove("hidden");
  if (msg) $("#gate-err").textContent = msg;
}
async function connect() {
  try {
    await refreshData();
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderHeader(); renderAuthBanner(); renderStrip(); renderTabs();
    await showTab(CURRENT_TAB);
  } catch (e) {
    showGate(e.message);
  }
}

applyTheme();
$("#save").addEventListener("click", () => {
  TOKEN = $("#token").value.trim();
  localStorage.setItem("office_token", TOKEN);
  $("#gate-err").textContent = "";
  connect();
});
$("#token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#save").click(); });
setInterval(tick, 1000);
setInterval(poll, 15000);
if (TOKEN) { $("#token").value = TOKEN; connect(); } else { showGate(""); }
