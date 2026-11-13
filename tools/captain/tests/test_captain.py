import datetime, time, zoneinfo, subprocess, tempfile, json, os, shutil, sqlite3, sys, unittest
from unittest import mock
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, HERE)
import cfg, captain as cp

PRIMARY_MD = "# Main\n\n## MAIL: DRAFT ONLY, NEVER SEND (hard rule)\nNever send mail.\n\n## Other\nx\n\n## FLEET RULE 1 - no polling\nDo not poll.\n\n## OWNER FIRST\nAsk the owner first.\n"
FLEET_MD = "## Rule 3 - Owner-private intel\nStay private.\n\n### Rule 4 - write-capable connectors\nRead by default.\n"
COVER = "- ALPHA: use the alpha route at routes/alpha.\n- BETA: use the beta route.\n"
ITEM = "full morning briefing"

class Base(unittest.TestCase):
    """Every class that touches captain.py runs on a fake config (fake agents, fake rule files, temp paths); nothing reads the real tenant."""
    def setUp(self):
        self.root = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.root, True); self.addCleanup(cfg.reset)
        def w(name, text):
            with open(os.path.join(self.root, name), "w") as f: f.write(text)
            return os.path.join(self.root, name)
        self.pmd, self.fmd = w("primary.md", PRIMARY_MD), w("fleet-rules.md", FLEET_MD)
        self.cover, self.gapfile = w("cover.txt", COVER), w("gaps.txt", "- Docs tool needs the primary agent.\n")
        self.present = w("present.txt", "x"); self.missing = os.path.join(self.root, "absent.txt")
        self.task = w("task-config.json", json.dumps({"schedule": "45 7 * * *", "enabled": True}))
        self.cfgset()
        p = mock.patch.object(cp, "SELFTEST_JSON", os.path.join(self.root, "no-selftest.json")); p.start(); self.addCleanup(p.stop)
    def cfgset(self, **kw):
        base = dict(primary_agent="main", primary_name="Main", captain_agent="captain", captain_name="Captain", covered_agents=["alpha", "beta", "gamma"], skip_tasks=["nightly-report"],
                    gaps=[["Calendar tool", "connector only"], ["Docs tool", "connector only"], ["Chat tool", "connector only"], ["Legacy tool", "gone"]],
                    resolved_by={"Calendar tool": "calendar plugin", "Chat tool": "chat sign-ins"}, retired=["Legacy"], timezone="Europe/Budapest", owner_user="U0OWNER",
                    rule_heads=["MAIL: DRAFT ONLY", "FLEET RULE 1", "OWNER FIRST"], fleet_rule_heads=["Rule 3", "Rule 4"], primary_rules_file=self.pmd, fleet_rules_file=self.fmd,
                    fleet_cover_file=self.cover, gap_text_file=self.gapfile, required_paths=[self.present], max_switched=2, briefing_task=self.task, briefing_item=ITEM,
                    priority="your direct asks, today's calendar, urgent mail, " + ITEM)
        return cfg.set(dict(base, **kw))
    def blk(self): return cp.captain_section(open(self.pmd).read(), open(self.fmd).read())

class R:  # a fake subprocess result
    def __init__(self, rc=0, out="", err=""): self.returncode, self.stdout, self.stderr = rc, out, err

class Decide(Base):
    def test_two_bad_checks_in_a_row_start_an_outage_and_two_good_end_it(self):
        st = cp.new_state(); st, tr = cp.decide(st, True, "usage limit", 100); self.assertIsNone(tr); self.assertEqual(st["state"], "ok")
        st, tr = cp.decide(st, True, "usage limit", 400); self.assertEqual(tr, "outage"); self.assertEqual((st["state"], st["reason"], st["since"]), ("outage", "usage limit", 400))
        st, tr = cp.decide(st, True, "usage limit", 700); self.assertIsNone(tr)                    # still out: no second announcement
        st, tr = cp.decide(st, False, "", 1000); self.assertIsNone(tr); self.assertEqual(st["state"], "outage")
        st, tr = cp.decide(st, False, "", 1300); self.assertIsNone(tr); self.assertEqual(st["state"], "outage")        # two clear checks but inside the 30 minute dwell
        st, tr = cp.decide(st, False, "", 2300); self.assertEqual(tr, "recovered"); self.assertEqual(st["state"], "ok")
    def test_a_single_blip_changes_nothing(self):
        st = cp.new_state(); st, _ = cp.decide(st, True, "timeout", 1); st, tr = cp.decide(st, False, "", 2); st, tr2 = cp.decide(st, True, "timeout", 3)
        self.assertEqual((tr, tr2, st["state"]), (None, None, "ok"))

class Announcement(Base):
    def test_built_from_state_and_the_gap_list_and_names_the_rules(self):
        a = cp.announcement({"reason": "usage limit, 3am", "since": 1762618800, "reset": "3am"}, gaps=["Chat tool", "Docs tool"])
        for need in ("Emergency captain (Captain)", "because usage limit,", "Claude back expected 3am", "Waits for Main: Chat tool; Docs tool", "drafts only", "no orders/payments", "your direct asks"): self.assertIn(need, a)
        self.assertIn("unknown", cp.announcement({"reason": "x", "since": 1}, gaps=[]))        # no parsed reset time: says so, no invented time
        self.assertIn("nothing listed", cp.announcement({"reason": "x", "since": 1}, gaps=[]))
    def test_briefing_priority_is_time_aware(self):
        """After today's briefing time the item is only a check that it went out; before it, it names the time."""
        bud = zoneinfo.ZoneInfo("Europe/Budapest"); at = lambda h, m: datetime.datetime(2026, 11, 13, h, m, tzinfo=bud).timestamp()
        st = {"reason": "x", "since": 1}
        before = cp.announcement(st, gaps=[], now=at(7, 0), briefing_hm=(7, 45)); after = cp.announcement(st, gaps=[], now=at(11, 14), briefing_hm=(7, 45))
        self.assertIn(ITEM + " at 07:45", before)
        self.assertNotIn(ITEM, after); self.assertIn("did not go out", after)
        self.assertIn("your direct asks", after)                                                     # the rest of the list is untouched
        self.assertIn(ITEM, cp.announcement(st, gaps=[], now=at(11, 14), briefing_hm=None))   # unknown briefing time: keep the item as configured
        self.cfgset(briefing_item=None); self.assertIn(ITEM, cp.announcement(st, gaps=[], now=at(11, 14), briefing_hm=(7, 45)))   # no configured item: priority untouched
    def test_briefing_time_is_read_from_the_task_cron(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); p = os.path.join(d, "task-config.json")
        open(p, "w").write(json.dumps({"schedule": "15 8 * * *", "enabled": True})); self.assertEqual(cp.briefing_hm(p), (8, 15))
        open(p, "w").write(json.dumps({"schedule": "*/5 * * * *"})); self.assertIsNone(cp.briefing_hm(p))
        self.assertIsNone(cp.briefing_hm(os.path.join(d, "nope.json")))
        self.assertEqual(cp.briefing_hm(), (7, 45))                                                  # no argument: the configured briefing_task
        self.cfgset(briefing_task=None); self.assertIsNone(cp.briefing_hm())
    def test_time_is_the_configured_zone_whatever_the_process_timezone(self):
        self.assertIn("since 17:00,", cp.announcement({"reason": "x", "since": 1762617600}, gaps=[]))     # 16:00 UTC = 17:00 CET
        self.cfgset(timezone="UTC"); self.assertIn("since 16:00,", cp.announcement({"reason": "x", "since": 1762617600}, gaps=[]))
    def test_default_gaps_come_from_the_configured_list(self):
        a = cp.announcement({"reason": "x", "since": 1})
        for n, _ in cp.current_gaps(): self.assertIn(n, a)
        self.assertIn("Docs tool", a); self.assertNotIn("Legacy tool", a)
    def test_rules_block_tells_the_captain_to_post_the_announcement_file(self):
        blk = self.blk()
        self.assertIn("store/captain-announcement.txt", blk); self.assertIn(self.cfgset()["priority"], blk)

class Prefix(Base):
    P = ":rotating_light: Emergency captain (Captain):"
    def test_the_captain_in_an_outage_always_carries_the_prefix_once(self):
        self.assertEqual(cp.captain_prefix("captain", "hello", "outage"), self.P + " hello")
        self.assertEqual(cp.captain_prefix("captain", self.P + " hello", "outage"), self.P + " hello")          # idempotent
        self.assertEqual(cp.captain_prefix("captain", "  " + self.P + "hello", "outage"), self.P + " hello")             # odd spacing is normalised to the one canonical prefix
    def test_nobody_else_and_no_outage_is_untouched(self):
        self.assertEqual(cp.captain_prefix("captain", "hello", "ok"), "hello")
        self.assertEqual(cp.captain_prefix("main", "hello", "outage"), "hello")
        self.assertEqual(cp.captain_prefix("captain", "hello", None), "hello")                                   # unreadable state: fail open, send as is
    def test_the_prefix_uses_the_configured_captain_name(self):
        self.cfgset(captain_name="Skipper"); self.assertEqual(cp.captain_prefix("captain", "hi", "outage"), ":rotating_light: Emergency captain (Skipper): hi")

