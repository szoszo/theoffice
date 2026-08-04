#!/usr/bin/env python3
"""RETIRED 2026-08-04 -- MANUAL BREAK-GLASS ONLY. DO NOT run this on a timer.

  SUPERSEDED by the in-engine sweeper (src/session/modal-sweeper.ts, session-hygiene, live inside
  theoffice.service). That is the authoritative path and a strict superset of this tool: usage-limit
  dismissal (highlight-verified Stop-and-wait) PLUS permission/dangerous-op alarm, and it pages the
  owner directly. This standalone script is kept ONLY as an emergency fallback for the case where the
  in-engine sweeper itself has to be disabled. Its frame matchers MAY DRIFT from Claude Code's current
  rendering -- RE-VERIFY against a live pane before ever running it, and NEVER leave it on a timer
  (running it alongside the engine sweeper double-actuates the same modal on overlapping cadences).
  Out of git by design (see .gitignore); usage is documented in the clear-agent-modal-safely skill.

Interim usage-limit modal sweeper (Darryl, 2026-08-04).

STOPGAP for the delivery outage of 2026-08-04: when a Claude agent hits its plan limit mid-turn, Claude
Code replaces the footer with a blocking "Stop and wait / Upgrade" menu. That reads as pane-state
'unknown' to the engine, so the deliverer parks EVERY queued message behind it (the owner's included),
and it never self-clears — an unattended agent goes deaf until a human presses Enter (marveen, dwight
and toby were all frozen this way on 2026-08-04). This decoupled timer dismisses the modal by confirming
option 1, "Stop and wait for limit to reset" (Claude Code then auto-resumes at reset). It does NOT touch
the engine and is reversible: `systemctl --user disable --now modal-sweeper.timer`.

The proper in-engine fix (detector in pane-state.ts + sweep in claude-runtime) is a separate patch under
Toby's gate; this only exists so nobody freezes overnight while that lands.

GOVERNING PRINCIPLE (Michael, bus 9362): AUTOMATION MAY CONFIRM, NEVER NAVIGATE.
  Moving a cursor (a digit, an arrow) asserts "I know which option is right" — a CHOICE that requires
  reading the actual command and judging its consequences. A matcher cannot read a command; it
  pattern-matches a frame, so it is not entitled to that claim. Pressing Enter on an ALREADY-safe frame
  asserts only "the safe option is already selected" — the weaker claim a matcher IS entitled to make.
  So: if the highlight is not already where it must be, the tool has hit a state it does not understand,
  and the correct response is to alarm and leave it (detectsUnsafeUsageLimitModal), never to navigate to
  what it guesses is safe. A sweeper that navigates has promoted itself from matcher to decision-maker,
  and the first time the rendering shifts it navigates confidently to the wrong place. (Clearing a real
  permission gate by hand — Down, re-capture, confirm ❯ on "No", Enter — is a HUMAN procedure with the
  authority to choose; it must NOT be copied into this tool.)

FOUR HARD CONDITIONS (Michael, bus 9245), each enforced structurally, not by intent:

  1. STRUCTURALLY INCAPABLE OF SELECTING UPGRADE. Per the governing principle, we CONFIRM, never
     navigate. The only key ever sent is Enter, and only when the cursor glyph is provably on the
     Stop-and-wait line: `❯ 1. Stop and wait for limit to reset`. If the cursor is anywhere else (e.g. on
     option 2), the expected string is not found and we REFUSE — no keystroke at all. The real hazard was
     never "a digit" specifically; it was ACTING WITHOUT VERIFYING WHICH OPTION IS SELECTED — a bare Enter
     does that just as a stray digit does. Verified-highlight Enter closes both.
  2. NEVER DISMISS MID-TURN. A pane showing any busy signal (esc-to-interrupt, the `(Ns · ↓` token
     counter) is left completely alone — the modal only appears on a HALTED turn, so a busy pane is by
     definition not parked on it.
  3. LOG EVERY DISMISSAL AND EVERY REFUSAL — agent, ISO timestamp, what matched — to modal-sweeper.log,
     so this can never fire (or silently stop firing) unseen.
  4. Runs as a timer Toby can kill on sight.

Usage:
  modal_sweeper.py            # one sweep of all agent-* panes (what the timer runs)
  modal_sweeper.py --dry-run  # detect + log intent, send NOTHING
  modal_sweeper.py --self-test  # prove the matcher on fixtures; exits non-zero if any case is wrong
"""
import re
import os
import sys
import json
import time
import hashlib
import subprocess
import urllib.request
from datetime import datetime, timezone

