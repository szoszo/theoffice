#!/usr/bin/env python3
"""oomwatch — push-only cgroup detector: OOM-kills (event-driven) + swap-growth (cheap tick).

WHY THIS EXISTS
    The old memory-pressure watch sampled *available RAM* (a gauge) every 10 min. On
    2026-08-03 an OOM kill happened BETWEEN samples and was never seen — a sampler that
    structurally misses the event it exists to catch reads as coverage while being blind.

    /sys/fs/cgroup/memory.events `oom_kill` is a MONOTONIC COUNTER. A kill cannot slip
    between reads: whenever we next read, the increment is still there. So detection is
    authoritative regardless of timing.

    2026-08-04 — NEW AXIS. Szoszo had to manually reboot the Proxmox host: our LXC filled the
    host's 4GB swap and frigate (on the host, not our LXC) starved. earlyoom + the oom_kill
    watch are both blind to this: the kernel avoids the low-free-RAM number by SWAPPING, so the
    host thrashes while free RAM inside the container still looks fine. memory.swap.current is
    the gauge nothing watched. We now also NOTIFY when container swap crosses a threshold. The
    notify is the PRIMARY value: after the companion ollama cap (MemorySwapMax=0) lands, ollama
    holds ~0 swap, so any tripwire growth is AGENT/misc pages, and a human/agent has to look. We
    additionally SHED ollama as a SECONDARY, edge-triggered action — it frees ~1.3GB RAM and so
    relieves pressure, but it does NOT reclaim the swap that tripped the wire (Linux swaps pages
    back only when TOUCHED, not on free RAM), so it is never the fix, only relief. There is no
    host swap cap (Szoszo ruled it out 08-04), so this in-container wire is the ONLY guard on the
    swap axis.

DESIGN (FLEET RULE 1 — infra does the watching; this is a tiny 64MB-capped daemon, NOT an agent
    session, so a cheap internal tick is exactly the carve-out the rule allows, not a pinned poll)
    We block on select.poll() against memory.events (POLLPRI wakes the INSTANT an oom_kill is
    counted). The poll TIMEOUT doubles as the swap sample cadence (SWAP_SAMPLE_S). oom_kill
    detection is unaffected by the shorter timeout — the counter is monotonic, so a wider or
    narrower gap can only change latency, never miss a kill. On every wake we (1) re-read the
    monotonic oom_kill counter and fire on any increase, then (2) read memory.swap.current and,
    on a swap-high condition, notify with a TIME-BASED re-arm (never a level-based latch — see the
    proof in main()) and shed ollama on the fresh crossing only. Baselines persist so a kill that
    lands while this service is DOWN is caught on next start.

Rollback: systemctl --user disable --now oomwatch.service  (zero engine side effects).
"""
import json
import os
import select
import sys
import time
import urllib.request

CG_EVENTS = "/sys/fs/cgroup/memory.events"          # container root: aggregates every child
CG_SWAP_CUR = "/sys/fs/cgroup/memory.swap.current"  # container root: total swap in use by us
STATE = os.path.join(os.environ.get("OFFICE_TENANT_ROOT", "/opt/claude/theoffice/tenant"),
                     "store", "oomwatch.state.json")
SWAP_SAMPLE_S = 60                                  # poll timeout == swap sample gap (monotonic oom still exact)
RESYNC_TIMEOUT_S = 3600                             # worst-case oom re-read bound (unchanged guarantee)
# --- Swap tripwire ---------------------------------------------------------------------------
# THRESHOLD (MiB), re-derived against the MEASURED post-#1 reality (2026-08-04, after the ollama
# cap went live). An earlier draft used 1024, derived from a ~516 MiB steady that assumed
# everything-but-ollama stayed put. WRONG: #1 itself moved that dependency. With ollama pinning
# ~1.7-1.9 GB resident (MemorySwapMax=0, no cold-page drift), the kernel evicted AGENT cold pages
# to swap instead — and eviction is STICKY (Linux swaps back only on TOUCH, never on free RAM), so
# it does NOT recede when ollama unloads. Measured, model-unloaded/idle:
#     ollama 0 + agents ~807 + java ~182 + other ~147 = ~1134 MiB, observed band ~1100-1350.
# PROOF it's sticky: unloading the model dropped ollama resident 1720->430 MiB while container
# swap held 1135->1134 MiB. So the honest post-#1 steady is ~1.1 GB, NOT 0.5 GB.
#   2048 MiB = ~700-900 MiB above the measured band (routine agent breathing won't trip it) AND
#   50% of the host-backed 4 GB ceiling, leaving ~2 GB of runway to react. To reach 2048, agent+
#   java swap must grow ~900 MiB above steady — and ollama can no longer contribute a single page,
#   so that can ONLY be a real agent leak/runaway, exactly what we want paged about. Because the
#   notify heartbeats (never latches), gradual growth from 2 GB up keeps re-alerting, not one-shot.
SWAP_HIGH_MIB = 2048
# RE-ARM IS TIME-BASED, NOT LEVEL-BASED — this is the fix for the silent-guard defect. The old
# design re-armed only when swap fell back under a CLEAR level sitting ~12 MiB under steady; if
# steady ever crept past CLEAR the tripwire would fire once and latch off forever while still
# looking healthy. Here the ONLY gate on re-arming is wall-clock: we notify whenever swap is high
# AND at least FIRE_COOLDOWN_S has passed since the last notify. Re-arm depends on TIME ALONE and
# never on swap dropping to some level, so there is no reachable state where swap stays >= HIGH and
# we go silent beyond FIRE_COOLDOWN_S. Persisting-high => a heartbeat every FIRE_COOLDOWN_S (the
# opposite of silent); dropping-low => we simply stop firing. See the proof note in main().
FIRE_COOLDOWN_S = 600                                # max silence while persistently high = 10 min
OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")
SHED_MODEL = os.environ.get("OOMWATCH_SHED_MODEL", "bge-m3")
WAKE_TO = "darryl"                                   # owning agent for OOM triage
WAKE_FROM = "oomwatch"


