#!/usr/bin/env bash
# Will restarting <service> kill the tmux fleet on <socket>?
#
# Exists because the manual procedure kept producing CONFIDENT WRONG ANSWERS. On 2026-08-01 two people
# who both knew the traps got three wrong pids between them on this same check: a transient tmux client,
# a shell whose own command line matched the grep, and an empty keepalive server mistaken for the fleet.
# Every one of those returns a plausible pid rather than an error, so the wrong answer looks exactly like
# the right one and silently poisons the cgroup comparison that follows.
#
# So this script REFUSES rather than guesses. Every ambiguity is a hard exit, never a best guess —
# but "ambiguous" and "nothing at stake" are DIFFERENT answers and get different codes:
#
#   FLEET EXISTS, blast radius unreadable -> exit 2 (the caller must REFUSE):
#     - MORE THAN ONE server matched the socket
#     - the pid's comm is not literally 'tmux: server'
#     - a live pane does not actually parent to the server we selected
#     - a cgroup or the service's MainPID could not be read
#
#   NOTHING TO PROTECT -> exit 3 (the caller may proceed, safe BY CONSTRUCTION):
#     - no 'tmux: server' found for this socket at all
#     - the server owns ZERO real sessions (an empty husk, e.g. a bare __keepalive). Verifying that
#       such a server "survived the restart" is meaningless — it holds nothing. That would be a
#       FALSE ALL-CLEAR, which is worse than a false alarm, so it must never read as SAFE either.
#
# Usage: check-blast-radius.sh [socket] [service]
#   socket : tmux socket name, or "default" for the unnamed one   (default: theoffice)
#   service: systemd --user unit that would be restarted          (default: theoffice.service)
# Exit: 0 = SAFE (fleet survives) | 1 = UNSAFE (restart kills the fleet)
#       2 = A FLEET EXISTS but its blast radius is unreadable -> caller should REFUSE
#       3 = NOTHING TO PROTECT (no server / empty husk) -> caller may proceed, safe by construction
set -uo pipefail

SOCKET="${1:-theoffice}"
SERVICE="${2:-theoffice.service}"

# TWO different worlds were previously collapsed into exit 2 (Michael, 2026-08-01):
#   exit 3 = NOTHING TO PROTECT (no server, or an empty husk). Proceeding is safe BY CONSTRUCTION.
#   exit 2 = A FLEET EXISTS and its blast radius is unreadable. Sessions are live, someone may be
#            mid-turn, and we cannot tell whether a restart kills them. That is the outage the gate
#            exists to prevent, so it must REFUSE, not warn.
# Callers key on the exit code, never on grepping this text — matching your own output is brittle.
die()     { printf 'CANNOT DETERMINE: %s\n' "$1" >&2; exit 2; }
nothing() { printf 'NOTHING TO PROTECT: %s\n' "$1" >&2; exit 3; }

