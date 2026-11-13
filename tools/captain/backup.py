#!/usr/bin/env python3
"""Backup Claude account tier for the emergency captain. When the main Claude account hits its usage limit, the primary agent (lean mode: only it by default) is restarted on a
BACKUP account instead of handing the whole fleet to the second runtime. The backup login is an existing login file on another host (read over ssh), copied into a separate
CLAUDE_CONFIG_DIR that only the switched agent sees through its own `.env`; the main account's credentials are never touched.
OAuth refresh rotates: while on backup the file is re-synced, and when OUR copy refreshed (later expiry) it is pushed back so neither side keeps a dead refresh token.
Nothing here prints or returns a token: callers get action words and (ok, detail) pairs only."""
import json, os, re, shutil, subprocess

ENV_BEGIN = "# CAPTAIN-BACKUP:BEGIN (written by tools/captain, removed when the main account is back)"; ENV_END = "# CAPTAIN-BACKUP:END"
ACCOUNT_FILES = (".credentials.json", ".claude.json")   # never shared between the main and the backup config dir

def expires(raw):
    """expiresAt (ms) of a credentials file, None if unreadable. Never returns a token."""
    try: v = json.loads(raw)["claudeAiOauth"]["expiresAt"]
    except Exception: return None
    return v if isinstance(v, (int, float)) else None
def newer(a, b):
    """a has a later expiry than b (a was refreshed more recently); an unreadable a is never newer, an unreadable b is always older."""
    ea, eb = expires(a), expires(b)
    return ea is not None and (eb is None or ea > eb)
def _write(path, raw):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True); tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f: f.write(raw)
    os.replace(tmp, path)

