import datetime, json, os, shutil, socket, sqlite3, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import cfg

def setup_cfg(**kw):
    cfg.set(dict({"primary_agent": "main", "captain_agent": "captain", "captain_name": "Captain", "timezone": "Asia/Tokyo"}, **kw))

class OutageLog(unittest.TestCase):
    def setUp(self): setup_cfg()
    def _env(self):
        d = tempfile.mkdtemp(); db = os.path.join(d, "t.db"); c = sqlite3.connect(db)
        c.execute("create table inbound_queue(id integer primary key, agent_id, source, prompt, reply_channel, reply_user, status, created_at)")
        c.execute("create table outbound_queue(id integer primary key, agent_id, channel, text, status, created_at)")
        c.execute("create table agent_messages(id integer primary key, from_agent, to_agent, content, status, created_at)")
        c.execute("insert into inbound_queue values(1,'captain','channel','owner asks about the calendar','D1','U1','delivered',1100)")
        c.execute("insert into inbound_queue values(2,'captain','channel','OLD message before the outage','D1','U1','delivered',500)")
        c.execute("insert into outbound_queue values(1,'captain','D1','Here is your calendar VERBATIM','sent',1110)")
        c.execute("insert into outbound_queue values(2,'main','D9',':rotating_light: Emergency captain (Captain): alpha now runs on Codex because test','sent',1115)")
        c.execute("insert into outbound_queue values(3,'main','D9','An ordinary message to the owner','sent',1116)")
        c.execute("insert into agent_messages values(1,'captain','main','bus out text','delivered',1120)")
        c.execute("insert into agent_messages values(2,'main','captain','bus in text','delivered',1090)")
        c.commit(); c.close()
        roll = os.path.join(d, "sessions", "2026", "11", "08"); os.makedirs(roll)
        iso = lambda ts: datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        ev = [{"timestamp": iso(1105), "type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "input": "text(await tools.exec_command({cmd:\"python3 mail_tool.py create_draft --to c --subject s\"}))"}},
              {"timestamp": iso(1106), "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {"primary": {"used_percent": 3.0}, "secondary": {"used_percent": 1.0}}}},
              {"timestamp": iso(1106 + 3700), "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {"primary": {"used_percent": 8.0}, "secondary": {"used_percent": 2.0}}}}]
        open(os.path.join(roll, "rollout-x.jsonl"), "w").write("\n".join(json.dumps(e) for e in ev) + "\n")
        return d, db, os.path.join(d, "sessions")
    def test_log_has_every_stream_verbatim_only_inside_the_window_and_hourly_usage(self):
        import captain_log as cl
        d, db, sess = self._env()
        md = cl.build(1000, 6000, db, sess)
        for need in ("owner asks about the calendar", "Here is your calendar VERBATIM", "bus out text", "bus in text", "create_draft --to c", "Drafts", "OpenAI usage per hour", "5h 3%", "5h 8%"): self.assertIn(need, md)
        self.assertNotIn("OLD message before the outage", md)
        self.assertIn("Owner lines sent by the captain code", md); self.assertIn("alpha now runs on Codex because test", md)
        self.assertNotIn("An ordinary message to the owner", md)             # only the captain code's own lines, not the primary agent's chat
    def test_agent_ids_come_from_config(self):
        import captain_log as cl
        d, db, sess = self._env(); setup_cfg(captain_agent="alpha", captain_name="Alpha")
        md = cl.build(1000, 6000, db, sess)
        self.assertNotIn("owner asks about the calendar", md); self.assertIn("Counts: 0 inbound, 0 outbound, 0 bus", md); self.assertIn("## Inbound to Alpha", md)
    def test_path_is_named_after_the_start_in_the_configured_timezone(self):
        import captain_log as cl
        self.assertTrue(cl.log_path(1762617600, "/x").endswith("/2025-11-09_0100.md"))     # 16:00 UTC = 01:00 next day in Tokyo
        setup_cfg(timezone="UTC"); self.assertTrue(cl.log_path(1762617600, "/x").endswith("/2025-11-08_1600.md"))
    def test_default_paths_use_the_store(self):
        import captain_log as cl
        self.assertEqual(cl.logs_dir(), os.path.join(cfg.STORE, "captain-logs"))
    def test_log_lists_switches_with_reason(self):
        import captain_log as cl
        d, db, sess = self._env()
        md = cl.build(1000, 6000, db, sess, switches=[{"agent": "beta", "reason": "queue backlog", "at": 1200, "back_at": 5000}])
        self.assertIn("Runtime switches", md); self.assertIn("beta", md); self.assertIn("queue backlog", md)
    def test_the_captain_log_lists_what_was_skipped(self):
        import captain_log as cl
        d, db, sess = self._env()
        c = sqlite3.connect(db); c.execute("ALTER TABLE inbound_queue ADD COLUMN dedup_key"); c.execute("ALTER TABLE inbound_queue ADD COLUMN last_error")
        c.execute("insert into inbound_queue(agent_id,source,prompt,status,created_at,dedup_key,last_error) values('main','scheduler','[Scheduled task: daily-report] run','failed',1200,'sched:daily-report:9','skipped (captain outage skip list)')"); c.commit(); c.close()
        md = cl.build(1000, 6000, db, sess)
        self.assertIn("Scheduled tasks skipped", md); self.assertIn("daily-report", md)
    def test_draft_marks_are_generic_plus_configured(self):
        import captain_log as cl
        d, db, sess = self._env()
        self.assertNotIn("mail_tool.py", cl.DRAFT_MARKS)
        setup_cfg(draft_marks=["zzz_tool.py"]); self.assertIn("zzz_tool.py", cl.draft_marks()); self.assertIn("senddraft", cl.draft_marks())
    def test_header_names_no_person(self):
        import captain_log as cl
        d, db, sess = self._env()
        self.assertIn("Written by tools/captain/captain_log.py", cl.build(1000, 6000, db, sess))

class SkillSync(unittest.TestCase):
    def setUp(self): setup_cfg(skill_routes=[["mcp__vendor_mail", None, "Mail: use the stored mail tool; drafts only."], ["mcp__vendor_pay", None, "Pay: reads only."]])
    def test_flags_only_claude_only_references_and_names_the_route(self):
        import skills_sync as ss
        self.assertEqual(ss.flags("Use the Skill tool, then mcp__vendor_pay__get_accounts"), ["Skill tool", "mcp__vendor_pay"])
        self.assertEqual(ss.flags("plain skill about static pages"), [])
        note = ss.note(["mcp__vendor_mail"])
        self.assertIn("Mail: use the stored mail tool", note); self.assertIn("tools/captain/skills_sync.py", note)
    def test_without_config_only_the_generic_routes_exist(self):
        import skills_sync as ss
        setup_cfg(); self.assertEqual(ss.flags("mcp__vendor_mail and subagent_type"), ["subagent_type"])
        self.assertEqual(len(ss.routes()), 4)
        setup_cfg(skill_routes=[["x+", None, "t"]]); self.assertEqual(len(ss.routes()), 5)
    def test_default_dashboard_route_follows_config(self):
        import skills_sync as ss
        setup_cfg(dashboard="http://dash.example:1"); self.assertIn("http://dash.example:1", ss.note(["ToolSearch"]))
    def test_sync_copies_adds_a_note_only_where_flagged_and_prunes(self):
        import skills_sync as ss
        src, dst = tempfile.mkdtemp(), tempfile.mkdtemp()
        for n, body in (("clean", "---\nname: clean\ndescription: d\n---\nhello"), ("dirty", "---\nname: dirty\ndescription: d\n---\nuse mcp__vendor_pay__get_accounts")):
            os.makedirs(f"{src}/{n}"); open(f"{src}/{n}/SKILL.md", "w").write(body)
        r = ss.sync(src, dst)
        self.assertEqual(open(f"{dst}/clean/SKILL.md").read(), open(f"{src}/clean/SKILL.md").read())      # unflagged: verbatim
        d = open(f"{dst}/dirty/SKILL.md").read(); self.assertTrue(d.startswith("---\nname: dirty")); self.assertIn("Codex note", d)
        self.assertEqual((r["copied"], r["flagged"]), (2, ["dirty"]))
        self.assertEqual(ss.sync(src, dst)["copied"], 0)                                                   # unchanged: nothing rewritten
        shutil.rmtree(f"{src}/clean"); self.assertEqual(ss.sync(src, dst)["removed"], ["clean"]); self.assertFalse(os.path.exists(f"{dst}/clean"))
    def test_src_and_dst_default_to_config(self):
        import skills_sync as ss
        src, dst = tempfile.mkdtemp(), os.path.join(tempfile.mkdtemp(), "out")
        os.makedirs(f"{src}/a"); open(f"{src}/a/SKILL.md", "w").write("---\nname: a\n---\nbody")
        setup_cfg(skills_src=src, skills_dst=dst); self.assertEqual(ss.sync()["copied"], 1); self.assertTrue(os.path.isfile(f"{dst}/a/SKILL.md"))
    def test_a_changed_configured_route_refreshes_every_note(self):
        import skills_sync as ss
        src, dst = tempfile.mkdtemp(), tempfile.mkdtemp()
        os.makedirs(f"{src}/dirty"); open(f"{src}/dirty/SKILL.md", "w").write("---\nname: dirty\n---\nuse mcp__vendor_pay__x")
        ss.sync(src, dst); self.assertEqual(ss.sync(src, dst)["copied"], 0)
        setup_cfg(skill_routes=[["mcp__vendor_pay", None, "Pay: NEW text."]])
        self.assertEqual(ss.sync(src, dst)["copied"], 1); self.assertIn("NEW text", open(f"{dst}/dirty/SKILL.md").read())

class OauthMcp(unittest.TestCase):
    def setUp(self): setup_cfg()
    def test_block_is_outage_only_url_servers_and_reversible(self):
        import mcp_package as mp
        base = '[projects."/tmp"]\ntrust_level = "trusted"\n'
        on = mp.merge_oauth(base, {"docs": "https://mcp.example.com/mcp"})
        self.assertIn('[mcp_servers.docs]\nurl = "https://mcp.example.com/mcp"', on); self.assertEqual(mp.merge_oauth(on, None), base)
        self.assertEqual(mp.merge_oauth(on, {"other": "https://mcp.example.org/mcp"}).count(mp.BEGIN), 1)
    def test_authorization_url_is_picked_out_of_the_login_output(self):
        import mcp_package as mp
        self.assertEqual(mp.find_auth_url("Open this URL:\nhttps://auth.example.com/authorize?x=1&y=2\nthen paste"), "https://auth.example.com/authorize?x=1&y=2")
        self.assertIsNone(mp.find_auth_url("no link here"))
    def test_callback_port_is_read_from_both_url_shapes(self):
        import mcp_package as mp
        self.assertEqual(mp.callback_port("https://a/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A45463%2Fcallback&x=1"), 45463)
        self.assertEqual(mp.callback_port("https://a/b?redirect_uri=http%3A%2F%2F127.0.0.1%3A33769%2Fcallback%2FSQXrPl152AjU"), 33769)
        self.assertIsNone(mp.callback_port("https://a/b"))
    def test_a_link_is_only_valid_while_its_login_process_listens(self):
        import mcp_package as mp
        s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1); port = s.getsockname()[1]
        url = f"https://a/b?redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fcallback"
        try: self.assertTrue(mp.link_alive(url))
        finally: s.close()
        self.assertFalse(mp.link_alive(url))                                   # the codex process is gone: the link is dead, say so, never hand it out
    def test_finish_on_a_dead_link_says_expired_instead_of_waiting(self):
        import mcp_package as mp
        d = tempfile.mkdtemp(); real = mp.WORK; mp.WORK = d
        try:
            open(f"{d}/docs.url", "w").write("https://a/b?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcallback")
            self.assertIn("expired", mp.finish("docs", "http://127.0.0.1:1/callback?code=x"))
        finally: mp.WORK = real
    def test_no_oauth_mcps_means_every_entry_point_is_a_noop(self):
        import mcp_package as mp
        d = tempfile.mkdtemp(); conf = os.path.join(d, "config.toml"); open(conf, "w").write("keep = 1\n")
        setup_cfg(codex_config=conf, codex_bin="/nonexistent/codex")
        self.assertEqual(mp.login_state(), {}); self.assertEqual(mp.start_all(), {})
        mp.set_config(True); self.assertEqual(open(conf).read(), "keep = 1\n")
    def test_servers_and_paths_come_from_config(self):
        import mcp_package as mp
        d = tempfile.mkdtemp(); conf = os.path.join(d, "config.toml"); open(conf, "w").write("keep = 1\n")
        setup_cfg(codex_config=conf, codex_bin="/x/bin/codex", oauth_mcps={"docs": "https://mcp.example.com/mcp"})
        self.assertEqual(mp.servers(), {"docs": "https://mcp.example.com/mcp"}); self.assertEqual(mp.codex(), "/x/bin/codex")
        mp.set_config(True); self.assertIn("[mcp_servers.docs]", open(conf).read())
        mp.set_config(False); self.assertEqual(open(conf).read(), "keep = 1\n")
    def test_login_state_reads_codex_list_and_restores_the_config(self):
        import mcp_package as mp
        d = tempfile.mkdtemp(); conf = os.path.join(d, "config.toml"); open(conf, "w").write("keep = 1\n")
        setup_cfg(codex_config=conf, oauth_mcps={"docs": "https://mcp.example.com/mcp", "other": "https://mcp.example.org/mcp"})
        class R: returncode = 0; stderr = ""; stdout = "Name  Url  Auth\ndocs  https://x  OAuth\nother  https://y  Not logged in\n"
        real = subprocess.run
        subprocess.run = lambda *a, **k: R()
        try: st = mp.login_state()
        finally: subprocess.run = real
        self.assertEqual(st, {"docs": True, "other": False}); self.assertEqual(open(conf).read(), "keep = 1\n")

class Selftest(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp(); self.d = d; self.out = os.path.join(d, "out.json")
        os.environ["CAPTAIN_SELFTEST_OUT"] = self.out; os.environ["CAPTAIN_NO_NOTIFY"] = "1"
    def tearDown(self): os.environ.pop("CAPTAIN_SELFTEST_OUT", None); os.environ.pop("CAPTAIN_NO_NOTIFY", None)
    def _run(self, **kw):
        import selftest; setup_cfg(**kw)
        rc = selftest.main(); return rc, json.load(open(self.out))
    def test_file_and_command_checks_pass_and_the_json_has_the_original_shape(self):
        f = os.path.join(self.d, "present.txt"); open(f, "w").write("x")
        rc, o = self._run(selftest_checks=[{"type": "file", "name": "a file", "paths": [f]}, {"type": "command", "name": "a cmd", "argv": ["true"]}],
                          gaps=[["Some tool", "no independent path"]])
        self.assertEqual(rc, 0); self.assertEqual(set(o), {"checked_at", "results", "failed", "gaps"})
        self.assertTrue(o["results"]["a file"]["ok"] and o["results"]["a cmd"]["ok"]); self.assertEqual((o["failed"], o["gaps"]), ([], ["Some tool"]))
    def test_a_missing_file_and_a_failing_command_are_reported_failed(self):
        rc, o = self._run(selftest_checks=[{"type": "file", "name": "gone", "paths": [os.path.join(self.d, "nope.txt")]}, {"type": "command", "name": "bad", "argv": ["false"]},
                                           {"type": "command", "name": "expect", "argv": ["echo", "hello"], "expect_in_stdout": "world"}])
        self.assertEqual(rc, 1); self.assertEqual(o["failed"], ["gone", "bad", "expect"]); self.assertIn("nope.txt", o["results"]["gone"]["detail"])
    def test_command_stdout_expectation(self):
        rc, o = self._run(selftest_checks=[{"type": "command", "name": "echo", "argv": ["echo", "hello world"], "expect_in_stdout": "world"}]); self.assertEqual(rc, 0)
    def test_an_unknown_check_type_is_a_failed_check_not_a_crash(self):
        rc, o = self._run(selftest_checks=[{"type": "bogus", "name": "weird"}])
        self.assertEqual(rc, 1); self.assertIn("weird", o["failed"]); self.assertIn("unknown check type", o["results"]["weird"]["detail"])
    def test_a_check_that_raises_is_a_fail(self):
        import selftest; setup_cfg()
        def boom(): raise RuntimeError("kaput")
        rc = selftest.main(checks=[("boom", boom)]); o = json.load(open(self.out))
        self.assertEqual(rc, 1); self.assertIn("RuntimeError: kaput", o["results"]["boom"]["detail"])
    def test_builtins_always_run_required_paths_and_units(self):
        rc, o = self._run(required_paths=[os.path.join(self.d, "missing-dir")])
        self.assertEqual(o["failed"], ["required paths"]); self.assertIn("missing-dir", o["results"]["required paths"]["detail"])
        self.assertTrue(o["results"]["systemd units"]["ok"])                          # none configured: nothing to be inactive
    def test_units_check_uses_systemctl_user_is_active(self):
        import selftest; setup_cfg(selftest_units=["a.service", "b.timer"]); calls = []
        class R: stdout = "active\n"
        def fake(argv, **k): calls.append(argv); r = R(); r.stdout = "inactive\n" if argv[-1] == "b.timer" else "active\n"; return r
        real = subprocess.run; subprocess.run = fake
        try: ok, d = selftest.check_units()
        finally: subprocess.run = real
        self.assertFalse(ok); self.assertIn("b.timer", d); self.assertEqual(calls[0], ["systemctl", "--user", "is-active", "a.service"])
    def test_a_failed_codex_login_is_a_fail_with_the_last_error_line(self):
        import selftest; setup_cfg()
        real = subprocess.run
        try:
            subprocess.run = lambda *a, **k: subprocess.CompletedProcess(a, 1, "", "warn\nERROR: not logged in")
            ok, d = selftest.check_codex()
        finally: subprocess.run = real
        self.assertFalse(ok); self.assertIn("not logged in", d)
    def test_codex_failure_notifies_the_infra_agent_without_naming_anyone(self):
        import selftest; os.environ.pop("CAPTAIN_NO_NOTIFY"); sent = []
        setup_cfg(selftest_checks=[{"type": "codex_ping", "name": "codex login"}], infra_agent="alpha")
        selftest.main(checks=[("codex login", lambda: (False, "x"))], notifier=sent.append)
        self.assertEqual(len(sent), 1); self.assertIn("codex login --device-auth", sent[0]); self.assertIn("Captain", sent[0])
        os.environ["CAPTAIN_NO_NOTIFY"] = "1"; sent.clear()
        selftest.main(checks=[("codex login", lambda: (False, "x"))], notifier=sent.append); self.assertEqual(sent, [])
    def test_other_failures_do_not_notify(self):
        import selftest; os.environ.pop("CAPTAIN_NO_NOTIFY"); sent = []; setup_cfg()
        selftest.main(checks=[("other", lambda: (False, "x"))], notifier=sent.append); self.assertEqual(sent, [])
    def test_mcp_logins_check_is_ok_with_nothing_configured(self):
        import selftest; setup_cfg(); ok, d = selftest.check_mcp_logins(); self.assertTrue(ok); self.assertIn("no oauth_mcps", d)
    def test_http_check_builds_headers_and_checks_the_key(self):
        import selftest; setup_cfg()
        tok = os.path.join(self.d, "tok"); open(tok, "w").write("secret\n"); seen = {}
        def fake_get(url, token=None, headers=None, timeout=20): seen.update(url=url, token=token, headers=headers); return {"agents": []}
        real = selftest.get; selftest.get = fake_get
        try:
            name, fn = selftest.make_check({"type": "http", "name": "h", "url": "http://x/y", "bearer_file": tok, "headers": {"X-A": "1"}, "expect_json_key": "agents"})
            self.assertEqual(fn(), (True, "ok")); self.assertEqual((seen["token"], seen["headers"]), ("secret", {"X-A": "1"}))
            self.assertFalse(selftest.make_check({"type": "http", "name": "h", "url": "http://x/y", "expect_json_key": "nope"})[1]()[0])
        finally: selftest.get = real
    def test_oauth_check_never_prints_the_token(self):
        import selftest, io, contextlib; setup_cfg()
        real_t, real_g = selftest.google_token, selftest.get
        selftest.google_token = lambda p: "TOPSECRET"; selftest.get = lambda url, token=None, **k: {"ok": token == "TOPSECRET"}
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = selftest.main(checks=[selftest.make_check({"type": "oauth_refresh_google", "name": "g", "creds_file": "/x", "probe_url": "http://p"})])
        finally: selftest.google_token, selftest.get = real_t, real_g
        self.assertEqual(rc, 0); self.assertNotIn("TOPSECRET", buf.getvalue()); self.assertNotIn("TOPSECRET", open(self.out).read())

if __name__ == "__main__": unittest.main()
