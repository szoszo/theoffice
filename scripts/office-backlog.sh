#!/usr/bin/env bash
# office-backlog — zero-ceremony backlog capture (issue #21 §2). An agent (or the owner via an agent)
# drops an idea onto the kanban as a `planned` card with no ceremony, so the board becomes the real
# backlog instead of the idea evaporating into a memory. Capture has to be cheaper than remembering.
#
#     office-backlog "wire up the Splitwise webhook"
#     office-backlog <<'EOF'
#     multi-line idea with `backticks` and "quotes" — all literal
#     EOF
#
# The engine sets OFFICE_AGENT_ID / OFFICE_TENANT_ROOT / OFFICE_PORT in the session env. POSTs to the
# existing authed /api/kanban (dashboard token), then VERIFIES the card actually landed (evidence, per
# the issue #21 §1 verification-first theme) before reporting success.
set -euo pipefail

if [ "$#" -ge 1 ]; then
  TITLE="$1"                       # arg mode
elif [ ! -t 0 ]; then
  TITLE="$(cat)"                   # stdin mode: a quoted heredoc is never shell-substituted
else
  echo "usage: office-backlog \"idea\"   OR   office-backlog <<'EOF' ... EOF" >&2
  exit 1
fi
[ -n "${TITLE//[[:space:]]/}" ] || { echo "office-backlog: empty idea" >&2; exit 1; }
AGENT="${OFFICE_AGENT_ID:?OFFICE_AGENT_ID not set (run inside an agent session)}"
TENANT="${OFFICE_TENANT_ROOT:?OFFICE_TENANT_ROOT not set}"
PORT="${OFFICE_PORT:-3430}"
TOKEN="$(cat "$TENANT/store/.dashboard-token")"

# The title is passed as an argv value and JSON-encoded by python (json.dumps) — never interpolated into
# a shell or JSON string — so quotes/backticks/newlines are stored literally and cannot inject into the
# request body. The /api/kanban insert is itself a parameterized query, so the DB write is injection-safe too.
python3 - "$AGENT" "$TITLE" "$TOKEN" "$PORT" <<'PY'
import sys, json, urllib.request, urllib.error
agent, title, token, port = sys.argv[1:5]
title = title.strip()
MAX = 500
if len(title) > MAX:
    title = title[:MAX].rstrip() + "…"
base = f"http://127.0.0.1:{port}"
hdr = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def req(path, data=None):
    return urllib.request.Request(f"{base}{path}", data=data, headers=hdr)

body = json.dumps({"title": title, "status": "planned", "description": f"captured via office-backlog by {agent}"}).encode()
try:
    created = json.loads(urllib.request.urlopen(req("/api/kanban", body), timeout=10).read())
except urllib.error.HTTPError as e:
    print(f"office-backlog: create failed ({e.code}): {e.read().decode()[:200]}", file=sys.stderr)
    sys.exit(1)
cid = created.get("id")
if not cid:
    print("office-backlog: no card id returned", file=sys.stderr)
    sys.exit(1)

# VERIFY it landed: re-read the planned column and confirm the id is present (evidence, not just a 200).
planned = json.loads(urllib.request.urlopen(req("/api/kanban?status=planned"), timeout=10).read())
planned = planned if isinstance(planned, list) else planned.get("cards", [])
if not any(c.get("id") == cid for c in planned):
    print(f"office-backlog: card {cid} not found after create — verification FAILED", file=sys.stderr)
    sys.exit(1)
print(f"\U0001F4E5 backlog card {cid} (planned): {title}")
PY
