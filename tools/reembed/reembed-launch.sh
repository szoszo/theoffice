#!/usr/bin/env bash
# Detached, kernel-capped launcher for the re-embed guard (Toby item 6 / F5; Darryl).
# PREPARED FOR REVIEW — does not run the job by existing. Run it deliberately only after the
# guard's blockers (fail-closed health, abort-no-hang, consecutive-stuck timer, pinned BATCH=1) land.
#
# WHAT THIS ADDS around reembed-guarded.mjs:
#  - OWN cgroup MemoryMax (kernel-enforced) — a hard ceiling that CANNOT fail-open the way the
#    guard's soft /sys reads can. See the HONEST SCOPE note below for exactly what it does and does
#    NOT protect; it is not a substitute for ollama's own 3G cap.
#  - MemorySwapMax=0 — the job process itself can never take a page of swap.
#  - DETACHED transient --user service — survives this shell/session dying (FLEET RULE 1: nothing
#    pins an agent session; infra runs it, the guard reacts).
#  - Nice=19 + idle IO — yields CPU/IO to the agents and to ollama (CPU-only embedder).
#  - Progress + bus-notify come from the guard itself; the journal holds the full log.
#
# HONEST SCOPE (no claim stronger than evidence): this MemoryMax caps the JOB's OWN cgroup = the
# light node process (~200-350MB resident: node + the dist imports + one 2000-char row at BATCH=1).
# It does NOT contain ollama — ollama is system.slice/ollama.service, a SEPARATE cgroup already
# capped at MemoryMax=3G/MemorySwapMax=0. So this backstop's real job is to kill the JOB if it ever
# leaks, and to make it a clean detached unit. The die-proof protection against the swap-fill /
# reboot scenario is OLLAMA's cap (kernel-enforced, already live) + oomwatch's 2048 shed + the
# guard's (soon fail-closed) soft swap-pause — NOT this line. Do not oversell it as "the" backstop.
set -euo pipefail
ROOT=/opt/claude/theoffice
UNIT="reembed-$(date +%Y%m%d-%H%M%S)"   # date in bash is fine (this is not a workflow script)
NODE="$(command -v node)"

systemd-run --user \
  --unit="$UNIT" \
  --description="guarded re-embed of wrong-dim memory vectors" \
  --working-directory="$ROOT" \
  --property=MemoryMax=1G \
  --property=MemorySwapMax=0 \
  --property=Nice=19 \
  --property=IOSchedulingClass=idle \
  --property=Restart=no \
  --setenv=OFFICE_TENANT_ROOT="${OFFICE_TENANT_ROOT:-$ROOT/tenant}" \
  "$NODE" "$ROOT/tools/reembed/reembed-guarded.mjs" "$@"

cat <<EOF
launched transient unit: $UNIT
  watch :  journalctl --user -u $UNIT -f
  status:  systemctl --user is-active $UNIT   &&   (cd $ROOT && npm run memory:status)
  stop  :  systemctl --user stop $UNIT     # guard's SIGTERM handler reports to the bus + exits clean
  cap   :  MemoryMax=1G MemorySwapMax=0 on the unit's own cgroup (kernel-enforced; job-scope only)
EOF
