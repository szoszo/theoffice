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
2. Render the units like the other watchdogs (replace `@ROOT@`, `@TENANT@`, `@TZ@`) into `~/.config/systemd/user/`, then `systemctl --user daemon-reload` and enable `captain-detect.timer`, `captain-router.service`, `captain-selftest.timer`, `captain-skills.timer`, `captain-guard.timer`.
3. Run `python3 tools/captain/captain.py selftest`, then a drill with the force file.

## Tests
`cd tools/captain && python3 -m unittest discover -s tests -v` (stdlib only, no network, no real tenant).