def _api_base() -> str:
    return os.environ.get("OFFICE_API_BASE", "http://127.0.0.1:3430")


def _bearer() -> str:
    p = os.path.join(os.environ.get("OFFICE_TENANT_ROOT", "/opt/claude/theoffice/tenant"),
                     "store", ".dashboard-token")
    try:
        return open(p).read().strip()
    except OSError:
        return ""


def read_oom_kill() -> "int | None":
    """Current aggregate oom_kill counter, or None if unreadable."""
    try:
        for line in open(CG_EVENTS):
            k, _, v = line.partition(" ")
            if k == "oom_kill":
                return int(v)
    except (OSError, ValueError):
        return None
    return None


def read_swap_mib() -> "int | None":
    """Current container swap usage in MiB, or None if unreadable."""
    try:
        return int(open(CG_SWAP_CUR).read().strip()) // (1024 * 1024)
    except (OSError, ValueError):
        return None


def read_avail_pct() -> "float | None":
    try:
        info = {}
        for line in open("/proc/meminfo"):
            k, _, rest = line.partition(":")
            info[k] = int(rest.split()[0])
        t, a = info.get("MemTotal"), info.get("MemAvailable")
        return round(a / t * 100, 1) if t and a else None
    except (OSError, ValueError, ZeroDivisionError):
        return None


def load_baseline() -> "int | None":
    try:
        return int(json.load(open(STATE)).get("oom_kill"))
    except (OSError, ValueError, TypeError):
        return None


def save_baseline(n: int) -> None:
    tmp = STATE + ".tmp"
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(tmp, "w") as f:
            json.dump({"oom_kill": n, "t": int(time.time())}, f)
        os.replace(tmp, STATE)
    except OSError as ex:
        log("state write failed: %s" % ex)


def log(msg: str) -> None:
    print("[oomwatch] %s" % msg, flush=True)


