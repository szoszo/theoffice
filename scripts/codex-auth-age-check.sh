#!/bin/bash
# Non-LLM daily watch on the Codex (ChatGPT) auth that drives any runtime:"codex" agent (Pete-on-Codex pilot).
# Mirrors gmail-token-age-check.sh in spirit: lightweight, read-only on the token, never prints token contents.
#
# Authoritative signal: `codex login status` exit code (a LOCAL check — no model call, zero ChatGPT usage).
#   exit 0 = logged in & usable; non-zero = auth dead -> re-auth needed (`codex login --device-auth`, headless).
# `last_refresh` from auth.json is informational only (ChatGPT OAuth auto-refreshes, so file age is a weak signal).
#
# Severity is gated on whether anything actually depends on Codex right now:
#   - auth DEAD + >=1 agent has runtime:"codex" in agent.json  -> URGENT page (a LIVE agent is down).
#   - auth DEAD + NO codex agent yet (pre-cutover)             -> soft WARN page (cutover blocked, nothing broken).
#   - auth OK                                                  -> log OK, no page.
# Alert path = the standard Office bus (POST /api/messages from darryl -> marveen, who relays to Szoszo).
#
# Usage:
#   bash scripts/codex-auth-age-check.sh            # check + page marveen via the bus if auth is dead
#   bash scripts/codex-auth-age-check.sh --dry-run  # check + PRINT only, never posts
set -uo pipefail

API="http://127.0.0.1:3430/api/messages"
TOKEN_PATH="/opt/claude/theoffice/tenant/store/.dashboard-token"
AGENTS_DIR="/opt/claude/theoffice/tenant/agents"
AUTH="${HOME}/.codex/auth.json"
CODEX="${CODEX:-${HOME}/.local/bin/codex}"; command -v "$CODEX" >/dev/null 2>&1 || CODEX="$(command -v codex || echo codex)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

# which agents are LIVE on the codex runtime? (read agent.json; default "claude")
codex_agents=()
for d in "$AGENTS_DIR"/*/; do
  id=$(basename "$d")
  rt=$(python3 -c "import json;print(json.load(open('${d}agent.json')).get('runtime','claude'))" 2>/dev/null || echo claude)
  [ "$rt" = "codex" ] && codex_agents+=("$id")
done

# authoritative validity check
if "$CODEX" login status >/dev/null 2>&1; then status_ok=1; else status_ok=0; fi

# informational staleness (days since codex last refreshed the access token)
ref_days="?"
if [ -f "$AUTH" ]; then
  ref_days=$(python3 -c "
import json,sys,time,datetime
try:
    lr=json.load(open('$AUTH')).get('last_refresh')
    if not lr: print('?'); sys.exit()
    t=datetime.datetime.fromisoformat(lr.replace('Z','+00:00')).timestamp()
    print(int((time.time()-t)//86400))
except Exception: print('?')
" 2>/dev/null || echo "?")
fi

if [ "$status_ok" = "1" ]; then
  echo "codex-auth-age-check: OK (codex login status=0; last_refresh ${ref_days}d ago; codex agents: ${codex_agents[*]:-none})"
  exit 0
fi

# auth is DEAD -> build a severity-appropriate message
if [ ${#codex_agents[@]} -gt 0 ]; then
  MSG="🔴 CODEX AUTH DEAD — LIVE agent(s) on Codex are down: ${codex_agents[*]}. They cannot process messages until re-auth. Fix (headless): run \`codex login --device-auth\` as szoszo, open the device URL, approve, then verify \`codex login status\` exits 0. Revert option: flip those agents' agent.json runtime back to \"claude\" + restart."
else
  MSG="🟠 Codex auth is dead (codex login status failed; last_refresh ${ref_days}d ago). Nothing is broken — no agent is on Codex yet — but the Pete-on-Codex cutover is BLOCKED until re-auth: \`codex login --device-auth\` as szoszo. (Non-LLM watch; daily.)"
fi
echo "codex-auth-age-check: DEAD (codex login status!=0; last_refresh ${ref_days}d; codex agents: ${codex_agents[*]:-none})"

if [ "$DRY" = "1" ]; then
  echo "[dry-run] would POST to marveen via the bus:"; echo "  $MSG"; exit 0
fi
if [ ! -f "$TOKEN_PATH" ]; then echo "WARN: $TOKEN_PATH missing; cannot post bus alert" >&2; exit 0; fi
TOK="$(cat "$TOKEN_PATH")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  --data "$(python3 -c "import json,sys;print(json.dumps({'from':'darryl','to':'marveen','content':sys.argv[1]}))" "$MSG")")
if [ "$code" = "200" ] || [ "$code" = "201" ]; then echo "alert posted to marveen (HTTP $code)"; else echo "WARN: bus post failed (HTTP $code)" >&2; fi
exit 0
