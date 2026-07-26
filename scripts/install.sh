#!/usr/bin/env bash
# The Office — one-shot installer for a fresh Linux container (Debian/Ubuntu).
#
# Run as your normal user (NEVER root/sudo — see the guard below). It:
#   1. checks prerequisites (node 20-22, tmux, git, systemd --user, claude CLI)
#   2. installs npm deps + builds (tsc -> dist/)
#   3. lays down the tenant skeleton
#   4. installs systemd --user units:
#        - theoffice-tmux.service : owns a DEDICATED tmux server (-L theoffice)
#          in its OWN cgroup, so restarting the engine can never kill the fleet
#        - theoffice.service      : the engine (dashboard + ingest + scheduler + bus),
#          which After/Wants the tmux unit
#   5. enables linger, starts everything, prints the dashboard URL + token
#
# Re-runnable (idempotent). Usage:
#   bash scripts/install.sh
set -euo pipefail

# ---- 0. never root ----------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: do not run this installer as root/sudo." >&2
  echo "Run it as your normal user. systemd --user units under root crash-loop and" >&2
  echo "'claude --dangerously-skip-permissions' refuses to run as root." >&2
  exit 1
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TENANT_ROOT="${OFFICE_TENANT_ROOT:-$INSTALL_DIR/tenant}"
TZ_VALUE="${OFFICE_TZ:-Europe/Budapest}"
SOCKET="${OFFICE_TMUX_SOCKET:-theoffice}"
UNIT_DIR="$HOME/.config/systemd/user"
USER_NAME="$(id -un)"  # reliable even when $USER is unset (fresh/headless env)

# Colors only on a TTY — avoid raw escape sequences under `curl | bash` or when redirected.
if [ -t 1 ]; then C_BLUE='\033[1;34m'; C_YEL='\033[1;33m'; C_OFF='\033[0m'; else C_BLUE=''; C_YEL=''; C_OFF=''; fi
say()  { printf '%b==>%b %s\n' "$C_BLUE" "$C_OFF" "$*"; }
warn() { printf '%b!!%b %s\n'  "$C_YEL"  "$C_OFF" "$*" >&2; }

# ---- 1. prerequisites -------------------------------------------------------
say "Checking prerequisites"
need() { command -v "$1" >/dev/null 2>&1 || { warn "missing: $1 ($2)"; MISSING=1; }; }
MISSING=0
need node "install Node.js 20-22"
need npm "comes with Node.js"
need tmux "apt install tmux"
need git "apt install git"
need systemctl "systemd is required — this installer uses --user units"
need loginctl "part of systemd; needed for linger / boot autostart"
# sqlite3 CLI is OPTIONAL: runtime uses the better-sqlite3 native module; only the
# one-off v1 migration importer shells out to the CLI.
command -v sqlite3 >/dev/null 2>&1 || warn "sqlite3 CLI not found (optional — only the v1 migration importer needs it)"
if ! command -v claude >/dev/null 2>&1; then
  warn "claude CLI not found — agents cannot run without it. Install Claude Code and 'claude login' (or set CLAUDE_CODE_OAUTH_TOKEN) before starting agents."
fi
# better-sqlite3 compiles from source when no prebuilt binary matches this Node/arch
# (odd Node version, musl/Alpine, some ARM). That needs a C toolchain — warn, don't fail.
if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
  warn "no C compiler found — if better-sqlite3 has no prebuilt for this Node/arch, the build fails."
  warn "  Install if needed: sudo apt install -y build-essential python3"
fi
# systemd --user must actually be usable (the binary can exist while the user
# instance / D-Bus session is not running — common on fresh headless containers).
if command -v systemctl >/dev/null 2>&1 && ! systemctl --user show-environment >/dev/null 2>&1; then
  warn "systemd --user is not available in this session (no user instance / D-Bus)."
  warn "  On a container, enable lingering systemd --user or run inside a real user session."
  MISSING=1