class Extras(Base):
    RL = {"rate_limits": {"primary": {"used_percent": 34.0, "window_minutes": 300, "resets_at": 1794172676}, "secondary": {"used_percent": 12.0, "window_minutes": 10080, "resets_at": 1794759476}}}
    def test_usage_line_reads_the_two_windows(self):
        l = cp.usage_line(self.RL["rate_limits"], now=1794160000)
        for need in ("Emergency captain (Captain)", "OpenAI: 5h window 34% used", "weekly 12% used"): self.assertIn(need, l)
    def test_usage_line_without_data_says_so(self):
        self.assertIn("no reading yet", cp.usage_line(None, now=1))
    def test_newest_reading_comes_from_the_latest_token_count_event(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); p = os.path.join(d, "rollout-1.jsonl")
        open(p, "w").write("\n".join(json.dumps(e) for e in ({"payload": {"type": "token_count", "rate_limits": {"primary": {"used_percent": 1}}}}, {"payload": {"type": "x"}}, {"payload": {"type": "token_count", "rate_limits": {"primary": {"used_percent": 9}}}})) + "\n")
        self.assertEqual(cp.latest_rate_limits(d)["primary"]["used_percent"], 9)
        e = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, e, True); self.assertIsNone(cp.latest_rate_limits(e))
    def _outage_run(self, ticks, usage=lambda: "U 5h 85%"):
        """Two bad ticks start the outage, then more bad ticks an hour apart; returns the owner lines that are usage lines."""
        base = datetime.datetime(2026, 11, 13, 11, 14, tzinfo=datetime.timezone(datetime.timedelta(hours=1))).timestamp()
        sent = []; path = os.path.join(tempfile.mkdtemp(), "outage.json")
        d = dict(state_path=path, force_path="/nonexistent", health=lambda: (True, ""), panes=lambda: (2, "3am"), status=lambda: (False, ""), dead=lambda x: False,
                 owner=lambda t: sent.append(t) or True, start=lambda: True, end=lambda: True)
        for i in range(ticks): cp.detect_once(dict(d, now=lambda i=i: base + 3700 * i, usage=usage))
        return [s for s in sent if s.startswith("U")]
    def test_one_usage_line_at_captain_activation_and_no_hourly_repeats(self):
        """The usage line may go out, but once at activation, never hourly."""
        self.assertEqual(self._outage_run(1), [])                                   # one bad tick is not an outage yet
        self.assertEqual(self._outage_run(2), ["U 5h 85%"])                         # the tick that starts the outage sends it
        self.assertEqual(self._outage_run(8), ["U 5h 85%"])                         # six more hourly ticks add nothing
    def test_a_failed_usage_read_does_not_break_activation(self):
        def boom(): raise RuntimeError("no rollout yet")
        self.assertEqual(self._outage_run(2, usage=boom), [])

class FleetCover(Base):
    def test_block_covers_every_agent_and_keeps_their_own_rules(self):
        blk = self.blk()
        for need in ("ALPHA", "alpha route", "BETA", "FLEET COVER", "EACH AGENT'S OWN HARD RULES APPLY", "No production writes", "max 2 agents", "never Main", "nightly-report"): self.assertIn(need, blk)
    def test_a_missing_route_path_is_reported_not_hidden(self):
        self.assertEqual(cp.missing_fleet_paths([self.missing, self.present]), [self.missing])
        self.assertEqual(cp.missing_fleet_paths(), [], "every configured route path must exist")
        self.assertNotIn("WARNING, these paths are missing", self.blk())
        self.cfgset(required_paths=[self.present, self.missing])
        self.assertEqual(cp.missing_fleet_paths(), [self.missing]); self.assertIn("WARNING, these paths are missing", self.blk()); self.assertIn(self.missing, self.blk())
    def test_no_cover_text_configured_still_builds(self):
        self.cfgset(fleet_cover_file=None, gap_text_file=None, skip_tasks=[]); blk = self.blk()
        self.assertIn("FLEET COVER", blk); self.assertNotIn("alpha route", blk); self.assertNotIn("OUTAGE SKIP LIST", blk)

class RuntimeSwitch(Base):
    def _agents(self, **runtimes):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        for a, rt in runtimes.items():
            os.makedirs(f"{d}/{a}"); open(f"{d}/{a}/agent.json", "w").write(json.dumps({"displayName": a} if rt is None else {"displayName": a, "runtime": rt}))
        return d
    def _rt(self, d, a): return json.load(open(f"{d}/{a}/agent.json")).get("runtime")
    def _out(self): st = cp.new_state(); st["state"] = "outage"; return st
    def test_guards(self):
        d = self._agents(alpha="claude", beta=None, gamma="claude", captain="codex", main="claude", delta="codex")
        ok = lambda a, st=None: cp.can_switch(a, st or self._out(), d)[0]
        self.assertTrue(ok("alpha"))
        self.assertFalse(ok("alpha", cp.new_state()), "only during an outage")
        self.assertFalse(ok("captain")); self.assertFalse(ok("main"), "the captain covers the primary agent, the primary agent is never switched")
        self.assertFalse(ok("delta"), "already on codex"); self.assertFalse(ok("ghost"), "unknown agent")
    def test_never_switch_list_is_honoured(self):
        d = self._agents(alpha="claude"); self.cfgset(never_switch=["alpha"])
        ok, why = cp.can_switch("alpha", self._out(), d); self.assertFalse(ok); self.assertIn("never switched", why)
    def test_max_two_agents_on_codex_and_no_double_switch(self):
        d = self._agents(alpha="claude", beta=None, gamma="claude")
        st = self._out(); st = cp.apply_switch(st, "alpha", "queue stuck", 100, d); st = cp.apply_switch(st, "beta", "briefing", 110, d)
        self.assertFalse(cp.can_switch("gamma", st, d)[0]); self.assertIn("2", cp.can_switch("gamma", st, d)[1])
        self.assertFalse(cp.can_switch("alpha", st, d)[0])
        self.cfgset(max_switched=3); self.assertTrue(cp.can_switch("gamma", st, d)[0])
    def test_switch_sets_runtime_and_logs_reason_and_revert_restores_exactly(self):
        d = self._agents(alpha="claude", beta=None)
        st = cp.apply_switch(self._out(), "alpha", "queue stuck", 100, d); st = cp.apply_switch(st, "beta", "briefing", 110, d)
        self.assertEqual((self._rt(d, "alpha"), self._rt(d, "beta")), ("codex", "codex"))
        self.assertEqual([(s["agent"], s["reason"]) for s in st["switches"]], [("alpha", "queue stuck"), ("beta", "briefing")])
        st, back = cp.revert_all(st, 200, d)
        self.assertEqual(sorted(back), ["alpha", "beta"]); self.assertEqual(self._rt(d, "alpha"), "claude")
        self.assertNotIn("runtime", json.load(open(f"{d}/beta/agent.json")))                         # had no runtime key before: key removed, not set to claude
        self.assertTrue(all(s.get("back_at") == 200 for s in st["switches"]))
        self.assertEqual(cp.revert_all(st, 300, d)[1], [])                                           # nothing left to revert
    def test_recovery_reverts_every_switched_agent_and_the_owner_line_names_them(self):
        d = self._agents(alpha="claude", beta=None); st = cp.apply_switch(self._out(), "alpha", "r", 50, d); st = cp.apply_switch(st, "beta", "r2", 60, d)
        st.update(since=1, bad_streak=0, good_streak=1); path = os.path.join(tempfile.mkdtemp(), "outage.json"); cp.save_state(st, path); told = []
        dd = dict(state_path=path, force_path="/nonexistent", now=lambda: 100000, health=lambda: (True, ""), panes=lambda: (0, ""), status=lambda: (False, ""), dead=lambda x: False,
                  owner=lambda t: told.append(t) or True, start=lambda: True, end=lambda: True, agents_dir=d)
        st2, tr = cp.detect_once(dd)
        self.assertEqual(tr, "recovered"); self.assertEqual(self._rt(d, "alpha"), "claude"); self.assertNotIn("runtime", json.load(open(f"{d}/beta/agent.json")))
        self.assertEqual(sorted(st2["to_restart"]), ["alpha", "beta"]); self.assertIn("Back on Claude: alpha, beta", " ".join(told)); self.assertIn("Main has the con again", " ".join(told))
    def test_unswitch_returns_one_agent_and_leaves_the_other(self):
        d = self._agents(alpha="claude", beta=None); st = cp.apply_switch(self._out(), "alpha", "r", 50, d); st = cp.apply_switch(st, "beta", "r2", 60, d)
        st, ok = cp.revert_one(st, "beta", 200, d)
        self.assertTrue(ok); self.assertNotIn("runtime", json.load(open(f"{d}/beta/agent.json"))); self.assertEqual(self._rt(d, "alpha"), "codex")
        self.assertEqual([x["agent"] for x in cp.active_switches(st)], ["alpha"]); self.assertTrue(cp.can_switch("beta", st, d)[0], "a returned agent may be switched again")
        self.assertFalse(cp.revert_one(st, "beta", 300, d)[1])
    def test_a_switch_outside_an_outage_is_refused(self):
        d = self._agents(alpha="claude")
        with self.assertRaises(ValueError) as cm: cp.apply_switch(cp.new_state(), "alpha", "r", 1, d)
        self.assertIn("only during an outage", str(cm.exception)); self.assertEqual(self._rt(d, "alpha"), "claude")
    def test_switch_agent_appends_the_agent_to_the_regeneration_command(self):
        d = self._agents(alpha="claude"); script = os.path.join(self.root, "regen.py"); out = os.path.join(self.root, "regen.out")
        open(script, "w").write(f"import sys\nopen({out!r}, 'w').write(' '.join(sys.argv[1:]))\n")
        sp = os.path.join(self.root, "outage.json"); cp.save_state(self._out(), sp); self.cfgset(gen_agents_md_cmd=[sys.executable, script, "regen"])
        posts, told = [], []
        with mock.patch.object(cp, "STATE", sp), mock.patch.object(cp, "AGENTS_DIR", d), mock.patch.object(cp, "_api", lambda m, p, b=None: posts.append((m, p))), mock.patch.object(cp, "_owner", told.append):
            cp.switch_agent("alpha", "queue stuck")
        self.assertEqual(open(out).read(), "regen alpha"); self.assertEqual(self._rt(d, "alpha"), "codex")
        self.assertEqual(posts, [("POST", "/api/agents/alpha/restart")]); self.assertEqual(len(told), 1); self.assertIn("alpha now runs on Codex because queue stuck", told[0]); self.assertIn("Emergency captain (Captain)", told[0])
        self.assertEqual(cp.active_switches(cp.load_state(sp))[0]["reason"], "queue stuck")