# --- 1. Select the server BY SOCKET, matching on comm, never on a bare args grep -------------------
# `ps -eo pid,comm,args` then filter: comm must be exactly "tmux: server". This cannot match the
# querying shell (its comm is bash), which is the failure mode that bit us.
mapfile -t CANDIDATES < <(
  ps -eo pid=,comm=,args= | while read -r pid comm rest; do
    [ "$comm" = "tmux:" ] || continue          # comm renders as "tmux: server"; first field is "tmux:"
    case "$rest" in server*) ;; *) continue ;; esac
    args="${rest#server }"
    # Normalise so `-Ltheoffice` and `-L theoffice` (and -S likewise) both match. Matching the raw
    # string required a literal " -L <name> " and would REFUSE on the no-space form — safe, but a
    # spurious refusal invites someone to "work around" the script by eyeballing pids again.
    # Pad BEFORE the sed, not after: the leading space is what lets the no-space form match when the
    # flag is the very first token. (Real `ps` args begin "/usr/bin/tmux ...", so a space is already
    # there — but relying on that is the kind of incidental assumption that breaks quietly later.)
    norm="$(printf ' %s ' "$args" | sed -E 's/ -L([^ ])/ -L \1/g; s/ -S([^ ])/ -S \1/g')"
    if [ "$SOCKET" = "default" ]; then
      case "$norm" in *" -L "*|*" -S "*) continue ;; esac   # default socket = neither flag
    else
      case "$SOCKET" in
        /*) case "$norm" in *" -S $SOCKET "*) ;; *) continue ;; esac ;;  # -S takes a socket PATH
        *)  case "$norm" in *" -L $SOCKET "*) ;; *) continue ;; esac ;;
      esac
    fi
    printf '%s\n' "$pid"
  done
)

[ "${#CANDIDATES[@]}" -eq 0 ] && nothing "no 'tmux: server' found for socket '$SOCKET' — no fleet to lose"
[ "${#CANDIDATES[@]}" -gt 1 ] && die "MULTIPLE servers matched socket '$SOCKET': ${CANDIDATES[*]} — refusing to guess"
SRV="${CANDIDATES[0]}"

# --- 2. Assert comm on the selected pid (belt and braces; catches pid reuse between steps) ---------
ACTUAL_COMM="$(ps -o comm= -p "$SRV" 2>/dev/null || true)"
[ "$ACTUAL_COMM" = "tmux: server" ] || die "pid $SRV comm is '$ACTUAL_COMM', not 'tmux: server'"

# --- 3. The server must actually OWN SOMETHING. An empty husk yields a false all-clear. ------------
if [ "$SOCKET" = "default" ]; then TM=(env -u TMUX tmux); else TM=(tmux -L "$SOCKET"); fi
mapfile -t SESSIONS < <("${TM[@]}" list-sessions -F '#{session_name}' 2>/dev/null)
REAL=0
for s in "${SESSIONS[@]}"; do case "$s" in __keepalive) ;; *) REAL=$((REAL+1)) ;; esac; done
[ "$REAL" -eq 0 ] && nothing "server $SRV on '$SOCKET' owns no real sessions (only: ${SESSIONS[*]:-none}) — nothing to lose in a restart"

# --- 4. Parent cross-check: a live pane must genuinely parent to the server we picked --------------
FIRST=""
for s in "${SESSIONS[@]}"; do case "$s" in __keepalive) ;; *) FIRST="$s"; break ;; esac; done
PANE_PID="$("${TM[@]}" list-panes -t "$FIRST" -F '#{pane_pid}' 2>/dev/null | head -1)"
[ -n "$PANE_PID" ] || die "could not read a pane pid for session '$FIRST'"
PPID_OF_PANE="$(ps -o ppid= -p "$PANE_PID" 2>/dev/null | tr -d ' ')"
[ "$PPID_OF_PANE" = "$SRV" ] || die "pane $PANE_PID of '$FIRST' parents to $PPID_OF_PANE, NOT the server $SRV we selected — wrong server"

# --- 5. Compare cgroups + KillMode ----------------------------------------------------------------
SRV_CG="$(cut -d: -f3 < "/proc/$SRV/cgroup" 2>/dev/null)" || die "cannot read /proc/$SRV/cgroup"
MAINPID="$(systemctl --user show "$SERVICE" -p MainPID --value 2>/dev/null)"
[ -n "$MAINPID" ] && [ "$MAINPID" != "0" ] || die "$SERVICE has no MainPID (not running?)"
SVC_CG="$(cut -d: -f3 < "/proc/$MAINPID/cgroup" 2>/dev/null)" || die "cannot read /proc/$MAINPID/cgroup"
KILLMODE="$(systemctl --user show "$SERVICE" -p KillMode --value 2>/dev/null)"

echo "socket        : $SOCKET"
echo "tmux server   : $SRV  (owns $REAL real session(s): ${SESSIONS[*]})"
echo "  cgroup      : $SRV_CG"
echo "service       : $SERVICE (MainPID $MAINPID, KillMode ${KILLMODE:-unset->control-group})"
echo "  cgroup      : $SVC_CG"
echo "pane check    : $FIRST pane $PANE_PID -> ppid $PPID_OF_PANE == server OK"
echo

if [ "$SRV_CG" = "$SVC_CG" ]; then
  case "${KILLMODE:-control-group}" in
    process) echo "VERDICT: SAFE — same cgroup BUT KillMode=process, so only MainPID is killed."; exit 0 ;;
    *)       echo "VERDICT: UNSAFE — tmux server shares the service cgroup and KillMode=${KILLMODE:-control-group}. A restart WILL kill the fleet."; exit 1 ;;
  esac
fi
echo "VERDICT: SAFE — tmux server is in its own cgroup, decoupled from $SERVICE. A restart kills only MainPID."
exit 0
