import json, os, sys, tempfile, unittest, shutil, subprocess
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import backup as bk

def creds(exp, tag="x"): return json.dumps({"claudeAiOauth": {"accessToken": "AT-" + tag, "refreshToken": "RT-" + tag, "expiresAt": exp}}).encode()
class FakeSrc:
    def __init__(self, raw): self.raw, self.pushed, self.ok = raw, [], True
    def pull(self): return self.raw
    def push(self, raw): self.pushed.append(raw); self.raw = raw
    def status(self): return (self.ok, "loggedIn" if self.ok else "not logged in")

class Stamp(unittest.TestCase):
    def test_expiry_is_read_without_exposing_a_token(self):
        self.assertEqual(bk.expires(creds(1234)), 1234); self.assertIsNone(bk.expires(b"not json")); self.assertIsNone(bk.expires(json.dumps({"x": 1}).encode()))
    def test_newer_means_a_later_expiry_and_a_missing_one_is_never_newer(self):
        self.assertTrue(bk.newer(creds(200), creds(100))); self.assertFalse(bk.newer(creds(100), creds(200))); self.assertFalse(bk.newer(creds(100), creds(100)))
        self.assertFalse(bk.newer(b"junk", creds(100))); self.assertTrue(bk.newer(creds(100), b"junk"))

class Sync(unittest.TestCase):
    def setUp(self): self.d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.d, True); self.local = os.path.join(self.d, "cfg", ".credentials.json")
    def test_first_sync_pulls_the_remote_file_with_mode_0600(self):
        src = FakeSrc(creds(100)); self.assertEqual(bk.sync(src, self.local), "pulled-new"); self.assertEqual(open(self.local, "rb").read(), creds(100)); self.assertEqual(os.stat(self.local).st_mode & 0o777, 0o600)
    def test_unchanged_is_a_noop_and_a_newer_remote_overwrites_ours(self):
        src = FakeSrc(creds(100)); bk.sync(src, self.local); self.assertEqual(bk.sync(src, self.local), "same")
        src.raw = creds(300, "y"); self.assertEqual(bk.sync(src, self.local), "pulled"); self.assertEqual(open(self.local, "rb").read(), creds(300, "y"))
    def test_a_newer_local_file_is_pushed_back_so_neither_side_keeps_a_dead_refresh_token(self):
        src = FakeSrc(creds(100)); bk.sync(src, self.local); open(self.local, "wb").write(creds(500, "z"))        # our side refreshed
        self.assertEqual(bk.sync(src, self.local), "pushed"); self.assertEqual(src.pushed, [creds(500, "z")]); self.assertEqual(open(self.local, "rb").read(), creds(500, "z"))
    def test_an_unreadable_remote_never_replaces_a_good_local_file(self):
        src = FakeSrc(creds(100)); bk.sync(src, self.local); src.raw = b""
        self.assertEqual(bk.sync(src, self.local), "remote-unreadable"); self.assertEqual(open(self.local, "rb").read(), creds(100))
    def test_nothing_secret_is_in_the_returned_action(self):
        src = FakeSrc(creds(100, "SECRETVALUE")); a = bk.sync(src, self.local); self.assertNotIn("SECRETVALUE", a)