class StartStep(Base):
    def test_start_runs_to_the_end_and_tells_the_captain(self):
        """_start() once crashed with 'function object is not iterable' after a step was removed."""
        posts = []; d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True)
        fake = type(sys)("mcp_package"); fake.set_config = lambda on: None
        with mock.patch.object(cp, "_api", lambda m, path, body=None: posts.append((path, body))), mock.patch.object(cp, "gen_section", lambda *a, **k: 1), mock.patch.object(cp, "set_codex_mcp", lambda on: None), \
             mock.patch.object(cp, "STORE", d), mock.patch.object(cp, "load_state", lambda *a, **k: dict(cp.new_state(), state="outage", reason="forced drill", since=1)), mock.patch.dict(sys.modules, {"mcp_package": fake}):
            ok = cp._start()
        self.assertTrue(ok)
        self.assertTrue(any(b and b.get("to") == "captain" and "CAPTAIN MODE ON" in b.get("content", "") for _, b in posts))
        self.assertTrue(os.path.exists(f"{d}/captain-announcement.txt")); self.assertIn("Emergency captain (Captain)", open(f"{d}/captain-announcement.txt").read())

class StateLock(Base):
    def test_a_second_holder_waits_instead_of_overwriting(self):
        """The 5-minute detector load-modify-save once raced an unswitch and erased it."""
        p = os.path.join(self.root, "state.json")
        with cp.state_lock(p):
            with self.assertRaises(BlockingIOError):
                with cp.state_lock(p, blocking=False): pass
        with cp.state_lock(p, blocking=False): pass            # released again

class LiveGaps(Base):
    OK = lambda self, *names: {n: {"ok": True} for n in names}
    def test_connected_things_leave_the_list_and_retired_ones_never_appear(self):
        names = lambda res: [n for n, _ in cp.current_gaps(results=res)]
        none = names({})
        self.assertTrue(any(n.startswith("Calendar") for n in none)); self.assertTrue(any(n.startswith("Chat") for n in none)); self.assertFalse(any(n.startswith("Legacy") for n in none))
        live = names(self.OK("calendar plugin", "chat sign-ins"))
        self.assertFalse(any(n.startswith("Calendar") for n in live)); self.assertFalse(any(n.startswith("Chat") for n in live))
        self.assertTrue(any(n.startswith("Docs") for n in live), "permanent gaps stay")
        self.assertTrue(any(n.startswith("Calendar") for n in names({"calendar plugin": {"ok": False, "detail": "x"}})), "a failing proof keeps the gap")
        self.assertEqual([n for n in names({"calendar plugin": {"ok": False, "detail": "x"}}) if "failing" in n], [], "a mapped check is the gap itself, not listed twice")
    def test_a_check_that_fails_now_is_listed_as_a_gap(self):
        res = {"mail plugin": {"ok": False, "detail": "x"}, "gmail a": {"ok": True}}
        self.assertTrue(any("mail plugin" in n and "failing" in n for n, _ in cp.current_gaps(results=res)))
        self.assertFalse(any("gmail a" in n for n, _ in cp.current_gaps(results=res)))
    def test_announcement_uses_the_latest_results_not_constants(self):
        self.assertIn("Calendar tool", cp.announcement({"reason": "x", "since": 1}, gaps=None))
        p = os.path.join(self.root, "selftest.json"); open(p, "w").write(json.dumps({"results": {"calendar plugin": {"ok": True}}}))
        with mock.patch.object(cp, "SELFTEST_JSON", p): a = cp.announcement({"reason": "x", "since": 1}, gaps=None)
        self.assertNotIn("Calendar tool", a); self.assertIn("Docs tool", a)
    def test_gap_text_lists_the_tools_that_wait_for_the_primary_agent(self):
        block = cp.gap_text()
        for name, why in cp.current_gaps(): self.assertIn(name, block)
        self.assertIn("waits for Main", block); self.assertIn("Docs tool needs the primary agent", block)

class OutsideOutage(Base):
    P = ":rotating_light: Emergency captain (Captain):"
    def test_the_prefix_is_removed_outside_an_outage_in_every_hand_typed_form(self):
        for raw in (self.P + " hello", "Emergency captain (Captain): hello", "  " + self.P + "hello", ":rotating_light: Emergency captain (Captain) hello"):
            self.assertEqual(cp.captain_prefix("captain", raw, "ok"), "hello", raw)
        self.assertEqual(cp.captain_prefix("captain", "just a normal message", "ok"), "just a normal message")
        self.assertEqual(cp.captain_prefix("captain", self.P + " hello", None), self.P + " hello")                  # unreadable state: untouched
        self.assertEqual(cp.captain_prefix("main", self.P + " hello", "ok"), self.P + " hello")               # only the captain
        self.assertEqual(cp.captain_prefix("captain", "hello", "outage"), self.P + " hello")                         # unchanged during an outage

class QuotaSignal(Base):
    """The engine polls the provider's usage endpoint into store/quota-latest.json: a full window is a zero-token, screen-independent outage signal."""
    NOW = 1_800_000_000
    def snap(self, five=10, seven=10, age=60, r5=None, r7=None):
        return {"snapshot": {"source": "authoritative", "fetchedAtMs": (self.NOW - age) * 1000, "fiveHour": {"usedPercent": five, "resetsAtMs": (r5 or self.NOW + 3600) * 1000}, "sevenDay": {"usedPercent": seven, "resetsAtMs": (r7 or self.NOW + 86400) * 1000}}}
    def test_a_full_weekly_or_five_hour_window_is_an_outage_signal_with_its_reset_time(self):
        bad, why = cp.quota_signal(self.snap(seven=100), self.NOW); self.assertTrue(bad); self.assertIn("weekly", why)
        bad, why = cp.quota_signal(self.snap(five=100), self.NOW); self.assertTrue(bad); self.assertIn("5h", why)
        self.assertFalse(cp.quota_signal(self.snap(five=99, seven=98), self.NOW)[0])
    def test_stale_or_reset_or_missing_data_is_never_a_signal(self):
        self.assertFalse(cp.quota_signal(self.snap(seven=100, age=3600), self.NOW)[0])                       # a snapshot an hour old proves nothing
        self.assertFalse(cp.quota_signal(self.snap(seven=100, r7=self.NOW - 5), self.NOW)[0])                # the window has already reset
        self.assertFalse(cp.quota_signal(None, self.NOW)[0]); self.assertFalse(cp.quota_signal({"snapshot": None}, self.NOW)[0])
    def test_it_starts_an_outage_on_its_own_even_with_calm_panes_and_health(self):
        told = []; path = os.path.join(self.root, "outage.json")
        d = dict(state_path=path, force_path="/nonexistent", now=lambda: self.NOW, health=lambda: (True, ""), panes=lambda: (0, ""), status=lambda: (False, ""), dead=lambda x: False,
                 owner=lambda t: told.append(t) or True, start=lambda: True, end=lambda: True, quota=lambda: cp.quota_signal(self.snap(seven=100), self.NOW))
        st, tr = cp.detect_once(d); self.assertIsNone(tr)
        st, tr = cp.detect_once(dict(d, now=lambda: self.NOW + 300)); self.assertEqual(tr, "outage"); self.assertIn("weekly", st["reason"])

class DoublePrefix(Base):
    P = ":rotating_light: Emergency captain (Captain):"
    def test_a_hand_typed_prefix_without_the_siren_is_not_doubled_during_an_outage(self):
        """Owner lines once read ':rotating_light: Emergency captain (X): Emergency captain (X): ...' (the captain typed its own copy)."""
        for raw in ("Emergency captain (Captain): hello", "Emergency captain (Captain) hello", self.P + " Emergency captain (Captain): hello", "Emergency captain (Captain): Emergency captain (Captain): hello", "  :rotating_light: Emergency captain (Captain): hello"):
            self.assertEqual(cp.captain_prefix("captain", raw, "outage"), self.P + " hello", raw)
        self.assertEqual(cp.captain_prefix("captain", "plain text", "outage"), self.P + " plain text")
        self.assertEqual(cp.captain_prefix("main", "Emergency captain (Captain): hello", "outage"), "Emergency captain (Captain): hello")        # only the captain

class NoFleetCodeEdits(Base):
    def test_the_captain_is_told_never_to_edit_fleet_code_and_how_to_ask(self):
        """The captain once edited its own tool; the rule is in the hard rules block of every build."""
        blk = self.blk()
        for need in ("NEVER edit fleet code", "Ask the infra agent on the bus", "the captain files", "HARD RULES"): self.assertIn(need, blk)
        self.cfgset(hard_rules=["only this one"]); self.assertNotIn("NEVER edit fleet code", self.blk())     # the block is built from the configured list