TMUX = "/usr/bin/tmux"
SOCKET = "theoffice"
TENANT = os.environ.get("OFFICE_TENANT_ROOT", "/opt/claude/theoffice/tenant")
LOG = f"{TENANT}/store/modal-sweeper.log"
STATE = f"{TENANT}/store/.modal-sweeper-alarm-state.json"
API = "http://127.0.0.1:3430/api/messages"
# Re-alarm about the SAME frozen permission prompt at most this often (a human is needed, but don't spam).
PERMISSION_REALARM_SEC = 1800

# The modal signature. ALL THREE must hold for us to act:
#   (a) the cursor is on option 1 = Stop-and-wait  -> confirming it can only ever pick Stop-and-wait
#   (b) option 2 = Upgrade is present              -> confirms this really is the usage-limit menu
#   (c) the modal's own footer "Enter to confirm"  -> confirms the menu is live, not quoted scrollback
CURSOR_ON_STOP_RX = re.compile(r"❯\s*1\.\s*Stop and wait for limit to reset")
UPGRADE_RX = re.compile(r"2\.\s*Upgrade your plan")
CONFIRM_FOOTER_RX = re.compile(r"Enter to confirm")
# Busy = a turn is mid-flight; never touch it (condition 2).
BUSY_RX = re.compile(r"esc to interrupt|\(\s*(?:\d+m\s*)?\d+s\s*·\s*↓\s*\d")

# PERMISSION / APPROVAL prompt. This is the class the sweeper must be STRUCTURALLY INCAPABLE of clearing
# (Michael, bus 9248): dismissing one APPROVES an action — a delete, a push, a payment, a deploy —
# blind, on the owner's box, with his credentials. A frozen agent is an inconvenience; an unattended
# approval is unbounded. So for these we DETECT + ALARM + LEAVE UNTOUCHED. Freezing is the safe failure.
# The strings below are Claude Code's own approval-menu wording; they never appear in the usage-limit
# menu (which the classifier checks FIRST and which has "Upgrade your plan", not "Yes / No"). Agents run
# --dangerously-skip-permissions so these should be rare, which is exactly why one appearing must be
# surfaced loudly rather than left to sit silently.
PERMISSION_RX = re.compile(
    r"No, and tell Claude what to do differently"
    r"|Yes, and (?:don't|do not) ask again"
    r"|Do you want to (?:proceed|make this edit|create|run|allow)"
)


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    line = f"{ts} {msg}"
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass
    print(line)


def classify(pane: str) -> str:
    """Pure decision on a captured pane. One of:
      'act'        — the usage-limit modal is up with the cursor on Stop-and-wait; safe to send Enter.
      'refuse'     — the usage-limit modal is present BUT the cursor is not provably on Stop-and-wait.
      'permission' — a permission/approval prompt: DETECT + ALARM, NEVER a keystroke (Michael 9248).
      'busy'       — a turn is mid-flight; leave it alone.
      'none'       — nothing this tool cares about.

    Order is a safety property: usage-limit is matched by its OWN exact signature ("Upgrade your plan"
    + confirm footer), which a permission prompt never carries, so the two can never be confused. The
    ONLY verdict that yields a keystroke is 'act', and 'act' requires the cursor provably on
    Stop-and-wait — so neither Upgrade nor any permission option is ever reachable.
    """
    if BUSY_RX.search(pane):
        return "busy"
    if UPGRADE_RX.search(pane) and CONFIRM_FOOTER_RX.search(pane):
        # The usage-limit menu. Act only if the highlight is provably on Stop-and-wait.
        return "act" if CURSOR_ON_STOP_RX.search(pane) else "refuse"
    if PERMISSION_RX.search(pane):
        return "permission"
    return "none"


