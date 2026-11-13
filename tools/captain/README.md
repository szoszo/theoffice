# Emergency captain

When Claude is out (usage limit, expired login, provider outage), a **captain agent** on a second runtime (Codex) takes the con automatically. When Claude is back, the **primary agent** takes it back. No AI runs in the detector or the router: every signal is read from files, tmux panes, the engine API and the provider's status page.

## What runs
| Piece | Unit | What it does |
|---|---|---|
| `captain.py detect` | `captain-detect.timer` (5 min) | Is Claude out? Needs two bad checks in a row (three for a status-page-only hint). On the switch: writes `store/outage.json`, sends ONE owner line, writes the announcement, regenerates the captain's `AGENTS.md` block, turns on the outage-only MCPs, wakes the captain. On recovery: reverts switched agents, writes the outage log, tells both agents. |
| `captain.py route` | `captain-router.service` | During an outage re-addresses the owner's DMs and the primary agent's scheduled tasks (and the covered agents' scheduled and manual tasks) to the captain. Idle otherwise. |
| `captain.py switch/unswitch <agent>` | on demand | The captain moves ONE more agent to Codex (max `max_switched`, never `never_switch`, only during an outage) and back. |
| `captain.py selftest` | `captain-selftest.timer` (weekly) | One harmless read per configured tool path; results in `store/captain-selftest.json`; failing checks become gaps in the captain's block. |
| `skills_sync.py` | `captain-skills.timer` (30 min) | Copies the primary runtime's skills into the captain's, adding a note where a skill names tools the captain does not have. |
| `captain.py guard` | `captain-guard.timer` (nightly) | Tells the infra agent when `tools/captain` differs from its last commit. |
| `captain.py prefix <agent>` | a say hook | Puts `Emergency captain (<name>):` on every captain message during an outage, removes a hand-typed one outside it. |

Drill: `echo outage > store/captain-force` makes the detector treat it as an outage; delete the file to end the drill.

## Configuration
Everything that names an agent, person, path, connector or tool lives in **`$OFFICE_TENANT_ROOT/config/captain.json`** (`CAPTAIN_CONFIG` overrides the path). That file is tenant data: do not commit it. `captain.example.json` shows every key; `cfg.py` holds the defaults. The owner's chat user and timezone fall back to `config/overrides.json` (`owner.slackUserId`, `owner.timezone`). Relative paths in the config are relative to the tenant root.

Tenant text the captain reads verbatim goes in two small files named by the config: `fleet_cover_file` (the per-agent routes it uses when it acts for the fleet) and `gap_text_file` (which tools work in an outage). Keep credentials out of them: name the file or variable, never the value.

## Install (opt in)
The units are in `templates/units/captain/` (not in the default install, because they do nothing useful until a captain agent and a config exist).
1. Create the captain agent (a Codex-runtime agent) and write `config/captain.json`.
2. Render the units like the other watchdogs (replace `@ROOT@`, `@TENANT@`, `@TZ@`) into `~/.config/systemd/user/`, then `systemctl --user daemon-reload` and enable `captain-detect.timer`, `captain-router.service`, `captain-selftest.timer`, `captain-skills.timer`, `captain-guard.timer` (and `captain-backup-sync.timer` when you use the backup account tier below).
3. Run `python3 tools/captain/captain.py selftest`, then a drill with the force file.

## Tests
`cd tools/captain && python3 -m unittest discover -s tests -v` (stdlib only, no network, no real tenant).

## Backup account tier (usage limit without a takeover)
When the MAIN Claude account hits its usage limit (modal on two panes, or the engine's quota window at 100%) and a backup login is available, the configured agents (lean mode: only the primary agent) move to a BACKUP account instead of the whole fleet going to the second runtime. A provider or login problem still means the takeover, and so does the backup running out too (its pane shows the limit modal twice in a row).
- Config (inside the `backup` key): the `backup` key of `config/captain.json` (tenant data, never committed): `{"enabled": true, "agents": ["main"], "config_dir": "store/claude-backup-cfg", "main_dir": "~/.claude", "main_json": "~/.claude.json", "ssh": {"host": "...", "login": "root", "key": "secrets/.../key", "user": "<user that owns the login>", "known_hosts": "secrets/.../known_hosts", "creds_path": "/home/<user>/.claude/.credentials.json"}}`.
- The backup login is an existing login file on another host, read over ssh and copied into a separate `CLAUDE_CONFIG_DIR` that only the switched agents see through their own `.env` (a marked block). The main credentials are never touched. The config dir symlinks the main one (skills, hooks, settings, projects) so sessions resume; it holds its own `.credentials.json` and a `.claude.json` copied without the main account.
- Refresh tokens rotate: while on backup the file is re-synced every 30 minutes; a copy with a later expiry (we refreshed) is pushed back so neither side keeps a dead token. `claude auth status` on the remote is checked after every sync.
- Back to main after two clean readings of the main quota (fresh data, both windows below the limit): final sync, the `.env` block removed, the local copy deleted, one owner line.
- Every switch is logged to `store/backup-periods.jsonl` so usage reports can keep backup periods out of the main account's weekly percentage.
- Drill: `captain.py backup-on <agent>` / `captain.py backup-off <agent>` move an idle agent by hand without touching the outage state.
- No agent is in the loop: the detector timer decides, `captain.py` pulls the login, restarts the agents on it and tells the owner. If the switch fails or an agent still shows the limit screen after its restart, the takeover starts in the SAME tick. The login re-sync is its own timer (`captain.py backup-sync` every 30 minutes, a no-op unless the backup is in use). The weekly selftest dry-runs the whole path (read the remote login, check it, seed a throwaway dir) without switching anything.
- Security notes: the ssh host key is pinned (`StrictHostKeyChecking=yes` with the `known_hosts` file from the config; create it once with `ssh-keyscan` and check the fingerprint). The remote login file is written with `umask 077` and replaced atomically. The ssh login is whatever the config names; prefer a dedicated restricted user (or a forced command that only reads/writes that one file) over root. A switch-back whose last push cannot be confirmed keeps the local login and retries from the sync timer, so a refreshed token is never the only copy that gets deleted.