class Guard(Base):
    def repo(self):
        d = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, d, True); g = lambda *a: subprocess.run(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", *a], capture_output=True, text=True, check=True)
        g("init", "-q"); os.makedirs(f"{d}/captain"); open(f"{d}/captain/a.py", "w").write("x=1\n"); open(f"{d}/other.txt", "w").write("o\n"); g("add", "."); g("commit", "-q", "-m", "c"); return d
    def test_clean_means_silence_and_pycache_never_counts(self):
        d = self.repo(); os.makedirs(f"{d}/captain/__pycache__"); open(f"{d}/captain/__pycache__/a.pyc", "w").write("b")
        self.assertEqual(cp.dirty_files(d, "captain"), [])
        open(f"{d}/other.txt", "w").write("changed outside captain\n"); self.assertEqual(cp.dirty_files(d, "captain"), [])      # only the captain folder is watched
    def test_a_modified_or_new_captain_file_is_reported(self):
        d = self.repo(); open(f"{d}/captain/a.py", "w").write("x=2\n"); open(f"{d}/captain/new.py", "w").write("y=1\n")
        got = cp.dirty_files(d, "captain"); self.assertTrue(any("a.py" in f for f in got) and any("new.py" in f for f in got))
    def test_it_alerts_once_per_distinct_change_and_never_when_clean(self):
        d = self.repo(); st = os.path.join(tempfile.mkdtemp(), "g.json"); sent = []
        self.assertFalse(cp.guard_once(d, "captain", st, sent.append)); self.assertEqual(sent, [])
        open(f"{d}/captain/a.py", "w").write("x=2\n")
        self.assertTrue(cp.guard_once(d, "captain", st, sent.append)); self.assertEqual(len(sent), 1); self.assertIn("a.py", sent[0])
        self.assertFalse(cp.guard_once(d, "captain", st, sent.append)); self.assertEqual(len(sent), 1)                           # same change tomorrow night: silent
        open(f"{d}/captain/a.py", "w").write("x=3\n"); self.assertTrue(cp.guard_once(d, "captain", st, sent.append)); self.assertEqual(len(sent), 2)   # a different change alerts again

class Signals(Base):
    MODAL_PANE = "  You've hit your usage limit. Your limit will reset at 3am.\n\n  1. Stop and wait for limit to reset\n  2. Upgrade your plan\n"
    def test_only_the_real_modal_counts_not_text_that_merely_mentions_it(self):
        self.assertTrue(cp.usage_modal(self.MODAL_PANE))
        self.assertTrue(cp.usage_modal("5-hour limit reached ∙ resets 6pm\n  1. Stop and wait for limit to reset\n  2. Switch to extra usage\n"))
        for t in ("Main: weekly usage is 87%, please keep turns short", "the usage limit alert fired earlier today", "the agent said usage limit reached, resets 6pm",
                  'MODAL = re.compile(r"hit your (?:usage|weekly) limit|usage limit reached")', "I read about 'hit your usage limit' in the docs"):
            self.assertFalse(cp.usage_modal(t), t)
        real = "  You've hit your session limit · resets 6:20am\n  What do you want to do?\n  ❯ 1. Stop and wait for limit to reset\n    2. Upgrade your plan\n  Enter to confirm · Esc to cancel\n"
        self.assertTrue(cp.usage_modal(real))
        self.assertTrue(cp.usage_modal("  What do you want to do?\n  ❯ 1. Stop and wait for limit to reset\n    2. Upgrade your plan\n"))   # menu labels alone are the signature
        self.assertFalse(cp.usage_modal("if you hit your usage limit choose stop and wait, or upgrade your plan"))                                   # one sentence naming both is not the menu
        self.assertFalse(cp.usage_modal(self.MODAL_PANE + "\n" + "\n".join(["…"] * 30) + "\n❯ \n"))               # an old modal scrolled above an idle composer
    def test_the_newer_auto_continue_limit_screen_counts_too(self):
        """The weekly limit once showed NO numbered menu (Claude Code auto-continues), so the strict detector missed it."""
        live = ("● Usage limit reached again · continuing automatically at 12am · esc to cancel\n  ⎿  You've hit your weekly limit · resets 12am (Europe/Budapest)\n\n"
                "  ⚠ Usage limit reached · limit resets 12am\n    Continuing shortly · esc to cancel\n")
        self.assertTrue(cp.usage_modal(live))
        self.assertTrue(cp.usage_modal("  ⎿  You've hit your session limit · resets 6:20am\n  ⚠ Usage limit reached · limit resets 6:20am\n    Continuing shortly · esc to cancel\n"))
        self.assertEqual(cp.reset_hint(live), "12am")
        for t in ("I read: You've hit your weekly limit · resets 12am (Europe/Budapest) in a log", "Usage limit reached · limit resets 12am", "the agent said 'Continuing shortly · esc to cancel' once",
                  "● Usage limit reset · Continuing automatically", 'LIMIT = r"Usage limit reached"  # esc to cancel continuing shortly'):
            self.assertFalse(cp.usage_modal(t), t)
        self.assertFalse(cp.usage_modal(live + "\n".join(["…"] * 30) + "\n❯ \n"))        # an old screen scrolled far above a working prompt
    def test_reset_time_is_parsed_from_the_modal(self):
        self.assertEqual(cp.reset_hint("5-hour limit reached ∙ resets 6pm"), "6pm"); self.assertEqual(cp.reset_hint("limit will reset at 3am"), "3am"); self.assertEqual(cp.reset_hint("nothing"), "")
    def test_statuspage_flags_only_claude_code_and_the_api_not_claude_ai_or_cowork(self):
        mk = lambda name, st: {"components": [{"name": name, "status": st}]}
        self.assertEqual(cp.status_bad(mk("Claude Code", "major_outage")), (True, "Anthropic status: Claude Code major outage"))
        self.assertEqual(cp.status_bad(mk("Claude API (api.anthropic.com)", "partial_outage"))[0], True)
        for name in ("claude.ai", "Claude Cowork", "Claude Console (platform.claude.com)", "Claude for Government", "console.anthropic.com"): self.assertEqual(cp.status_bad(mk(name, "major_outage")), (False, ""), name)
        self.assertEqual(cp.status_bad(mk("Claude Code", "degraded_performance")), (False, "")); self.assertEqual(cp.status_bad({}), (False, ""))
    def test_health_ignores_one_signed_out_agent_but_not_an_expired_credential_or_a_majority(self):
        ag = lambda *so: [{"id": str(i), "signedOut": x} for i, x in enumerate(so)]
        self.assertEqual(cp.health_verdict({"status": "degraded", "credential": {"expired": False}, "agents": ag(True, False, False, False)}), (True, ""))
        self.assertEqual(cp.health_verdict({"status": "x", "credential": {"expired": True}, "agents": []}), (False, "credential expired"))
        self.assertEqual(cp.health_verdict({"status": "x", "credential": {"expired": False, "refreshExpired": True}, "agents": []}), (False, "refresh token expired"))
        self.assertEqual(cp.health_verdict({"status": "x", "credential": {}, "agents": ag(True, True, True, False)}), (False, "most agents are signed out"))

class Detect(Base):
    def deps(self, tmp, health=(True, ""), panes=(0, ""), status=(False, ""), dead=False):
        self.sent, self.log = [], []
        return dict(state_path=os.path.join(tmp, "outage.json"), force_path=os.path.join(tmp, "captain-force"), now=lambda: self.t, health=lambda: health, panes=lambda: panes,
                    status=lambda: status, dead=lambda degraded: dead and degraded, owner=lambda text: self.sent.append(text), start=lambda: self.log.append("start"), end=lambda: self.log.append("end"))
    def test_simulated_outage_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 1000; d = self.deps(tmp, panes=(2, "resets 6pm"))
            cp.detect_once(d); self.assertEqual(self.sent, [])                                      # first bad check: nothing yet
            self.t += 300; cp.detect_once(d)
            self.assertEqual(len(self.sent), 1); self.assertIn("Claude is out (usage limit, resets 6pm)", self.sent[0]); self.assertIn("Captain is emergency captain", self.sent[0]); self.assertEqual(self.log, ["start"])
            self.assertEqual(json.load(open(d["state_path"]))["state"], "outage")
            self.t += 300; cp.detect_once(d); self.assertEqual(len(self.sent), 1)                  # exactly one line per switch
            d = self.deps(tmp); self.sent = []; self.log = []                                       # all clear again
            self.t += 300; cp.detect_once(d); self.t += 300; cp.detect_once(d); self.assertEqual(self.sent, [])   # clear twice, but the 30 minute dwell is not over: stay captain
            self.t += 1500; cp.detect_once(d)
            self.assertEqual(len(self.sent), 1); self.assertIn("Claude is back", self.sent[0]); self.assertIn("Main has the con again", self.sent[0]); self.assertEqual(self.log, ["end"]); self.assertEqual(json.load(open(d["state_path"]))["state"], "ok")
    def test_login_problem_counts_after_two_checks_but_the_status_page_alone_never_does(self):
        """A status-page 'partial outage' while the primary agent answers once ran a takeover for hours. Status alone is a hint, never a trigger."""
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp, health=(False, "credential expired")); cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.assertEqual(len(self.sent), 1); self.assertIn("credential expired", self.sent[0])
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp, status=(True, "Anthropic status: Claude Code major outage"))
            for _ in range(8): cp.detect_once(d); self.t += 300
            self.assertEqual(self.sent, [])                                                                  # the primary answers: no number of status-only checks starts an outage
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp, status=(True, "Anthropic status: Claude Code major outage"), dead=True)
            cp.detect_once(d); self.assertEqual(self.sent, []); self.t += 300; cp.detect_once(d)
            self.assertEqual(len(self.sent), 1); self.assertIn("Anthropic status", self.sent[0])             # status plus a silent primary is real: the normal two checks
    def test_one_pane_alone_needs_three_checks_two_panes_need_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp, panes=(1, "resets 6pm")); cp.detect_once(d); self.t += 300; cp.detect_once(d); self.assertEqual(self.sent, [])
            self.t += 300; cp.detect_once(d); self.assertEqual(len(self.sent), 1)
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp, panes=(2, "")); cp.detect_once(d); self.t += 300; cp.detect_once(d); self.assertEqual(len(self.sent), 1)
    def test_a_blip_is_not_an_outage(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; cp.detect_once(self.deps(tmp, panes=(1, ""))); self.t += 300; d = self.deps(tmp); cp.detect_once(d); self.t += 300; cp.detect_once(self.deps(tmp, panes=(1, "")))
            self.assertEqual(self.sent, [])
    def test_a_dead_primary_never_switches_by_itself_nor_skips_the_streak(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp, dead=True); cp.detect_once(d); self.assertEqual(self.sent, [])                               # nothing degraded: a slow primary is just slow
            d = self.deps(tmp, panes=(2, ""), dead=True); self.t += 300; cp.detect_once(d); self.assertEqual(self.sent, [])               # one bad check plus silence is still only one check
            self.t += 300; cp.detect_once(d); self.assertEqual(len(self.sent), 1)                                                         # the normal two-check rule
    def test_a_failed_owner_line_or_captain_start_is_retried_on_the_next_tick_not_lost(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp, panes=(2, "")); calls = {"owner": 0, "start": 0}
            def owner(text):
                calls["owner"] += 1
                if calls["owner"] == 1: return False                                                                                       # the owner channel is down at the switch
                self.sent.append(text); return True
            def start(): calls["start"] += 1; return calls["start"] > 1                                                                      # the captain start fails once too
            d["owner"], d["start"] = owner, start
            cp.detect_once(d); self.t += 300; cp.detect_once(d); self.assertEqual(self.sent, [])                                          # switch happened, both actions failed
            self.t += 300; cp.detect_once(d); self.assertEqual(len(self.sent), 1); self.assertEqual(calls["start"], 2)                    # retried, told exactly once
            self.t += 300; cp.detect_once(d); self.assertEqual(len(self.sent), 1)
    def test_force_file_drives_a_drill_and_no_claude_call_is_made(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 5; d = self.deps(tmp); cp.detect_once(d)
            open(d["force_path"], "w").write("outage"); self.t += 300; cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.assertEqual(len(self.sent), 1); self.assertIn("drill", self.sent[0].lower())

class BackupTier(Base):
    deps = Detect.deps
    """Owner 2026-11-13: when the MAIN Claude account hits its usage limit and a backup login is available, the primary agent moves to the backup account instead of the whole fleet going to the captain/Codex. Provider outages and both accounts exhausted still mean the captain."""
    def bdeps(self, tmp, avail=True, modal_agents=(), quota_ok=False, on_ok=True, verify=True, **kw):
        d = self.deps(tmp, **kw); self.calls = []
        d.update(backup_available=lambda: avail, backup_on=lambda: self.calls.append("on") or on_ok, backup_off=lambda: self.calls.append("off") or True, backup_sync=lambda: self.calls.append("sync"),
                 modal_agents=lambda: set(modal_agents), quota_ok=lambda: quota_ok, backup_agents=lambda: ["main"], backup_verify=lambda: verify); return d
    def state(self, tmp): return json.load(open(os.path.join(tmp, "outage.json")))
    def test_a_usage_limit_with_a_backup_available_switches_to_the_backup_not_to_pete(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 1000; d = self.bdeps(tmp, panes=(2, "resets 6pm")); cp.detect_once(d); self.assertEqual(self.sent, [])
            self.t += 300; cp.detect_once(d)
            self.assertEqual(self.calls, ["on"]); self.assertNotIn("start", self.log); self.assertEqual(self.state(tmp)["state"], "backup")
            self.assertEqual(len(self.sent), 1); self.assertIn("backup account", self.sent[0]); self.assertNotIn("Captain is emergency captain", self.sent[0])
            self.t += 300; cp.detect_once(d); self.assertEqual(len(self.sent), 1); self.assertEqual(self.calls, ["on"])               # one switch, one line
    def test_a_usage_limit_without_a_usable_backup_is_the_normal_pete_takeover(self):
        for kw in (dict(avail=False), dict()):
            with tempfile.TemporaryDirectory() as tmp:
                self.t = 1000; d = self.bdeps(tmp, panes=(2, ""), **kw)
                if not kw: [d.pop(k) for k in ("backup_available", "backup_on", "backup_off", "backup_sync", "modal_agents", "quota_ok", "backup_agents")]      # feature not configured at all
                cp.detect_once(d); self.t += 300; cp.detect_once(d)
                self.assertEqual(self.state(tmp)["state"], "outage"); self.assertIn("start", self.log); self.assertNotIn("on", getattr(self, "calls", []) if kw else [])
    def test_a_provider_or_login_problem_goes_straight_to_pete_even_with_a_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 1000; d = self.bdeps(tmp, health=(False, "credential expired")); cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.assertEqual(self.state(tmp)["state"], "outage"); self.assertEqual(self.calls, []); self.assertIn("start", self.log)
    def _in_backup(self, tmp, **kw):
        self.t = 1000; d = self.bdeps(tmp, panes=(2, ""), **kw); cp.detect_once(d); self.t += 300; cp.detect_once(d); self.assertEqual(self.state(tmp)["state"], "backup"); self.sent.clear(); return d
    def test_when_the_main_account_resets_twice_in_a_row_it_goes_back_to_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._in_backup(tmp); self.calls.clear()
            d = self.bdeps(tmp, quota_ok=True); self.t += 300; cp.detect_once(d); self.assertEqual(self.state(tmp)["state"], "backup")      # one clean reading is not a reset
            self.t += 300; cp.detect_once(d)
            self.assertEqual(self.state(tmp)["state"], "ok"); self.assertEqual(self.calls, ["off"]); self.assertEqual(len(self.sent), 1); self.assertIn("main account", self.sent[0])
    def test_a_reading_that_is_not_below_the_limit_never_counts_as_a_reset(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._in_backup(tmp); d = self.bdeps(tmp, quota_ok=False)
            for _ in range(5): self.t += 300; cp.detect_once(d)
            self.assertEqual(self.state(tmp)["state"], "backup"); self.assertNotIn("off", self.calls)
    def test_when_the_backup_pane_hits_the_limit_too_it_is_pete(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._in_backup(tmp); d = self.bdeps(tmp, panes=(2, ""), modal_agents=["main"])
            self.t += 300; cp.detect_once(d); self.assertEqual(self.state(tmp)["state"], "backup")                                       # one check is not enough
            self.t += 300; cp.detect_once(d); st = self.state(tmp)
            self.assertEqual(st["state"], "outage"); self.assertTrue(st["backup_exhausted"]); self.assertIn("start", self.log); self.assertIn("both", self.sent[-1])
    def test_a_modal_on_a_parked_agent_alone_is_not_the_backup_running_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._in_backup(tmp); d = self.bdeps(tmp, panes=(2, ""), modal_agents=["zeta"])                                              # lean mode: other agents are parked on the main account
            for _ in range(4): self.t += 300; cp.detect_once(d)
            self.assertEqual(self.state(tmp)["state"], "backup")
    def test_after_pete_took_over_a_main_reset_still_moves_the_backup_agents_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._in_backup(tmp); d = self.bdeps(tmp, panes=(2, ""), modal_agents=["main"]); self.t += 300; cp.detect_once(d); self.t += 300; cp.detect_once(d); self.calls.clear()
            d = self.bdeps(tmp, panes=(2, ""), modal_agents=["main"], quota_ok=True); self.t += 300; cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.assertEqual(self.calls, ["off"]); self.assertFalse(self.state(tmp)["backup"]["active"])
    def test_a_recovery_from_an_outage_that_began_on_backup_also_switches_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._in_backup(tmp); d = self.bdeps(tmp, panes=(2, ""), modal_agents=["main"]); self.t += 300; cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.t += 2000; self.calls.clear(); d = self.bdeps(tmp)                                                                      # everything clear, quota_ok False but no limit evidence
            cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.assertEqual(self.state(tmp)["state"], "ok"); self.assertEqual(self.calls, ["off"])
    def test_a_failed_switch_falls_to_pete_in_the_same_tick(self):
        """Owner 2026-11-13: no agent in the loop. If the backup switch itself fails (ssh down, file missing) the takeover starts in the SAME tick, not the next."""
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 1000; d = self.bdeps(tmp, panes=(2, ""), on_ok=False); cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.assertEqual(self.calls, ["on"]); st = self.state(tmp); self.assertEqual(st["state"], "outage"); self.assertIn("start", self.log); self.assertFalse((st.get("backup") or {}).get("active"))
            self.assertEqual(len(self.sent), 1); self.assertIn("Captain is emergency captain", self.sent[0])
    def test_an_agent_still_on_the_limit_screen_after_the_restart_is_switched_back_and_it_is_pete(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 1000; d = self.bdeps(tmp, panes=(2, ""), verify=False); cp.detect_once(d); self.t += 300; cp.detect_once(d)
            self.assertEqual(self.calls, ["on", "off"]); self.assertEqual(self.state(tmp)["state"], "outage"); self.assertIn("start", self.log); self.assertFalse((self.state(tmp).get("backup") or {}).get("active"))
    def test_the_force_drill_still_works_while_on_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._in_backup(tmp); open(os.path.join(tmp, "captain-force"), "w").write("outage"); d = self.bdeps(tmp); self.t += 2000; cp.detect_once(d); self.t += 300; cp.detect_once(d)   # past the 30 min dwell after the switch
            self.assertEqual(self.state(tmp)["state"], "outage"); self.assertIn("start", self.log)
    def test_a_pending_cleanup_is_retried_by_the_sync_timer_when_not_on_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 1000; d = self.bdeps(tmp); cp.detect_once(d); d["backup_cleanup"] = lambda: self.calls.append("cleanup") or "cleaned"
            self.assertEqual(cp.backup_sync_tick(d), "cleaned"); self.assertEqual(self.calls, ["cleanup"])
    def test_the_login_sync_is_its_own_timer_job_active_only_in_backup_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = self._in_backup(tmp); self.calls.clear()
            self.t += 1900; cp.detect_once(d); self.assertEqual(self.calls, [])                                                       # the detector tick never syncs
            self.assertEqual(cp.backup_sync_tick(d), "synced"); self.assertEqual(self.calls, ["sync"])
        with tempfile.TemporaryDirectory() as tmp:
            self.t = 1000; d = self.bdeps(tmp); cp.detect_once(d)                                                                      # state ok
            d.pop("backup_cleanup", None); self.assertEqual(cp.backup_sync_tick(d), "not on backup"); self.assertEqual(self.calls, [])

class BackupSelftest(Base):
    def test_the_selftest_has_a_backup_dry_run_that_passes_when_the_tier_is_not_configured(self):
        import selftest; names = [n for n, _ in selftest.build_checks()]; self.assertIn("backup account login (dry run)", names)
        self.assertEqual(selftest.check_backup(), (True, "backup tier not configured"))

class QuotaOk(Base):
    def test_only_fresh_data_below_the_limit_counts_as_a_reset(self):
        doc = lambda a, b, at: {"snapshot": {"fetchedAtMs": at * 1000, "sevenDay": {"usedPercent": a}, "fiveHour": {"usedPercent": b}}}
        self.assertTrue(cp.quota_ok_signal(doc(40, 10, 1000), 1100)); self.assertFalse(cp.quota_ok_signal(doc(100, 10, 1000), 1100)); self.assertFalse(cp.quota_ok_signal(doc(96, 10, 1000), 1100)); self.assertFalse(cp.quota_ok_signal(doc(40, 98, 1000), 1100))   # margin: 5h window just reset but the weekly is at 98% would flap; self.assertFalse(cp.quota_ok_signal(doc(40, 100, 1000), 1100))
        self.assertFalse(cp.quota_ok_signal(doc(40, 10, 1000), 1000 + cp.QUOTA_MAX_AGE + 5)); self.assertFalse(cp.quota_ok_signal({}, 1000)); self.assertFalse(cp.quota_ok_signal({"snapshot": {"fetchedAtMs": 1000000}}, 1000))

class ModalAgents(Base):
    def test_session_names_map_to_agent_ids(self):
        panes = {"agent-main": "x\n1. Stop and wait for limit to reset\n2. Upgrade your plan\nEnter to confirm", "agent-zeta": "all fine", "other-thing": "1. Stop and wait for limit to reset\n2. Upgrade your plan"}
        self.assertEqual(cp.modal_agents_from(panes), {"main"})


class DeadPrimary(Base):
    def test_owner_dm_without_a_reply_for_15_minutes(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "t.db"); c = sqlite3.connect(p)
            c.execute("CREATE TABLE inbound_queue(id INTEGER PRIMARY KEY, agent_id TEXT, source TEXT, prompt TEXT, status TEXT, created_at INT)"); c.execute("CREATE TABLE outbound_queue(id INTEGER PRIMARY KEY, agent_id TEXT, channel TEXT, text TEXT, status TEXT, created_at INT)")
            c.execute("INSERT INTO inbound_queue(agent_id, source, prompt, status, created_at) VALUES('main','channel','hi','queued',1000)"); c.commit()
            self.assertFalse(cp.dead_primary(p, 1000 + 600)); self.assertTrue(cp.dead_primary(p, 1000 + 1000))             # 10 min: waiting, 16+ min: dead
            c.execute("INSERT INTO outbound_queue(agent_id, channel, text, status, created_at) VALUES('main','D1','answer','sent',1500)"); c.commit()
            self.assertFalse(cp.dead_primary(p, 1000 + 5000))                                                              # it answered
            c.execute("INSERT INTO inbound_queue(agent_id, source, prompt, status, created_at) VALUES('main','bus','x','queued',10)"); c.commit()
            self.assertFalse(cp.dead_primary(p, 99999999))                                                                 # bus mail does not count
            c.close()

INBOUND = "CREATE TABLE inbound_queue(id INTEGER PRIMARY KEY, agent_id TEXT, source TEXT, prompt TEXT, reply_channel TEXT, reply_user TEXT, dedup_key TEXT, status TEXT, attempts INT DEFAULT 0, last_error TEXT, created_at INT DEFAULT 0, delivered_at INT, session_ref TEXT, requeues INT DEFAULT 0, owner_alarmed_at INT%s)"
OUTBOUND = "CREATE TABLE outbound_queue(id INTEGER PRIMARY KEY, agent_id TEXT, channel TEXT, text TEXT, status TEXT, created_at INT)"

class Router(Base):
    def mkdb(self, tmp):
        p = os.path.join(tmp, "t.db"); c = sqlite3.connect(p); c.execute(INBOUND % "")
        rows = [("main", "channel", "Owner: what is on today?", "D0MAIN", "queued", "U0OWNER"), ("main", "scheduler", "morning briefing", None, "queued", None), ("main", "bus", "[Inter-agent] alpha says hi", None, "queued", None),
                ("zeta", "channel", "for zeta", "D0ZETA", "queued", "U0OWNER"), ("main", "channel", "old one", "D0MAIN", "delivered", "U0OWNER"),
                ("main", "channel", "a bot in a channel says go", "C0CHAN", "queued", "B0BOT"), ("main", "channel", "someone else DMs", "D0X", "queued", "U0OTHER"), ("main", "channel", "owner in a channel", "C0CHAN", "queued", "U0OWNER")]
        for r in rows: c.execute("INSERT INTO inbound_queue(agent_id, source, prompt, reply_channel, status, reply_user) VALUES(?,?,?,?,?,?)", r)
        c.commit(); c.close(); return p
    def test_owner_dm_and_schedules_go_to_the_captain_during_an_outage_and_bus_mail_stays(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = self.mkdb(tmp); sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st.update(state="outage", reason="usage limit"); cp.save_state(st, sp)
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 2)
            c = sqlite3.connect(db); rows = {r[0]: r[1:] for r in c.execute("SELECT id, agent_id, prompt, reply_channel FROM inbound_queue")}; c.close()
            self.assertEqual(rows[1][0], "captain"); self.assertTrue(rows[1][1].startswith("Owner: what is on today?")); self.assertIn(cp.MARK, rows[1][1]); self.assertEqual(rows[1][2], "U0OWNER")   # the captain answers the owner from its own identity
            self.assertIn("Emergency captain (Captain):", rows[1][1]); self.assertIn("for Main", rows[1][1])
            self.assertEqual(rows[2][0], "captain"); self.assertTrue(rows[2][1].startswith("morning briefing")); self.assertIn(cp.MARK, rows[2][1])
            self.assertEqual(rows[3][0], "main"); self.assertEqual(rows[4][0], "zeta"); self.assertEqual(rows[5][0], "main")             # bus mail, other agents, delivered rows untouched
            self.assertEqual([rows[i][0] for i in (6, 7, 8)], ["main"] * 3)                                                                # a bot, another person, or the owner in a channel (not a DM) stay for the primary agent
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)                                                                             # idempotent
    def test_nothing_is_routed_when_claude_is_fine(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = self.mkdb(tmp); sp = os.path.join(tmp, "outage.json"); cp.save_state(cp.new_state(), sp)
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)
            c = sqlite3.connect(db); self.assertEqual(c.execute("SELECT COUNT(*) FROM inbound_queue WHERE agent_id='captain'").fetchone()[0], 0); c.close()

class RouterOwnerFirst(Base):
    """The owner text must come first (a wrapper first was once read as the announcement); a DM the engine DELIVERED to the dead pane within seconds is put back on the captain's queue."""
    def mk(self, tmp, since=1000):
        db = os.path.join(tmp, "t.db"); c = sqlite3.connect(db); c.execute(INBOUND % "")
        sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st.update(state="outage", reason="usage limit", since=since, outage_since=since); cp.save_state(st, sp)
        return db, sp, c
    def test_the_owner_text_comes_first_and_the_wrapper_after_it_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, sp, c = self.mk(tmp); c.execute("INSERT INTO inbound_queue(agent_id, source, prompt, reply_channel, reply_user, status, created_at) VALUES('main','channel','Budget: what is the total?','D0M','U0OWNER','queued',2000)"); c.commit()
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 1)
            pr = c.execute("SELECT prompt FROM inbound_queue WHERE id=1").fetchone()[0]
            self.assertTrue(pr.startswith("Budget: what is the total?")); self.assertIn(cp.MARK, pr); self.assertEqual(pr.count(cp.MARK), 1)
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)                                   # a second pass does not wrap again
            self.assertEqual(c.execute("SELECT prompt FROM inbound_queue WHERE id=1").fetchone()[0], pr); c.close()
    def test_an_owner_dm_already_delivered_to_the_primary_during_the_outage_is_re_addressed_to_the_captain(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, sp, c = self.mk(tmp, since=1000)
            for cr, st in ((2000, "delivered"), (900, "delivered")):   # one inside the outage, one from before it
                c.execute("INSERT INTO inbound_queue(agent_id, source, prompt, reply_channel, reply_user, status, created_at, delivered_at) VALUES('main','channel','Add Dana','D0M','U0OWNER',?,?,?)", (st, cr, cr + 2))
            c.commit(); self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 1)
            rows = {r[0]: r[1:] for r in c.execute("SELECT id, agent_id, status FROM inbound_queue")}; c.close()
            self.assertEqual(rows[1], ("captain", "queued")); self.assertEqual(rows[2], ("main", "delivered"))   # the old delivered row is history, untouched

class RouterDeliveredSafety(Base):
    """A re-addressed delivered row must answer to the owner like a queued one, start clean, skip what the primary already answered, and never sweep history."""
    def mk(self, tmp, since=1000):
        db = os.path.join(tmp, "t.db"); c = sqlite3.connect(db); c.execute(INBOUND % ""); c.execute(OUTBOUND)
        sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st.update(state="outage", reason="x", since=since, outage_since=since); cp.save_state(st, sp)
        return db, sp, c
    def ins(self, c, prompt="Add Dana", cr=2000):
        c.execute("INSERT INTO inbound_queue(agent_id, source, prompt, reply_channel, reply_user, status, created_at, delivered_at, attempts, requeues, owner_alarmed_at, session_ref, last_error) VALUES('main','channel',?,'D0M','U0OWNER','delivered',?,?,3,2,1999,'old-sess','boom')", (prompt, cr, cr + 2))
    def test_the_re_addressed_row_replies_to_the_owner_and_starts_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, sp, c = self.mk(tmp); self.ins(c); c.commit(); self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 1)
            r = c.execute("SELECT reply_channel, attempts, requeues, owner_alarmed_at, session_ref, last_error, delivered_at FROM inbound_queue WHERE id=1").fetchone(); c.close()
            self.assertEqual(r, ("U0OWNER", 0, 0, None, None, None, None))
    def test_a_row_the_primary_already_answered_is_not_re_addressed(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, sp, c = self.mk(tmp); self.ins(c); c.execute("INSERT INTO outbound_queue(agent_id, channel, text, status, created_at) VALUES('main','D0M','done, added','sent',2050)"); c.commit()
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)
            self.assertEqual(c.execute("SELECT agent_id FROM inbound_queue WHERE id=1").fetchone()[0], "main"); c.close()
    def test_without_a_known_outage_start_no_history_is_swept(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, sp, c = self.mk(tmp, since=0); self.ins(c, cr=5); c.commit(); c.close()
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)

class RouterFleet(Base):
    def test_scheduled_tasks_of_the_other_agents_go_to_the_captain_with_a_for_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "t.db"); c = sqlite3.connect(db); c.execute(INBOUND % "")
            rows = [("alpha", "scheduler", "bill monitor", "queued"), ("beta", "manual", "crm sweep", "queued"), ("alpha", "manual", "alpha manual run", "queued"), ("alpha", "bus", "a bus message", "queued"),
                    ("gamma", "scheduler", "gamma task while it is on codex", "queued"), ("zeta", "channel", "owner DM to zeta", "queued"), ("alpha", "scheduler", "already delivered", "delivered"),
                    ("zeta", "scheduler", "zeta is not covered", "queued")]
            for a, s, pr, stt in rows: c.execute("INSERT INTO inbound_queue(agent_id, source, prompt, status) VALUES(?,?,?,?)", (a, s, pr, stt))
            c.commit(); c.close()
            sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st.update(state="outage", switches=[{"agent": "gamma", "reason": "r", "at": 1, "runtime_before": None}]); cp.save_state(st, sp)
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 3)
            c = sqlite3.connect(db); r = {i: v for i, *v in c.execute("SELECT id, agent_id, prompt FROM inbound_queue")}; c.close()
            for i, who in ((1, "alpha"), (2, "beta"), (3, "alpha")):
                self.assertEqual(r[i][0], "captain"); self.assertTrue(r[i][1].startswith(f"[FOR {who}, read their CLAUDE.md first]"), r[i][1][:60]); self.assertIn(rows[i - 1][2], r[i][1])
            self.assertEqual([r[i][0] for i in (4, 5, 6, 7, 8)], ["alpha", "gamma", "zeta", "alpha", "zeta"])      # bus mail, a switched agent's own task, owner DMs, delivered rows, uncovered agents stay
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)                                                                 # idempotent