class EnvBlock(unittest.TestCase):
    def test_the_block_is_added_replaced_and_removed_without_touching_other_lines(self):
        txt = "FOO=1\nBAR=two\n"
        on = bk.merge_env(txt, "/cfg/dir"); self.assertIn("CLAUDE_CONFIG_DIR=/cfg/dir", on); self.assertIn("FOO=1", on); self.assertIn("BAR=two", on)
        again = bk.merge_env(on, "/other"); self.assertEqual(again.count("CLAUDE_CONFIG_DIR="), 1); self.assertIn("/other", again)
        self.assertEqual(bk.merge_env(again, None), txt)                                                         # removed: exactly the original
        self.assertEqual(bk.merge_env("", None), "")
    def test_set_agent_env_writes_and_removes_the_file_block(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        bk.set_agent_env(d, "/cfg"); self.assertIn("CLAUDE_CONFIG_DIR=/cfg", open(os.path.join(d, ".env")).read())
        bk.set_agent_env(d, None); self.assertFalse(os.path.exists(os.path.join(d, ".env")))                     # a file that held only our block goes away
        open(os.path.join(d, ".env"), "w").write("KEEP=1\n"); bk.set_agent_env(d, "/cfg"); bk.set_agent_env(d, None); self.assertEqual(open(os.path.join(d, ".env")).read(), "KEEP=1\n")

class Seed(unittest.TestCase):
    def test_the_backup_config_dir_shares_everything_except_the_two_account_files(self):
        main = tempfile.mkdtemp(); cfgd = os.path.join(tempfile.mkdtemp(), "bk"); self.addCleanup(shutil.rmtree, main, True)
        for n in ("skills", "projects", "plugins"): os.makedirs(os.path.join(main, n))
        open(os.path.join(main, "settings.json"), "w").write("{}"); open(os.path.join(main, ".credentials.json"), "w").write("MAINSECRET")
        mainjson = os.path.join(main, "claude.json"); open(mainjson, "w").write(json.dumps({"oauthAccount": {"emailAddress": "main@x"}, "projects": {"/a": {"hasTrustDialogAccepted": True}}, "numStartups": 9}))
        bk.seed_config_dir(cfgd, main, mainjson)
        for n in ("skills", "projects", "plugins", "settings.json"): self.assertTrue(os.path.islink(os.path.join(cfgd, n)), n)             # shared: sessions resume, hooks and skills work
        self.assertFalse(os.path.exists(os.path.join(cfgd, ".credentials.json")))                                                           # the main login is never copied
        j = json.load(open(os.path.join(cfgd, ".claude.json"))); self.assertNotIn("oauthAccount", j); self.assertTrue(j["projects"]["/a"]["hasTrustDialogAccepted"])
        bk.seed_config_dir(cfgd, main, mainjson)                                                                                              # idempotent

class Switch(unittest.TestCase):
    def test_on_pulls_creds_seeds_sets_the_env_and_off_pushes_back_and_deletes_the_copy(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        main = os.path.join(d, "main"); os.makedirs(os.path.join(main, "skills")); mj = os.path.join(d, "claude.json"); open(mj, "w").write("{}")
        agent = os.path.join(d, "agents", "alpha"); os.makedirs(agent); cfgd = os.path.join(d, "bk"); src = FakeSrc(creds(100))
        bk.switch_on(src, cfgd, [agent], main, mj)
        self.assertEqual(open(os.path.join(cfgd, ".credentials.json"), "rb").read(), creds(100)); self.assertIn("CLAUDE_CONFIG_DIR=" + cfgd, open(os.path.join(agent, ".env")).read())
        open(os.path.join(cfgd, ".credentials.json"), "wb").write(creds(900, "n"))                                                        # we refreshed while on backup
        bk.switch_off(src, cfgd, [agent]); self.assertEqual(src.pushed, [creds(900, "n")]); self.assertFalse(os.path.exists(cfgd)); self.assertFalse(os.path.exists(os.path.join(agent, ".env")))
    def test_on_refuses_when_the_source_login_is_not_good(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); src = FakeSrc(creds(100)); src.ok = False
        with self.assertRaises(RuntimeError): bk.switch_on(src, os.path.join(d, "bk"), [], d, os.path.join(d, "c.json"))

PENDING_NAME = bk.PENDING
class SwitchOffSafety(unittest.TestCase):
    """Toby 2026-11-13: a failed push at switch-back must never delete the only copy of a refreshed login."""
    def _on(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); main = os.path.join(d, "main"); os.makedirs(os.path.join(main, "skills")); mj = os.path.join(d, "c.json"); open(mj, "w").write("{}")
        agent = os.path.join(d, "a"); os.makedirs(agent); cfgd = os.path.join(d, "bk"); src = FakeSrc(creds(100)); bk.switch_on(src, cfgd, [agent], main, mj); return src, cfgd, agent
    def test_a_failed_push_keeps_the_local_login_for_a_retry_and_still_unpoints_the_agents(self):
        src, cfgd, agent = self._on(); open(os.path.join(cfgd, ".credentials.json"), "wb").write(creds(900, "n"))       # we refreshed
        def boom(raw): raise RuntimeError("ssh down")
        src.push = boom
        self.assertEqual(bk.switch_off(src, cfgd, [agent]), "pending")
        self.assertEqual(open(os.path.join(cfgd, ".credentials.json"), "rb").read(), creds(900, "n"))                        # the only copy of the new token survives
        self.assertFalse(os.path.exists(os.path.join(agent, ".env")))                                                         # the agent is back on the main account regardless
        self.assertTrue(bk.cleanup_pending(cfgd))
    def test_the_retry_pushes_then_deletes(self):
        src, cfgd, agent = self._on(); open(os.path.join(cfgd, ".credentials.json"), "wb").write(creds(900, "n")); good = src.push
        src.push = lambda raw: (_ for _ in ()).throw(RuntimeError("down")); bk.switch_off(src, cfgd, [agent]); src.push = good
        self.assertEqual(bk.retry_cleanup(src, cfgd, [agent]), "cleaned"); self.assertEqual(src.pushed, [creds(900, "n")]); self.assertFalse(os.path.exists(cfgd)); self.assertEqual(bk.retry_cleanup(src, cfgd, [agent]), "nothing pending")
    def test_a_switch_on_after_a_pending_off_clears_the_marker_and_the_retry_never_deletes_a_live_config_dir(self):
        """Toby 2026-11-13: switch_off pending (ssh down) -> ssh back -> switch_on -> the timer retry deleted the LIVE config dir under the running agent."""
        src, cfgd, agent = self._on(); open(os.path.join(cfgd, ".credentials.json"), "wb").write(creds(900, "n")); good = src.push
        src.push = lambda raw: (_ for _ in ()).throw(RuntimeError("down")); self.assertEqual(bk.switch_off(src, cfgd, [agent]), "pending"); src.push = good
        d = os.path.dirname(cfgd); main = os.path.join(d, "main"); mj = os.path.join(d, "c.json")
        bk.switch_on(src, cfgd, [agent], main, mj)                                                                               # on again (pushes our newer login, agent points at cfgd)
        self.assertFalse(bk.cleanup_pending(cfgd))
        self.assertEqual(bk.retry_cleanup(src, cfgd, [agent]), "nothing pending"); self.assertTrue(os.path.exists(os.path.join(cfgd, ".credentials.json")))
    def test_the_retry_refuses_while_an_agent_env_points_at_the_dir_even_if_the_marker_is_there(self):
        src, cfgd, agent = self._on(); open(os.path.join(cfgd, PENDING_NAME), "w").close()
        self.assertEqual(bk.retry_cleanup(src, cfgd, [agent]), "in use"); self.assertTrue(os.path.exists(cfgd))
    def test_a_clean_switch_off_returns_clean_and_leaves_nothing(self):
        src, cfgd, agent = self._on(); self.assertEqual(bk.switch_off(src, cfgd, [agent]), "clean"); self.assertFalse(os.path.exists(cfgd))
    def test_the_push_command_sets_umask_before_writing_and_the_host_key_is_pinned(self):
        calls = []
        def run(argv, input=None, **kw): calls.append(argv); return subprocess.CompletedProcess(argv, 0, stdout=b"{}", stderr=b"")
        s = bk.SshSource("h", "root", "/k", "u", "/p/c.json", run=run); s.push(b"x")
        self.assertIn("umask 077;", calls[0][-1]); self.assertIn("StrictHostKeyChecking=yes", calls[0]); self.assertNotIn("accept-new", " ".join(calls[0]))
    def test_the_env_file_is_replaced_atomically(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); real = os.replace; seen = []
        def spy(a, b): seen.append((os.path.basename(a), os.path.basename(b))); real(a, b)
        os.replace = spy
        try: bk.set_agent_env(d, "/cfg")
        finally: os.replace = real
        self.assertIn((".env.tmp", ".env"), seen)

class SshSourceCmds(unittest.TestCase):
    def test_pull_push_and_status_use_ssh_with_the_key_and_never_print_the_file(self):
        calls = []
        def run(argv, input=None, **kw):
            calls.append((argv, input)); return subprocess.CompletedProcess(argv, 0, stdout=creds(7) if "cat /home/u/.claude/.credentials.json" in argv[-1] and input is None else b'{"loggedIn": true}', stderr=b"")
        s = bk.SshSource(host="h", login="root", key="/k", user="u", creds_path="/home/u/.claude/.credentials.json", run=run)
        self.assertEqual(s.pull(), creds(7)); s.push(creds(8)); ok, detail = s.status()
        self.assertTrue(ok); self.assertTrue(all("-i" in a[0] and "/k" in a[0] and "BatchMode=yes" in a[0] for a in calls))
        self.assertEqual(calls[1][1], creds(8)); self.assertNotIn("AT-", detail)

class DryRun(unittest.TestCase):
    def test_the_weekly_dry_run_reads_and_checks_but_switches_nothing(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); main = os.path.join(d, "main"); os.makedirs(os.path.join(main, "skills")); mj = os.path.join(d, "c.json"); open(mj, "w").write("{}")
        src = FakeSrc(creds(100)); ok, detail = bk.dry_run(src, main, mj); self.assertTrue(ok); self.assertEqual(src.pushed, []); self.assertNotIn("AT-", detail)
        self.assertEqual(os.listdir(main), ["skills"])                                                                         # nothing written into the main dir
        src.ok = False; self.assertFalse(bk.dry_run(src, main, mj)[0]); src.ok = True; src.raw = b"junk"; self.assertFalse(bk.dry_run(src, main, mj)[0]); self.assertFalse(bk.dry_run(src, os.path.join(d, "nope"), mj)[0])

if __name__ == "__main__": unittest.main()