fi
[ "${MISSING:-0}" = "1" ] && { warn "install/enable the items above, then re-run."; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ] || [ "$NODE_MAJOR" -gt 22 ]; then
  warn "Node $NODE_MAJOR detected; recommended 20-22 (better-sqlite3 prebuilds)."
fi

# ---- 2. build ---------------------------------------------------------------
say "Installing dependencies ($INSTALL_DIR)"
cd "$INSTALL_DIR"
# --include=dev: `build` is tsc (a devDependency); without this a shell with
# NODE_ENV=production would omit it and the build fails with "tsc: not found".
if [ -f package-lock.json ]; then npm ci --include=dev --no-audit --no-fund; else npm install --include=dev --no-audit --no-fund; fi
say "Building (tsc -> dist/)"
npm run build

say "Installing the office-say / office-tune / office-backlog helpers -> ~/.local/bin/"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$INSTALL_DIR/scripts/office-say.sh" "$HOME/.local/bin/office-say"
install -m 0755 "$INSTALL_DIR/scripts/office-tune.sh" "$HOME/.local/bin/office-tune"
install -m 0755 "$INSTALL_DIR/scripts/office-backlog.sh" "$HOME/.local/bin/office-backlog"

# ---- 3. tenant skeleton -----------------------------------------------------
say "Preparing tenant root: $TENANT_ROOT"
mkdir -p "$TENANT_ROOT"/{store,agents,secrets/slack,scheduled-tasks,skills,config}
chmod 700 "$TENANT_ROOT/secrets"
if [ ! -f "$TENANT_ROOT/config/overrides.json" ]; then
  if [ -f "$INSTALL_DIR/tenant/config/overrides.example.json" ]; then
    cp "$INSTALL_DIR/tenant/config/overrides.example.json" "$TENANT_ROOT/config/overrides.json"
    say "seeded tenant/config/overrides.json from example — EDIT it (owner, channel, slackUserId)"
  fi
fi

# ---- 3b. dashboard bind: localhost vs LAN -----------------------------------
# Default 127.0.0.1 (safe — only this machine / SSH tunnel). LAN (0.0.0.0) lets
# any device on the home network reach it (phone, laptop). Choose via prompt when
# interactive, or non-interactively with OFFICE_BIND=localhost|lan.
BIND_HOST="127.0.0.1"
case "${OFFICE_BIND:-}" in
  lan|LAN|0.0.0.0) BIND_HOST="0.0.0.0" ;;
  localhost|127.0.0.1) BIND_HOST="127.0.0.1" ;;
  "")
    if [ -t 0 ]; then
      printf '\nWhere should the dashboard be reachable?\n'
      printf '  [1] Only this machine (localhost, 127.0.0.1)   [recommended, safer]\n'
      printf '  [2] The local network too (LAN, 0.0.0.0)        — phone/laptop can reach it\n'
      read -r -p 'Choice [1]: ' ans
      [ "$ans" = "2" ] && BIND_HOST="0.0.0.0"
    else
      warn "no tty — dashboard will bind localhost only (for LAN access re-run with OFFICE_BIND=lan)"
    fi
    ;;
  *) warn "unrecognized OFFICE_BIND='$OFFICE_BIND' — defaulting to localhost" ;;
esac
if [ "$BIND_HOST" = "0.0.0.0" ]; then
  warn "LAN MODE: the dashboard will be reachable by ANY device on your network."
  warn "  Data stays protected by the dashboard token, but the page shell loads without it."
  warn "  The token IS the password — keep it private, and don't do this on untrusted/guest WiFi."
  warn "  If running behind a reverse proxy (like Nginx), you MUST add: proxy_set_header X-Forwarded-For \$remote_addr;"
fi

# ---- 4. systemd --user units ------------------------------------------------
say "Installing systemd --user units"
mkdir -p "$UNIT_DIR"
NODE_BIN="$(command -v node)"
TMUX_BIN="$(command -v tmux)"