class RouterAliveGuard(Base):
    mkdb = Router.mkdb
    def test_nothing_is_routed_while_the_primary_agent_is_answering(self):
        """With the primary agent alive and answering, routing its owner DMs too made two agents answer. Any outbound from it in the last 5 minutes means alive."""
        with tempfile.TemporaryDirectory() as tmp:
            db = self.mkdb(tmp); sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st.update(state="outage", reason="usage limit"); cp.save_state(st, sp)
            c = sqlite3.connect(db); c.execute("CREATE TABLE IF NOT EXISTS outbound_queue(id INTEGER PRIMARY KEY, agent_id TEXT, channel TEXT, text TEXT, status TEXT, created_at)")
            c.execute("INSERT INTO outbound_queue(agent_id, channel, text, status, created_at) VALUES('main','D0MAIN','hi','sent',?)", (time.time() - 60,)); c.commit()
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)
            c.execute("UPDATE outbound_queue SET created_at=?", (time.time() - 3600,)); c.commit(); c.close()
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 2)
        with tempfile.TemporaryDirectory() as tmp:
            db = self.mkdb(tmp); sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st.update(state="outage", reason="usage limit"); cp.save_state(st, sp)
            c = sqlite3.connect(db); c.execute("CREATE TABLE IF NOT EXISTS outbound_queue(id INTEGER PRIMARY KEY, agent_id TEXT, channel TEXT, text TEXT, status TEXT, created_at)")
            for t in (":rotating_light: Claude is out (usage limit). Captain is emergency captain.", "Claude is back. Main has the con again.", ":rotating_light: Emergency captain (Captain): OpenAI: weekly 80% used."):
                c.execute("INSERT INTO outbound_queue(agent_id, channel, text, status, created_at) VALUES('main','D0MAIN',?,'sent',?)", (t, time.time() - 10))   # the captain code posts ITS owner lines as the primary agent
            c.commit(); c.close()
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 2)                                   # those are not the primary agent answering