def shed_ollama() -> str:
    """SECONDARY remediation only. Unload the resident ollama model (keep_alive:0).

    IMPORTANT — what this does and does NOT do post-#1: with ollama under MemorySwapMax=0 it holds
    ~0 swap, so any swap growth that trips this tripwire is AGENT/misc pages, not ollama's. Linux
    does not swap-in on free RAM — pages return only when TOUCHED — so unloading ollama CANNOT pull
    the agent swap back and cannot directly clear the condition that fired. Its only effect is RAM
    RELIEF: freeing ~1.3GB resident lowers overall pressure, which makes the kernel LESS likely to
    push MORE pages out and buys headroom. That is why it is secondary and edge-triggered (once per
    crossing, not every heartbeat — the model just reloads on the next recall). The NOTIFY is the
    primary value. Best-effort; a failure is logged and reported, never fatal to the watcher."""
    body = json.dumps({"model": SHED_MODEL, "input": "", "keep_alive": 0}).encode()
    req = urllib.request.Request(OLLAMA_BASE + "/api/embed", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return "shed ollama:%s ok (%s)" % (SHED_MODEL, r.status)
    except Exception as ex:  # noqa: BLE001
        return "shed ollama:%s FAILED (%s)" % (SHED_MODEL, ex)


def _post_bus(content: str, tag: str) -> None:
    body = json.dumps({"from": WAKE_FROM, "to": WAKE_TO, "content": content}).encode()
    req = urllib.request.Request(
        _api_base() + "/api/messages", data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + _bearer()},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            log("fired -> bus %s (%s)" % (r.status, tag))
    except Exception as ex:  # noqa: BLE001 — never let a POST failure kill the watcher
        log("FIRE POST FAILED (%s, %s); will retry on next change" % (tag, ex))


def fire(prev: int, cur: int) -> None:
    avail = read_avail_pct()
    delta = cur - prev
    content = (
        "OOM-KILL DETECTED (push, authoritative): container cgroup oom_kill counter went "
        "%d -> %d (+%d) — a NEW kill just landed. avail RAM now %s%%. This is event-driven off "
        "/sys/fs/cgroup/memory.events, not a sampler, so it cannot have been missed. TRIAGE: find "
        "the victim via per-service NRestarts + ActiveEnterTimestamp under system.slice / the agent "
        "tmux scopes (the child cgroup counter resets on restart; only the parent aggregate retains "
        "the total). If the victim is a claude AGENT, hand-feed it any message marked delivered "
        "before the crash (destroyed, never redelivered). If it is ollama or another self-restarting "
        "service, verify it recovered and decide if a cap/RAM change is needed. earlyoom does NOT "
        "protect this LXC (gates on free swap = fictional here)."
    ) % (prev, cur, delta, avail)
    _post_bus(content, "oom_kill %d->%d" % (prev, cur))


def fire_swap(cur_mib: int, action_note: str, heartbeat_n: int) -> None:
    """PRIMARY value of the tripwire — always sent, before any remediation. `action_note` states
    what secondary action (if any) is about to run; `heartbeat_n` > 1 means this is a persistence
    heartbeat (swap has stayed high across N notifies), not a fresh event."""
    avail = read_avail_pct()
    kind = ("SWAP STILL HIGH (persistence heartbeat #%d)" % heartbeat_n) if heartbeat_n > 1 \
        else "SWAP-GROWTH TRIPWIRE (fresh crossing)"
    content = (
        "%s (push): container memory.swap.current is %d MiB, over the %d MiB threshold "
        "(avail RAM %s%%). This is the axis that starved frigate on 2026-08-04 — the host thrashes "
        "on swap while free RAM inside the LXC still looks fine, so earlyoom + the oom_kill watch "
        "are both blind to it. SECONDARY ACTION: %s. TRIAGE: post-#1 ollama holds ~0 swap "
        "(MemorySwapMax=0), so this growth is AGENT/misc pages — find it via per-process VmSwap in "
        "/proc/*/status. There is NO host swap cap (Szoszo ruled it out 08-04), so nothing stops "
        "container swap reaching the full host-backed 4 GB — the path that forced the manual reboot. "
        "Shedding ollama frees RAM (relieves pressure) but does NOT pull these pages back, so if "
        "swap keeps climbing, escalate: something is leaking and needs a hard cap of its own."
    ) % (kind, cur_mib, SWAP_HIGH_MIB, avail, action_note)
    _post_bus(content, "swap-high %d MiB (hb#%d)" % (cur_mib, heartbeat_n))


def main() -> int:
    cur = read_oom_kill()
    if cur is None:
        log("FATAL: cannot read %s — is this cgroup v2?" % CG_EVENTS)
        return 1
    base = load_baseline()
    if base is None:
        base = cur
        save_baseline(base)
        log("cold start: baseline oom_kill=%d" % base)
    elif cur > base:
        # A kill landed while we were down — catch it now.
        log("startup catch-up: persisted=%d current=%d -> firing" % (base, cur))
        fire(base, cur)
        base = cur
        save_baseline(base)
    elif cur < base:
        # COUNTER RESET. A monotonic counter cannot decrease, so a lower current value means the
        # kernel counter was zeroed — host/LXC REBOOT or the cgroup was recreated. The persisted
        # baseline is meaningless now; adopt current so we are armed against the NEXT kill.
        # WITHOUT this branch a stale-high baseline silently swallows the next (base-cur) real
        # kills — which is EXACTLY what happened on 2026-08-04: the host reboot reset oom_kill to
        # 0 while the persisted baseline stayed 2, and the deployed watcher logged "armed:
        # baseline=2" and went blind to the next two kills. Kills before the reset died with the
        # old kernel counter and can't be recovered, but a reboot is already a louder signal than
        # an OOM, so nothing actionable is lost.
        log("counter reset (persisted=%d > current=%d): reboot/cgroup-recreate -> re-baseline to %d"
            % (base, cur, cur))
        base = cur
        save_baseline(base)
    else:
        log("armed: baseline oom_kill=%d" % base)

    try:
        fd = os.open(CG_EVENTS, os.O_RDONLY)
    except OSError as ex:
        log("FATAL: cannot open %s: %s" % (CG_EVENTS, ex))
        return 1
    poller = select.poll()
    # POLLPRI: cgroup v2 signals it on memory.events content change. POLLERR guards fd issues.
    poller.register(fd, select.POLLPRI | select.POLLERR)
    # --- swap tripwire state. PROOF IT CANNOT LATCH OFF ------------------------------------------
    # The re-arm gate is `now - last_swap_fire >= FIRE_COOLDOWN_S` — a function of WALL-CLOCK ONLY,
    # never of the swap level. So while swap stays >= SWAP_HIGH_MIB the notify re-fires every
    # FIRE_COOLDOWN_S without bound (a heartbeat, the opposite of silent). The old latch bug is
    # unreachable here because NO variable can put us in "swap high AND permanently not notifying":
    # the only thing that suppresses a notify is time-since-last < cooldown, which always expires.
    # `swap_was_high` gates ONLY the secondary shed (edge-trigger, so we don't re-shed a model that
    # just reloads); it does NOT gate the notify, so even if it were stuck True the alerts continue.
    last_swap_fire = 0.0           # epoch of last swap notify; 0 => first crossing fires immediately
    swap_was_high = False          # edge tracker for the SECONDARY shed only (never gates notify)
    heartbeat_n = 0                # consecutive notifies while continuously high (for message context)
    last_resync = time.time()
    log("event loop up (poll POLLPRI + %ds swap tick, swap-high=%d MiB, notify-cooldown=%ds, resync<=%ds)"
        % (SWAP_SAMPLE_S, SWAP_HIGH_MIB, FIRE_COOLDOWN_S, RESYNC_TIMEOUT_S))
    while True:
        events = poller.poll(SWAP_SAMPLE_S * 1000)      # blocks; wakes on kernel edge OR every SWAP_SAMPLE_S
        # CPU-SPIN FIX (marveen 2026-08-04, found by Toby, measured 91% of one core).
        # cgroup v2 keeps POLLPRI ASSERTED on memory.events until the REGISTERED fd is read.
        # Every reader here opens a FRESH fd, so the registered one was never consumed: after
        # the FIRST oom_kill asserts POLLPRI, poll() returns instantly forever and the loop
        # busy-spins until restart. Detection still worked (monotonic counter re-read each
        # pass), so it was pure CPU burn with no blindness — which is why it went unnoticed.
        # It matters most exactly when we can least afford it: an ollama OOM during the
        # re-embed would light this up and steal a core from a CPU-only embedder.
        # Marveen + Darryl both wrote this re-arm independently (2026-08-04); the duplicate
        # unconditional copy was removed and Darryl's louder failure log kept. Re-arm ONLY when
        # POLLPRI actually fired — on the plain SWAP_SAMPLE_S timeout path there is no edge to clear.
        if events:
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                os.read(fd, 4096)
            except OSError as ex:
                log("re-arm read failed (%s); continuing" % ex)
        now = time.time()
        # --- oom_kill: monotonic, exact regardless of timing ---
        cur = read_oom_kill()
        if cur is None:
            log("transient: oom_kill unreadable, re-arming")
            time.sleep(1)
            continue
        if cur > base:
            fire(base, cur)
            base = cur
            save_baseline(base)
        elif cur < base:
            # Mid-run reset (cgroup recreated under us — rare; a reboot would kill this process
            # first). A reset is not a kill, so re-baseline WITHOUT firing.
            log("counter reset mid-run (%d -> %d) -> re-baseline, not firing" % (base, cur))
            base = cur
            save_baseline(base)
        # --- swap-growth: cheap gauge check, time-based re-arm (cannot latch off) ---
        sw = read_swap_mib()
        if sw is not None:
            if sw >= SWAP_HIGH_MIB:
                fresh = not swap_was_high
                if fresh or (now - last_swap_fire) >= FIRE_COOLDOWN_S:
                    heartbeat_n = 1 if fresh else heartbeat_n + 1
                    # 1) NOTIFY FIRST, unconditionally — the primary value of the tripwire.
                    note = ("shedding ollama now (secondary, RAM-relief only — does NOT reclaim the "
                            "swap that tripped this)") if fresh else \
                           ("none this cycle (secondary shed already ran on the initial crossing; "
                            "re-shedding is pointless, the model reloads on demand)")
                    fire_swap(sw, note, heartbeat_n)
                    last_swap_fire = now
                    # 2) SECONDARY remediation, only on a fresh crossing, AFTER the notify.
                    if fresh:
                        log("swap %d MiB >= %d (fresh) -> %s" % (sw, SWAP_HIGH_MIB, shed_ollama()))
                swap_was_high = True
            else:
                if swap_was_high:
                    log("swap receded to %d MiB (< %d) -> re-armed for next crossing" % (sw, SWAP_HIGH_MIB))
                swap_was_high = False
                heartbeat_n = 0
        # bounded resync heartbeat for the oom baseline (guarantee unchanged)
        if now - last_resync >= RESYNC_TIMEOUT_S:
            last_resync = now


if __name__ == "__main__":
    sys.exit(main())