cat > "$UNIT_DIR/theoffice-tmux.service" <<EOF
[Unit]
Description=The Office — dedicated tmux server (isolated fleet, own cgroup)

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$TMUX_BIN -L $SOCKET new-session -d -s __keepalive sleep 86400
ExecStop=$TMUX_BIN -L $SOCKET kill-server
Environment=TZ=$TZ_VALUE

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DIR/theoffice.service" <<EOF
[Unit]
Description=The Office — engine (dashboard + slack ingest + scheduler + bus)
After=theoffice-tmux.service
Wants=theoffice-tmux.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=TZ=$TZ_VALUE
Environment=OFFICE_TENANT_ROOT=$TENANT_ROOT
Environment=OFFICE_TMUX_SOCKET=$SOCKET
Environment=OFFICE_HOST=$BIND_HOST

[Install]
WantedBy=default.target
EOF

# ---- 5. enable + start ------------------------------------------------------
# Linger lets the user's systemd instance (user@<uid>.service) start at boot
# WITHOUT an interactive login — otherwise the fleet only comes up when someone
# logs in. enable-linger is privileged (polkit/root), so the plain call silently
# fails under `curl | bash` (no tty). Try sudo first, then verify, then shout.
say "Enabling linger (so the fleet starts at boot, without login)"
if [ "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null)" = "yes" ]; then
  say "linger already enabled"
else
  # enable-linger needs root/polkit; try passwordless sudo, then interactive, then plain.
  if sudo -n loginctl enable-linger "$USER_NAME" 2>/dev/null \
     || sudo loginctl enable-linger "$USER_NAME" 2>/dev/null \
     || loginctl enable-linger "$USER_NAME" 2>/dev/null; then :; fi
fi
# verify — do NOT continue silently if it failed
if [ "$(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null)" != "yes" ]; then
  warn "LINGER IS STILL OFF. The fleet will NOT start at boot until you run:"
  warn "    sudo loginctl enable-linger $USER_NAME"
  warn "Verify with: loginctl show-user $USER_NAME | grep Linger   # want: Linger=yes"
fi

say "Starting services"
systemctl --user daemon-reload
systemctl --user enable --now theoffice-tmux.service
systemctl --user enable --now theoffice.service

# Wait for the engine to write its token rather than racing a fixed sleep on a slow box.
TOKEN_FILE="$TENANT_ROOT/store/.dashboard-token"
for _ in $(seq 1 20); do [ -f "$TOKEN_FILE" ] && break; sleep 0.5; done

# OFFICE_PORT wins (config.ts honors it), then overrides.json, then default. Pass the
# tenant path via the env (not string-interpolated) so odd paths can't break the JS.
PORT="${OFFICE_PORT:-$(OFFICE_TENANT_ROOT="$TENANT_ROOT" node -e "try{const c=require(process.env.OFFICE_TENANT_ROOT+'/config/overrides.json');process.stdout.write(String((c.web&&c.web.port)||3430))}catch{process.stdout.write('3430')}")}"
say "The Office is up."
if [ "$BIND_HOST" = "0.0.0.0" ]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "  Dashboard : http://${LAN_IP:-<this-machine-ip>}:$PORT   (reachable on your LAN)"
else
  echo "  Dashboard : http://127.0.0.1:$PORT   (this machine only)"
fi
if [ -f "$TOKEN_FILE" ]; then
  echo "  API token : $(cat "$TOKEN_FILE")"
  echo "              ^ secret (also stored in $TOKEN_FILE) — keep it private; it's the dashboard password"
else
  warn "dashboard token not written yet — find it later in $TOKEN_FILE"
fi
echo "  Logs      : journalctl --user -u theoffice.service -f"
echo "  Next      : edit $TENANT_ROOT/config/overrides.json, add agents under tenant/agents/<id>/,"
echo "              and per-agent Slack tokens under tenant/secrets/slack/<id>.json (see docs/CHANNELS-SETUP.md)."