class HandoffStub(Base):
    def test_a_handoff_older_than_the_outage_is_replaced_by_a_marked_stub_and_a_fresh_one_is_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "store", "captain-handoff.md")
            self.assertTrue(cp.ensure_handoff(p, 1000, "/logs/x.md", 5000)); txt = open(p).read()
            self.assertIn("auto-generated by the captain code", txt); self.assertIn("/logs/x.md", txt)
            os.utime(p, (500, 500)); self.assertTrue(cp.ensure_handoff(p, 1000, "/logs/y.md", 5000))
            open(p, "w").write("the captain wrote this"); os.utime(p, (3000, 3000))
            self.assertFalse(cp.ensure_handoff(p, 1000, "/logs/z.md", 5000)); self.assertEqual(open(p).read(), "the captain wrote this")

class RouterSkipList(Base):
    def test_skip_listed_tasks_are_dropped_and_marked_not_given_to_the_captain(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "t.db"); c = sqlite3.connect(db); c.execute(INBOUND % "")
            rows = [("main", "scheduler", "sched:nightly-report:1", "[Scheduled task: nightly-report] run", "queued"), ("main", "scheduler", "sched:nightly-report:2", "[Scheduled task: nightly-report] run", "queued"),
                    ("main", "scheduler", "sched:morning-briefing:3", "[Scheduled task: morning-briefing] run", "queued"), ("alpha", "scheduler", "sched:nightly-report-copy:4", "[Scheduled task: nightly-report-copy] run", "queued"),
                    ("gamma", "scheduler", "sched:nightly-report:5", "[Scheduled task: nightly-report] run", "delivered")]
            for a, s_, dk, pr, st_ in rows: c.execute("INSERT INTO inbound_queue(agent_id, source, dedup_key, prompt, status) VALUES(?,?,?,?,?)", (a, s_, dk, pr, st_))
            c.commit(); c.close()
            sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st["state"] = "outage"; cp.save_state(st, sp)
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 2)                                   # only the briefing and the lookalike alpha task reach the captain
            c = sqlite3.connect(db); r = {i: v for i, *v in c.execute("SELECT id, agent_id, status, last_error FROM inbound_queue")}; c.close()
            for i in (1, 2): self.assertEqual((r[i][0], r[i][1]), ("main", "failed")); self.assertTrue(r[i][2].startswith("skipped (captain outage skip list)"))
            self.assertEqual((r[3][0], r[4][0]), ("captain", "captain")); self.assertEqual(r[5][1], "delivered")      # a delivered row is never touched
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)
    def test_an_empty_skip_list_drops_nothing(self):
        self.cfgset(skip_tasks=[])
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "t.db"); c = sqlite3.connect(db); c.execute(INBOUND % "")
            c.execute("INSERT INTO inbound_queue(agent_id, source, dedup_key, prompt, status) VALUES('main','scheduler','sched:nightly-report:1','run','queued')"); c.commit(); c.close()
            sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st["state"] = "outage"; cp.save_state(st, sp)
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 1)