def _load_state() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(state: dict) -> None:
    try:
        with open(STATE, "w") as f:
            json.dump(state, f)
    except OSError:
        pass


# Re-log a STILL-frozen permission gate at most this often. First detection always logs; per-tick
# repeats are suppressed so a long freeze doesn't bury the log (Michael 9333: a 2h40m freeze logged
# ~480 near-identical DETECTED lines). Log the TRANSITION, not the state.
DETECTED_HEARTBEAT_SEC = 1800


def note_permission_prompt(session: str, pane: str) -> None:
    """A permission prompt is up. LEAVE IT ALONE and log the TRANSITION — the first detection, then a
    periodic still-frozen heartbeat — NOT every 20s tick. Alarming is owned by the sibling detect-and-
    alarm tool (store/frozen-pane-alarm.sh, Michael 9265); routing a second alarm here would double-page
    Szoszo. The record still shows the sweeper saw it and correctly refused, just without the noise."""
    agent = session.removeprefix("agent-")
    # Key on the pane content so a genuinely NEW/different gate re-logs as a fresh transition.
    key = "det:" + hashlib.sha1((session + "|" + pane[-400:]).encode()).hexdigest()[:16]
    state = _load_state()
    now = time.time()
    last = state.get(key)
    if last is None:
        log(f"PERMISSION-PROMPT-DETECTED agent={agent} action=NONE(left untouched; alarm owned by frozen-pane-alarm.sh)")
    elif now - last >= DETECTED_HEARTBEAT_SEC:
        log(f"PERMISSION-PROMPT-STILL-FROZEN agent={agent} (~{int((now - last) / 60)}min since last note, still untouched)")
    else:
        return  # same gate, logged recently — suppress the per-tick repeat
    state[key] = now
    # prune old keys so the state file can't grow without bound
    state = {k: v for k, v in state.items() if now - v < 4 * DETECTED_HEARTBEAT_SEC}
    _save_state(state)


