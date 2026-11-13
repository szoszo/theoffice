#!/usr/bin/env python3
"""captain-selftest: ONE harmless read per tool over Claude-independent paths (OAuth tokens, bot tokens, REST tokens, local files). Prints OK/FAIL/GAP per tool and writes store/captain-selftest.json.
A FAIL means the captain could not do that job in an outage today; a GAP is a tool with no Claude-independent path (the captain says it waits for the primary agent). Run in the outage drill and weekly.
Checks come from cfg selftest_checks (types: http, file, command, oauth_refresh_google, codex_ping, mcp_logins); an unknown type is a FAILED check, never a crash.
Built-ins always run: the systemd user units in cfg selftest_units and the paths in cfg required_paths."""
import json, os, subprocess, sys, tempfile, time, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import cfg

def check_backup():
    """Weekly dry run of the backup account path: read the remote login file, check the remote login, seed a throwaway config dir. Switches nothing."""
    import captain as c
    cc = c._backup_cfg()
    if not cc: return True, "backup tier not configured"
    b, src, _cd, _dirs, md, mj = c._backup_parts(cc); return b.dry_run(src, md, mj)
CODEX_FIX = "run `codex login --device-auth`, open the link, sign in to ChatGPT"
def out_path(): return os.environ.get("CAPTAIN_SELFTEST_OUT") or os.path.join(cfg.STORE, "captain-selftest.json")
def _p(x): return cfg.resolve(x)
def _codex_env(): return dict(os.environ, PATH=os.path.dirname(cfg.path("codex_bin")) + ":/usr/bin:/usr/local/bin:/bin")   # systemd units have no user PATH
def _last(r, dflt="failed"): return ((r.stderr or r.stdout or "").strip().splitlines() or [dflt])[-1][:80]
def get(url, token=None, headers=None, timeout=20):
    h = {"User-Agent": "captain-selftest", **(headers or {})}
    if token: h["Authorization"] = "Bearer " + token
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout))
def google_token(path):
    d = json.load(open(_p(path)))
    r = json.load(urllib.request.urlopen(urllib.request.Request(d["token_uri"], data=urllib.parse.urlencode({"client_id": d["client_id"], "client_secret": d["client_secret"], "refresh_token": d["refresh_token"], "grant_type": "refresh_token"}).encode()), timeout=20))
    return r["access_token"]
def check_codex():
    """A tiny real `codex exec` (read-only, ephemeral): proves the captain's OpenAI login works NOW, not just that a token file exists."""
    r = subprocess.run([cfg.path("codex_bin"), "exec", "--skip-git-repo-check", "-s", "read-only", "--ephemeral", "--color", "never", "-"], input="Reply with the single word: pong", capture_output=True, text=True, timeout=90, cwd=tempfile.gettempdir(), env=_codex_env())
    ok = r.returncode == 0 and "pong" in (r.stdout or "").lower()
    return ok, "codex answered" if ok else _last(r, "no output")
def check_mcp_logins():
    import mcp_package as mp
    sv = mp.servers()
    if not sv: return True, "no oauth_mcps configured"
    st = mp.login_state(); missing = [n for n in sv if not st.get(n)]
    return not missing, f"{len(sv) - len(missing)}/{len(sv)} signed in" + (f"; owner still has to sign in: {', '.join(missing)}" if missing else "")
def check_units():
    units = cfg.get()["selftest_units"]
    if not units: return True, "no units configured"
    bad = [u for u in units if subprocess.run(["systemctl", "--user", "is-active", u], capture_output=True, text=True).stdout.strip() != "active"]
    return not bad, "all active: " + ", ".join(units) if not bad else "not active: " + ", ".join(bad)
def check_required_paths():
    miss = [p for p in cfg.get()["required_paths"] if not os.path.exists(_p(p))]
    return not miss, "all required paths exist" if not miss else "missing: " + ", ".join(miss)
def make_check(spec):
    """One (name, callable) from a config dict. The callable returns (ok, detail) and may raise (main() turns a raise into a FAIL)."""
    t = spec.get("type"); name = spec.get("name") or str(t)
    def http():
        tok = open(_p(spec["bearer_file"])).read().strip() if spec.get("bearer_file") else None
        d = get(spec["url"], tok, spec.get("headers"))
        k = spec.get("expect_json_key")
        if k and not (isinstance(d, dict) and k in d): return False, f"response has no '{k}'"
        return True, "ok"
    def file():
        miss = [p for p in spec["paths"] if not os.path.exists(_p(p))]
        return not miss, "present" if not miss else "missing " + ", ".join(os.path.basename(m) for m in miss)
    def command():
        r = subprocess.run(spec["argv"], capture_output=True, text=True, timeout=spec.get("timeout", 60))
        want = spec.get("expect_in_stdout")
        ok = r.returncode == 0 and (want is None or want in (r.stdout or ""))
        return ok, "ok" if ok else (f"'{want}' not in output" if r.returncode == 0 else _last(r))
    def oauth():
        get(spec["probe_url"], google_token(spec["creds_file"])); return True, "token refresh + read ok"
    run = {"http": http, "file": file, "command": command, "oauth_refresh_google": oauth, "codex_ping": check_codex, "mcp_logins": check_mcp_logins}.get(t)
    if run is None: return name, lambda: (False, f"unknown check type {t!r}")
    return name, run
def build_checks():
    c = cfg.get()
    return [make_check(s) for s in c["selftest_checks"]] + [("systemd units", check_units), ("required paths", check_required_paths), ("backup account login (dry run)", check_backup)]
def notify(text):
    """Post to the infra agent on the bus. Failure is reported, never raised."""
    try:
        tok = open(os.path.join(cfg.STORE, ".dashboard-token")).read().strip(); c = cfg.get()
        urllib.request.urlopen(urllib.request.Request(c["dashboard"].rstrip("/") + "/api/messages", data=json.dumps({"from": c["captain_agent"], "to": c["infra_agent"], "content": text}).encode(), headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}), timeout=15)
    except Exception as e: print("notify failed:", e, file=sys.stderr)
def main(checks=None, notifier=None):
    c = cfg.get(); checks = build_checks() if checks is None else checks; res = {}
    codex_names = {s.get("name") or "codex_ping" for s in c["selftest_checks"] if s.get("type") == "codex_ping"}
    for name, fn in checks:
        try: ok, detail = fn()
        except Exception as e: ok, detail = False, f"{type(e).__name__}: {str(e)[:80]}"
        res[name] = {"ok": bool(ok), "detail": detail}; print(("OK   " if ok else "FAIL ") + f"{name}: {detail}")
    gaps = c["gaps"]
    for name, why in gaps: print(f"GAP  {name}: {why}")
    fails = [n for n, r in res.items() if not r["ok"]]
    out = {"checked_at": int(time.time()), "results": res, "failed": fails, "gaps": [g[0] for g in gaps]}
    o = out_path(); os.makedirs(os.path.dirname(o) or ".", exist_ok=True)
    json.dump(out, open(o + ".tmp", "w"), indent=1); os.replace(o + ".tmp", o)
    if any(n in codex_names for n in fails) and not os.environ.get("CAPTAIN_NO_NOTIFY"):
        (notifier or notify)(f"{c['captain_name']}'s Codex login FAILED (selftest). Owner step: " + CODEX_FIX)
    print(f"{len(res) - len(fails)}/{len(res)} OK, {len(gaps)} gaps"); return 1 if fails else 0
if __name__ == "__main__": sys.exit(main())