class RouterPoison(Base):
    def test_a_row_whose_dedup_key_the_captain_already_has_cannot_block_the_rest(self):
        """A UNIQUE(agent_id, dedup_key) violation once repeated thousands of times and the briefing never moved (one poisoned row aborted every pass)."""
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "t.db"); c = sqlite3.connect(db); c.execute(INBOUND % ", UNIQUE(agent_id, dedup_key)")
            rows = [("captain", "scheduler", "sched:dream-engine:1", "delivered", "dream (captain's copy)"), ("main", "scheduler", "sched:dream-engine:1", "queued", "dream (main's, same key)"),
                    ("main", "scheduler", "sched:morning-briefing:2", "queued", "briefing"), ("alpha", "scheduler", "sched:bill-monitor:3", "queued", "bills"), ("captain", "scheduler", "sched:bill-monitor:3", "delivered", "bills (captain's copy)")]
            for a, s_, dk, st_, pr in rows: c.execute("INSERT INTO inbound_queue(agent_id, source, dedup_key, status, prompt) VALUES(?,?,?,?,?)", (a, s_, dk, st_, pr))
            c.commit(); c.close()
            sp = os.path.join(tmp, "outage.json"); st = cp.new_state(); st["state"] = "outage"; cp.save_state(st, sp)
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 1)                               # only the briefing moves; no exception
            c = sqlite3.connect(db); r = {i: v for i, *v in c.execute("SELECT id, agent_id, status, last_error FROM inbound_queue")}; c.close()
            self.assertEqual(r[3][0], "captain")                                               # the briefing reached the captain
            for i in (2, 4): self.assertEqual(r[i][1], "failed"); self.assertTrue(r[i][2].startswith("skipped (captain"), r[i])
            self.assertEqual(cp.route_once(db, sp, "U0OWNER"), 0)                              # and it does not loop on the poisoned rows