def list_agent_sessions() -> list[str]:
    r = subprocess.run([TMUX, "-L", SOCKET, "list-sessions", "-F", "#{session_name}"],
                       capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return []
    return [s.strip() for s in r.stdout.splitlines() if s.strip().startswith("agent-")]


def capture(session: str) -> str | None:
    r = subprocess.run([TMUX, "-L", SOCKET, "capture-pane", "-t", session, "-p"],
                       capture_output=True, text=True, timeout=10)
    return r.stdout if r.returncode == 0 else None


def sweep(dry_run: bool) -> int:
    acted = 0
    for session in list_agent_sessions():
        pane = capture(session)
        if pane is None:
            continue
        verdict = classify(pane)
        if verdict == "act":
            if dry_run:
                log(f"DRY-RUN would-dismiss agent={session} match='❯ 1. Stop and wait for limit to reset' (Enter, Stop-and-wait)")
                acted += 1
                continue
            # Ground-truth capture (Toby 9290): record the exact matched modal lines the FIRST time we
            # act on a real one, so we have real-world proof classify() fires on the live modal — not
            # just on the fixture — and can confirm `❯` is genuinely the selection marker.
            matched = "\n".join(l for l in pane.splitlines() if ("Stop and wait for limit to reset" in l or "Upgrade your plan" in l))
            log(f"DISMISS-MATCHED-PANE agent={session} lines=<<{matched}>>")
            ok = subprocess.run([TMUX, "-L", SOCKET, "send-keys", "-t", session, "Enter"],
                                capture_output=True, text=True, timeout=10).returncode == 0
            log(f"DISMISS agent={session} modal=usage-limit action=Enter(select-Stop-and-wait) sent={ok}")
            acted += 1
        elif verdict == "refuse":
            # Loud on purpose: the modal is up but the highlight is NOT on Stop-and-wait, so acting could
            # confirm the wrong option. We refuse and record it — a refusal that needs a human eye.
            log(f"REFUSE agent={session} modal=usage-limit reason=cursor-not-on-Stop-and-wait (no key sent)")
        elif verdict == "permission":
            # NEVER auto-dismiss a permission gate: clearing it approves the action. Log + leave it;
            # the alarm is owned by frozen-pane-alarm.sh (no double-page).
            if not dry_run:
                note_permission_prompt(session, pane)
            else:
                log(f"DRY-RUN permission-prompt agent={session} action=NONE(left untouched; frozen-pane-alarm owns the alarm)")
    return acted


# -------- self-test: proves the four conditions on fixtures; CI/pre-install gate --------
def self_test() -> int:
    MODAL_CURSOR_ON_1 = "\n".join([
        "  You've hit your session limit · resets 6:20am",
        "   What do you want to do?",
        "   ❯ 1. Stop and wait for limit to reset",
        "     2. Upgrade your plan",
        "   Enter to confirm · Esc to cancel",
    ])
    MODAL_CURSOR_ON_2 = "\n".join([  # the dangerous case: highlight on Upgrade
        "   What do you want to do?",
        "     1. Stop and wait for limit to reset",
        "   ❯ 2. Upgrade your plan",
        "   Enter to confirm · Esc to cancel",
    ])
    MODAL_BUSY = MODAL_CURSOR_ON_1 + "\n  Thinking… (12s · ↓ 1.1k tokens · esc to interrupt)"
    QUOTED = "\n".join([  # a reply that merely quotes the menu text — no live confirm footer highlight
        "● The menu said: 1. Stop and wait for limit to reset / 2. Upgrade your plan",
        "────────",
        "❯ ",
        "────────",
        "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ])
    IDLE = "\n".join(["● done", "────────", "❯ ", "────────", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"])
    PERM_EDIT = "\n".join([  # a Claude Code edit-approval gate
        "  Do you want to make this edit to config.ts?",
        "   ❯ 1. Yes",
        "     2. Yes, and don't ask again this session",
        "     3. No, and tell Claude what to do differently (esc)",
    ])
    PERM_BASH = "\n".join([  # a command-approval gate
        "  Do you want to run this command?",
        "     rm -rf /opt/claude/theoffice/tenant/store",
        "   ❯ 1. Yes",
        "     2. No, and tell Claude what to do differently (esc)",
    ])
    cases = [
        ("cursor on Stop-and-wait -> act", MODAL_CURSOR_ON_1, "act"),
        ("cursor on Upgrade -> REFUSE (never confirm Upgrade)", MODAL_CURSOR_ON_2, "refuse"),
        ("busy modal -> busy (never mid-turn)", MODAL_BUSY, "busy"),
        ("quoted menu in a reply -> none", QUOTED, "none"),
        ("idle pane -> none", IDLE, "none"),
        ("edit-permission prompt -> permission (alarm, never act)", PERM_EDIT, "permission"),
        ("bash-permission prompt -> permission (alarm, never act)", PERM_BASH, "permission"),
    ]
    bad = 0
    for name, pane, want in cases:
        got = classify(pane)
        ok = got == want
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: got={got} want={want}")
        if not ok:
            bad += 1
    # Hard invariant: the ONLY verdict that ever sends a key is 'act'. Assert that NOTHING which would
    # spend money (Upgrade highlighted) or grant permission (any approval prompt) can be classified 'act'.
    for name, pane in [("cursor-on-Upgrade", MODAL_CURSOR_ON_2), ("edit-permission", PERM_EDIT),
                       ("bash-permission", PERM_BASH)]:
        if classify(pane) == "act":
            print(f"[FAIL] INVARIANT: {name} classified 'act' — could confirm a money/permission action")
            bad += 1
    print(f"\nself-test: {'ALL PASS' if bad == 0 else str(bad) + ' FAILED'}")
    return 1 if bad else 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    dry = "--dry-run" in sys.argv
    try:
        n = sweep(dry)
        if n:
            log(f"sweep complete: {n} modal(s) {'would be ' if dry else ''}dismissed")
    except Exception as ex:
        log(f"sweep ERROR: {ex!r}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
