#!/usr/bin/env python3
"""The exact log of one outage, written by code (never by the captain agent): every inbound to the captain, every outbound (verbatim), bus traffic, every tool command from its Codex
rollouts, the drafts among them, and OpenAI usage per hour. The primary agent reviews it on recovery and reports to the owner plus a fine-tune list."""
import datetime, json, os, sqlite3, sys, zoneinfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import cfg

DRAFT_MARKS = ("create_draft", "senddraft", "draft")   # generic markers; cfg key draft_marks (list) adds tenant-specific script names

def _tz(): return zoneinfo.ZoneInfo(cfg.get()["timezone"])
def logs_dir(): return os.path.join(cfg.STORE, "captain-logs")
def hm(ts): return datetime.datetime.fromtimestamp(ts, _tz()).strftime("%Y-%m-%d %H:%M:%S")
def log_path(start, logs=None): return os.path.join(logs or logs_dir(), datetime.datetime.fromtimestamp(start, _tz()).strftime("%Y-%m-%d_%H%M") + ".md")
def draft_marks(): return tuple(DRAFT_MARKS) + tuple(cfg.get().get("draft_marks") or ())
def _epoch(iso): return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
def rollout_events(start, end, sessions=None):
    out = []
    for dp, _, fn in os.walk(sessions or cfg.path("codex_sessions")):
        for f in fn:
            p = os.path.join(dp, f)
            if not (f.startswith("rollout-") and f.endswith(".jsonl")) or os.path.getmtime(p) < start: continue
            for line in open(p, errors="replace"):
                try: e = json.loads(line); ts = _epoch(e["timestamp"])
                except Exception: continue
                if start <= ts <= end: out.append((ts, e.get("type"), e.get("payload") or {}))
    return sorted(out, key=lambda x: x[0])
def build(start, end, db=None, sessions=None, switches=None):
    c0 = cfg.get(); cap, prim, capn = c0["captain_agent"], c0["primary_agent"], c0["captain_name"]
    c = sqlite3.connect(f"file:{db or os.path.join(cfg.STORE, 'theoffice.db')}?mode=ro", uri=True)
    q = lambda sql, *a: c.execute(sql, a).fetchall()
    inbound = q("select created_at, source, coalesce(reply_user,''), prompt from inbound_queue where agent_id=? and created_at between ? and ? order by id", cap, start, end)
    outbound = q("select created_at, channel, status, text from outbound_queue where agent_id=? and created_at between ? and ? order by id", cap, start, end)
    owner_lines = q("select created_at, channel, text from outbound_queue where agent_id=? and (text like ':rotating_light:%' or text like 'Claude is back%') and created_at between ? and ? order by id", prim, start, end)
    try: skipped = q("select created_at, agent_id, source, dedup_key, last_error from inbound_queue where last_error like 'skipped (captain%' and created_at between ? and ? order by id", start, end)
    except sqlite3.OperationalError: skipped = []
    bus = q("select created_at, from_agent, to_agent, content from agent_messages where (from_agent=? or to_agent=?) and created_at between ? and ? order by id", cap, cap, start, end)
    ev = rollout_events(start, end, sessions)
    cmds = [(ts, p.get("name", "?"), p.get("input", "")) for ts, t, p in ev if p.get("type") == "custom_tool_call"]
    marks = draft_marks(); drafts = [x for x in cmds if any(m in str(x[2]) for m in marks)]
    hours = {}
    for ts, t, p in ev:
        rl = p.get("rate_limits") if p.get("type") == "token_count" else None
        if rl: hours[int(ts // 3600)] = (ts, (rl.get("primary") or {}).get("used_percent"), (rl.get("secondary") or {}).get("used_percent"))
    L = [f"# Captain log {hm(start)} to {hm(end)} ({c0['timezone']})", "", f"Written by tools/captain/captain_log.py from the queue tables and {capn}'s Codex rollouts. Nothing here was written by {capn}.",
         f"Counts: {len(inbound)} inbound, {len(outbound)} outbound, {len(bus)} bus, {len(cmds)} tool commands, {len(drafts)} draft/send commands.", "", f"## Inbound to {capn}"]
    L += [f"- {hm(t)} [{s}{'/' + u if u else ''}] {p}" for t, s, u, p in inbound] or ["- none"]
    L += ["", f"## Outbound from {capn} (verbatim)"] + ([f"- {hm(t)} [{ch}, {st}] {tx}" for t, ch, st, tx in outbound] or ["- none"])
    L += ["", "## Owner lines sent by the captain code (switches, agent switches, hourly usage; the recovery line follows this log)"] + ([f"- {hm(t)} [{ch}] {tx}" for t, ch, tx in owner_lines] or ["- none"])
    def skip_line(t, a, src, k, why):
        what = f"task {k.split(':')[1]}" if src == "scheduler" and k and ":" in k else f"[{src}] {k}"
        return f"- {hm(t)} {a}: {what} ({(why or '').replace('skipped (captain', '').rstrip(')').lstrip(': ') or 'skipped'})"
    L += ["", f"## Rows skipped by the captain (scheduled tasks on the skip list, duplicates of a row {capn} already had; never given to {capn})"] + ([skip_line(*x) for x in skipped] or ["- none"])
    L += ["", f"## Bus ({capn} in and out)"] + ([f"- {hm(t)} {a} -> {b}: {x}" for t, a, b, x in bus] or ["- none"])
    L += ["", "## Runtime switches (agents moved to Codex by the captain)"] + ([f"- {hm(x['at'])} {x['agent']} to Codex because: {x['reason']}; back on Claude {hm(x['back_at']) if x.get('back_at') else 'NOT YET'}" for x in switches or []] or ["- none"])
    L += ["", "## Drafts and sends (from its tool commands)"] + ([f"- {hm(t)} {str(i)[:1500]}" for t, n, i in drafts] or ["- none"])
    L += ["", "## Every tool command"] + ([f"- {hm(t)} {n}: {str(i)[:1500]}" for t, n, i in cmds] or ["- none"])
    L += ["", "## OpenAI usage per hour (last reading in each hour)"] + ([f"- {hm(v[0])[:13]}h: 5h {v[1]:g}% used, weekly {v[2]:g}% used" for _, v in sorted(hours.items()) if v[1] is not None and v[2] is not None] or ["- no readings"])
    return "\n".join(L) + "\n"
def write_log(start, end, switches=None):
    os.makedirs(logs_dir(), mode=0o700, exist_ok=True); p = log_path(start)
    open(p, "w").write(build(start, end, switches=switches)); os.chmod(p, 0o600); return p