class Section(Base):
    def test_a_renamed_hard_rule_heading_stops_the_generator_instead_of_silently_dropping_the_rule(self):
        with self.assertRaises(ValueError) as cm: cp.captain_section("# x\n## Something else\nfoo\n", open(self.fmd).read())
        self.assertIn("MAIL: DRAFT ONLY", str(cm.exception)); self.assertIn("FLEET RULE 1", str(cm.exception))
        with self.assertRaises(ValueError) as cm: cp.captain_section(open(self.pmd).read(), "## Rule 3 - x\ny\n")
        self.assertIn("Rule 4", str(cm.exception))
    def test_generated_from_the_primary_rules_and_replaces_its_own_block(self):
        block = self.blk()
        for w in ("Emergency captain (Captain)", "Never send mail.", "Do not poll.", "Ask the owner first.", "Stay private.", "Read by default.", "refuse", "never a go", "production", "You are Captain", "Main's duties"): self.assertIn(w, block)
        self.assertNotIn("## Other", block); self.assertNotIn("\nx\n", block)
        a = cp.merge_block("# AGENTS\nbody\n", block); b = cp.merge_block(a, block.replace("Never send mail.", "Never send mail, ever."))
        self.assertEqual(b.count(cp.BEGIN), 1); self.assertIn("ever.", b); self.assertTrue(b.startswith("# AGENTS\nbody"))
    def test_empty_rule_heads_build_without_reading_any_rules_file(self):
        self.cfgset(rule_heads=[], fleet_rule_heads=[], primary_rules_file=os.path.join(self.root, "no-such.md"), fleet_rules_file=os.path.join(self.root, "no-such-fleet.md"))
        block = cp.captain_section("", ""); self.assertIn("HARD RULES", block); self.assertIn("You are Captain", block)
        md = os.path.join(self.root, "AGENTS.md"); open(md, "w").write("# AGENTS\nbody\n")
        self.assertEqual(cp.gen_section(md), len(block))      # the rules files do not exist and are never opened: no error
        self.assertIn(cp.BEGIN, open(md).read()); self.assertTrue(open(md).read().startswith("# AGENTS\nbody"))
    def test_gen_section_writes_the_block_into_the_agents_md_from_the_configured_files(self):
        md = os.path.join(self.root, "AGENTS.md"); open(md, "w").write("# AGENTS\nbody\n"); n = cp.gen_section(md)
        t = open(md).read(); self.assertGreater(n, 100); self.assertIn("Never send mail.", t); self.assertEqual(cp.gen_section(md), n); self.assertEqual(open(md).read().count(cp.BEGIN), 1)

class CodexMcp(Base):
    def test_servers_are_added_for_the_outage_and_removed_afterwards_leaving_the_rest_alone(self):
        base = '[projects."/tmp"]\ntrust_level = "trusted"\n'
        on = cp.merge_mcp(base, {"first": ("node", ["/a/index.js"]), "second": ("node", ["/w/index.js"])})
        self.assertIn("[mcp_servers.first]", on); self.assertIn('args = ["/w/index.js"]', on); self.assertTrue(on.startswith(base))
        self.assertEqual(cp.merge_mcp(on, {"first": ("node", ["/b.js"])}).count(cp.MCP_BEGIN), 1)                 # replaces its own block
        self.assertEqual(cp.merge_mcp(on, None), base)                                                          # off: exactly the original

class ConfigContract(Base):
    def _tenant(self, overrides=None):
        t = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, t, True); os.makedirs(f"{t}/config")
        if overrides is not None: json.dump(overrides, open(f"{t}/config/overrides.json", "w"))
        return t
    def test_defaults_when_no_config_file_exists(self):
        t = self._tenant()
        with mock.patch.object(cfg, "TENANT", t):
            c = cfg.load(os.path.join(t, "config", "captain.json"))
        self.assertEqual((c["primary_agent"], c["captain_agent"], c["max_switched"], c["covered_agents"], c["skip_tasks"], c["rule_heads"], c["tools_repo"]), ("main", "captain", 2, [], [], [], None))
        self.assertEqual((c["timezone"], c["owner_user"], c["infra_agent"]), ("UTC", None, "main"))
        self.assertTrue(any("NEVER edit fleet code" in r for r in c["hard_rules"]))
    def test_never_switch_always_contains_the_primary_and_the_captain(self):
        t = self._tenant(); p = os.path.join(t, "c.json")
        with mock.patch.object(cfg, "TENANT", t):
            self.assertEqual(sorted(cfg.load(p)["never_switch"]), ["captain", "main"])
            json.dump({"never_switch": ["x"], "primary_agent": "boss", "captain_agent": "skip"}, open(p, "w")); self.assertEqual(sorted(cfg.load(p)["never_switch"]), ["boss", "skip", "x"])
            json.dump({"never_switch": ["boss", "x", "boss"], "primary_agent": "boss"}, open(p, "w")); self.assertEqual(sorted(cfg.load(p)["never_switch"]), ["boss", "captain", "x"])
        self.assertEqual(sorted(self.cfgset(never_switch=[])["never_switch"]), ["captain", "main"])
    def test_owner_user_and_timezone_fall_back_to_overrides_json(self):
        t = self._tenant({"owner": {"slackUserId": "U0FALLBACK", "timezone": "Europe/Budapest"}}); p = os.path.join(t, "c.json")
        with mock.patch.object(cfg, "TENANT", t):
            c = cfg.load(p); self.assertEqual((c["owner_user"], c["timezone"]), ("U0FALLBACK", "Europe/Budapest"))
            json.dump({"owner_user": "U0OWN", "timezone": "UTC"}, open(p, "w")); c = cfg.load(p); self.assertEqual((c["owner_user"], c["timezone"]), ("U0OWN", "UTC"))     # the captain config wins
    def test_config_path_follows_captain_config_and_the_tenant(self):
        with mock.patch.object(cfg, "TENANT", "/x/tenant"), mock.patch.dict(os.environ, {"CAPTAIN_CONFIG": ""}): self.assertEqual(cfg.config_path(), "/x/tenant/config/captain.json")
        with mock.patch.dict(os.environ, {"CAPTAIN_CONFIG": "/y/c.json"}): self.assertEqual(cfg.config_path(), "/y/c.json")
    def test_path_expands_and_agent_dir_is_under_the_tenant(self):
        self.cfgset(tools_repo="~/repo"); self.assertEqual(cfg.path("tools_repo"), os.path.expanduser("~/repo")); self.assertIsNone(cfg.path("nothing_set"))
        with mock.patch.object(cfg, "TENANT", "/x/tenant"): self.assertEqual(cfg.agent_dir("alpha"), "/x/tenant/agents/alpha")

class Cli(Base):
    def run_cli(self, *args, conf=None):
        t = os.path.join(self.root, "tenant"); os.makedirs(f"{t}/store", exist_ok=True); cp_ = os.path.join(self.root, "cli.json"); json.dump(conf or {}, open(cp_, "w"))
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CAPTAIN_", "OFFICE_"))}; env.update(OFFICE_TENANT_ROOT=t, CAPTAIN_CONFIG=cp_)
        return subprocess.run([sys.executable, os.path.join(HERE, "captain.py"), *args], capture_output=True, text=True, env=env, timeout=60)
    def test_guard_without_a_tools_repo_has_nothing_to_guard(self):
        r = self.run_cli("guard"); self.assertEqual(r.returncode, 0, r.stderr); self.assertIn("nothing to guard", r.stdout)
    def test_switch_outside_an_outage_is_refused_from_the_command_line(self):
        r = self.run_cli("switch", "alpha", "because"); self.assertEqual(r.returncode, 1, r.stderr); self.assertIn("REFUSED: only during an outage", r.stdout)
        r = self.run_cli("unswitch", "alpha"); self.assertEqual(r.returncode, 1, r.stderr); self.assertIn("REFUSED", r.stdout)
    def test_an_unknown_command_prints_the_usage(self):
        r = self.run_cli("bogus"); self.assertEqual(r.returncode, 2); self.assertIn("Emergency captain", r.stdout)

if __name__ == "__main__": unittest.main()