class SshSource:
    """The backup login on another host: pull/push the credentials file, status = `claude auth status` as that user. `run` is injectable for tests."""
    def __init__(self, host, login, key, user, creds_path, run=subprocess.run, timeout=40, known_hosts=None):
        self.host, self.login, self.key, self.user, self.path, self.run, self.timeout, self.known_hosts = host, login, key, user, creds_path, run, timeout, known_hosts
    def _ssh(self, cmd, input=None):
        kh = ["-o", f"UserKnownHostsFile={self.known_hosts}"] if self.known_hosts else []   # the host key is PINNED (strict, no trust-on-first-use)
        argv = ["ssh", "-i", self.key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", *kh, f"{self.login}@{self.host}", cmd]
        return self.run(argv, input=input, capture_output=True, timeout=self.timeout)
    def pull(self):
        r = self._ssh(f"cat {self.path}")
        if r.returncode != 0: raise RuntimeError("pull failed")
        return r.stdout
    def push(self, raw):
        r = self._ssh(f"umask 077; cat > {self.path}.tmp && chown {self.user}: {self.path}.tmp && chmod 600 {self.path}.tmp && mv {self.path}.tmp {self.path}", input=raw)
        if r.returncode != 0: raise RuntimeError("push failed")
    def status(self):
        r = self._ssh(f"su - {self.user} -c 'claude auth status'")
        try: d = json.loads(r.stdout or b"{}")
        except Exception: d = {}
        ok = r.returncode == 0 and d.get("loggedIn") is True
        return ok, ("logged in, subscription " + str(d.get("subscriptionType")) if ok else "not logged in")

def sync(src, local):
    """One sync round. Returns an action word: pulled-new | same | pulled | pushed | remote-unreadable. A newer local file is pushed back; an unreadable remote never replaces a good local file."""
    remote = src.pull()
    if expires(remote) is None: return "remote-unreadable"
    try: ours = open(local, "rb").read()
    except FileNotFoundError: _write(local, remote); return "pulled-new"
    if ours == remote: return "same"
    if newer(ours, remote): src.push(ours); return "pushed"
    _write(local, remote); return "pulled"

def merge_env(text, config_dir):
    """The agent's .env with our block added/replaced (config_dir set) or removed (None). Every other line stays exactly as it was."""
    cleaned = re.sub(r"^" + re.escape(ENV_BEGIN) + r".*?^" + re.escape(ENV_END) + r"\n?", "", text, flags=re.S | re.M)
    if not config_dir: return cleaned
    return cleaned + ("" if not cleaned or cleaned.endswith("\n") else "\n") + ENV_BEGIN + "\nCLAUDE_CONFIG_DIR=" + config_dir + "\n" + ENV_END + "\n"
def set_agent_env(agent_dir, config_dir):
    p = os.path.join(agent_dir, ".env")
    try: cur = open(p).read()
    except FileNotFoundError: cur = ""
    new = merge_env(cur, config_dir)
    if new.strip():
        tmp = p + ".tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: f.write(new)
        os.replace(tmp, p)   # atomic: the engine never reads a half-written .env
    elif os.path.exists(p): os.remove(p)

def seed_config_dir(config_dir, main_dir, main_json):
    """Everything the agent needs except the account: each entry of the main config dir is symlinked in (skills, hooks, settings, plugins, and `projects`, so a session resumes),
    and the main global json is copied WITHOUT its oauthAccount (trust and onboarding state stay, the account comes from the backup login)."""
    os.makedirs(config_dir, mode=0o700, exist_ok=True)
    for n in os.listdir(main_dir):
        if n in ACCOUNT_FILES: continue
        dst = os.path.join(config_dir, n)
        if not os.path.lexists(dst): os.symlink(os.path.join(main_dir, n), dst)
    try: j = json.load(open(main_json))
    except Exception: j = {}
    j.pop("oauthAccount", None); _write(os.path.join(config_dir, ".claude.json"), json.dumps(j).encode())

def switch_on(src, config_dir, agent_dirs, main_dir, main_json):
    """Verify the backup login, pull it, seed the config dir, point the given agents at it. The caller restarts the agents."""
    ok, why = src.status()
    if not ok: raise RuntimeError("backup login not usable: " + why)
    try: os.remove(os.path.join(config_dir, PENDING))   # a pending cleanup from an earlier switch-back is void: this dir is live again
    except OSError: pass
    sync(src, os.path.join(config_dir, ".credentials.json")); seed_config_dir(config_dir, main_dir, main_json)
    for a in agent_dirs: set_agent_env(a, config_dir)
PENDING = ".cleanup-pending"
def switch_off(src, config_dir, agent_dirs):
    """Un-point the agents FIRST (they are back on the main account whatever happens), then sync a last time. 'clean' = the local copy is deleted; 'pending' = the push could not be confirmed (ssh down, remote unreadable), so the local login (possibly the only copy of a refreshed token) is KEPT with a marker and retry_cleanup finishes it later. The caller restarts the agents."""
    for a in agent_dirs: set_agent_env(a, None)
    try: act = sync(src, os.path.join(config_dir, ".credentials.json"))
    except Exception: act = None
    if act in ("same", "pushed", "pulled", "pulled-new"): shutil.rmtree(config_dir, ignore_errors=True); return "clean"
    try: open(os.path.join(config_dir, PENDING), "w").close()
    except OSError: pass
    return "pending"
def cleanup_pending(config_dir): return os.path.exists(os.path.join(config_dir, PENDING))
def _in_use(config_dir, agent_dirs):
    for a in agent_dirs or []:
        try:
            if "CLAUDE_CONFIG_DIR=" + config_dir in open(os.path.join(a, ".env")).read(): return True
        except OSError: pass
    return False
def retry_cleanup(src, config_dir, agent_dirs=()):
    """The timer job's retry: 'nothing pending' | 'cleaned' | 'pending' | 'in use' (an agent's .env points at the dir: never delete a live config dir)."""
    if not cleanup_pending(config_dir): return "nothing pending"
    if _in_use(config_dir, agent_dirs): return "in use"
    try: act = sync(src, os.path.join(config_dir, ".credentials.json"))
    except Exception: return "pending"
    if act in ("same", "pushed", "pulled", "pulled-new"): shutil.rmtree(config_dir, ignore_errors=True); return "cleaned"
    return "pending"

def dry_run(src, main_dir, main_json):
    """Weekly selftest: read the remote login file, check the remote login, and seed a THROWAWAY config dir from the main one. Switches nothing, pushes nothing, writes nothing outside a temp dir."""
    import tempfile
    try: raw = src.pull()
    except Exception as e: return False, "login file not readable: " + type(e).__name__
    if expires(raw) is None: return False, "login file has no usable expiry"
    ok, why = src.status()
    if not ok: return False, "remote login check failed: " + why
    tmp = tempfile.mkdtemp()
    try: seed_config_dir(os.path.join(tmp, "bk"), main_dir, main_json)
    except Exception as e: return False, "seed failed: " + type(e).__name__
    finally: shutil.rmtree(tmp, ignore_errors=True)
    return True, "login readable, " + why + ", seed ok"
