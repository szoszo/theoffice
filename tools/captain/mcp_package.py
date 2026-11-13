#!/usr/bin/env python3
"""Codex MCP package for the emergency captain. Remote connectors that live behind the Claude account are public servers, so the captain (Codex) can use them
after the owner signs in once per server: `codex mcp login <name> --no-browser` prints an authorization URL, the owner signs in, his browser lands on a localhost
URL that does not load, and he sends that URL back (`finish`). Entries are in the Codex config ONLY during an outage. The servers come from cfg oauth_mcps
({name: url}); with none configured every entry point is a no-op."""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import cfg

BEGIN = "# CAPTAIN-OAUTH-MCP:BEGIN (outage only, written by tools/captain/mcp_package.py)"; END = "# CAPTAIN-OAUTH-MCP:END"
WORK = None   # tests may point this at a temp dir; default is <store>/mcp-login
def codex(): return cfg.path("codex_bin")
def codex_env(): return dict(os.environ, PATH=os.path.dirname(codex()) + ":/usr/bin:/usr/local/bin:/bin")   # systemd units have no user PATH
def codex_config(): return cfg.path("codex_config")
def servers(): return dict(cfg.get().get("oauth_mcps") or {})
def work(): return WORK or os.path.join(cfg.STORE, "mcp-login")
def _none(): print("no oauth_mcps configured", file=sys.stderr)

def merge_oauth(text, servers):
    cleaned = re.sub(r"\n?" + re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", text, flags=re.S)
    if not servers: return cleaned
    body = "".join(f'[mcp_servers.{n}]\nurl = "{u}"\n\n' for n, u in servers.items())
    return cleaned.rstrip("\n") + "\n\n" + BEGIN + "\n" + body.rstrip("\n") + "\n" + END + "\n"
def find_auth_url(out):
    m = re.search(r"https://\S+", out or ""); return m.group(0).rstrip(".,)") if m else None
def set_config(on):
    sv = servers()
    if on and not sv: return
    cur = open(codex_config()).read(); new = merge_oauth(cur, sv if on else None)
    if new != cur: open(codex_config(), "w").write(new)

WINDOW = 290   # codex waits ~5 minutes (measured 2026-11-08) for the callback, then its login process exits for good
def callback_port(url):
    m = re.search(r"redirect_uri=http%3A%2F%2F(?:127\.0\.0\.1|localhost)%3A(\d+)", url or ""); return int(m.group(1)) if m else None
def link_alive(url):
    """A link is only good while the codex process that issued it still listens on its callback port."""
    import socket
    port = callback_port(url)
    if not port: return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2): return True
    except OSError: return False
def login_state():
    """{name: logged_in} from `codex mcp list` (entries are added for the read and removed again unless an outage is on)."""
    sv = servers()
    if not sv: _none(); return {}
    was = "CAPTAIN-OAUTH-MCP:BEGIN" in open(codex_config()).read()
    if not was: set_config(True)
    try:
        out = subprocess.run([codex(), "mcp", "list"], capture_output=True, text=True, timeout=30, env=codex_env()).stdout
    finally:
        if not was: set_config(False)
    st = {}
    for line in out.splitlines()[1:]:
        cols = re.split(r"\s{2,}", line.strip())
        if cols and cols[0] in sv: st[cols[0]] = bool(cols[-1]) and "not logged in" not in cols[-1].lower() and cols[-1].lower() != "unsupported"
    return st
def serve(name):
    """Background worker (one systemd unit per server): runs codex login, publishes the URL, waits for the pasted callback URL, feeds it to codex."""
    os.makedirs(work(), mode=0o700, exist_ok=True); base = f"{work()}/{name}"
    for ext in ("url", "callback", "result"):
        try: os.remove(f"{base}.{ext}")
        except FileNotFoundError: pass
    p = subprocess.Popen([codex(), "mcp", "login", name, "--no-browser"], env=codex_env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    seen = ""; t0 = time.time()
    while time.time() - t0 < 60 and not os.path.exists(f"{base}.url"):
        line = p.stdout.readline()
        if not line: break
        seen += line; u = find_auth_url(seen)
        if u: open(f"{base}.url", "w").write(u); break
    if not os.path.exists(f"{base}.url"): open(f"{base}.result", "w").write("no authorization URL: " + seen[-200:]); p.kill(); return 1
    t0 = time.time()
    while time.time() - t0 < WINDOW and p.poll() is None and not os.path.exists(f"{base}.callback"): time.sleep(1)
    if not os.path.exists(f"{base}.callback"):
        p.kill(); open(f"{base}.result", "w").write("expired: nobody sent the callback URL inside codex's 5-minute window"); return 1
    try: p.stdin.write(open(f"{base}.callback").read().strip() + "\n"); p.stdin.flush()
    except Exception: pass
    try: out = p.communicate(timeout=120)[0]
    except subprocess.TimeoutExpired: p.kill(); out = "timeout"
    open(f"{base}.result", "w").write(("OK " if p.returncode == 0 else "FAIL ") + (seen + (out or ""))[-300:]); return p.returncode
def start_all(names=None):
    if not servers(): _none(); return {}
    set_config(True); urls = {}; names = names or list(servers())
    for n in names:
        subprocess.run(["systemctl", "--user", "stop", f"mcp-login-{n}"], capture_output=True)   # a dead or stale worker is replaced, never reused
        for ext in ("url", "callback", "result"):
            try: os.remove(f"{work()}/{n}.{ext}")
            except FileNotFoundError: pass
        subprocess.run(["systemd-run", "--user", f"--unit=mcp-login-{n}", "--collect", sys.executable, os.path.abspath(__file__), "serve", n], capture_output=True)
    t0 = time.time()
    while time.time() - t0 < 90 and len(urls) < lennames:
        for n in names:
            if n not in urls and os.path.exists(f"{work()}/{n}.url"): urls[n] = open(f"{work()}/{n}.url").read().strip()
        time.sleep(2)
    return urls
def finish(name, callback):
    os.makedirs(work(), mode=0o700, exist_ok=True)
    url = open(f"{work()}/{name}.url").read().strip() if os.path.exists(f"{work()}/{name}.url") else ""
    if not link_alive(url): return f"expired: the {name} login window (5 min) is over or was never started. Run `mcp_package.py start {name}` when the owner is ready, then finish within 5 minutes."
    open(f"{work()}/{name}.callback", "w").write(callback.strip())
    for _ in range(90):
        if os.path.exists(f"{work()}/{name}.result"): return open(f"{work()}/{name}.result").read()
        time.sleep(2)
    return "no result yet"
def main():
    c = sys.argv[1] if len(sys.argv) > 1 else ""
    if c == "serve": return serve(sys.argv[2])
    if c == "start": print(json.dumps(start_all(sys.argv[2:] or None), indent=1))
    elif c == "finish": print(finish(sys.argv[2], sys.argv[3]))
    elif c in ("on", "off"): set_config(c == "on")
    else: print("usage: mcp_package.py start [name..] | finish <name> <callback-url> | on | off")
if __name__ == "__main__": sys.exit(main() or 0)
