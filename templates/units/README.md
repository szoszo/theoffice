# Watchdog units

Systemd user-unit templates for the reliability tools in `tools/` (rendered and installed by `scripts/install.sh`).
Placeholders: `@ROOT@` (engine checkout), `@TENANT@`, `@TZ@`. install.sh renders them; `OFFICE_WATCHDOGS=core|all|none` (default core) picks which timers are enabled.

Install: copy the `.service`/`.timer` files to `~/.config/systemd/user/`, then
`systemctl --user daemon-reload && systemctl --user enable --now <name>.timer` (oomwatch has no timer: enable the service).

- `owner-watchdog`, `owner-ack-guard`, `drift-detect`, `frozen-pane-alarm`: owner-message delivery and frozen-pane detectors
- `context-watchdog`: auto-compacts idle agents near the context limit (`act.conf` drop-in switches it from detect to act)
- `service-health`, `gh-token-expiry`: health and credential-expiry alarms
- `disk-watch`: free-space watcher (warn under 25% free, critical under 12%, or absolute GB; hysteresis; never deletes); alerts the relay agent over the bus
- `office-data-backup`: nightly encrypted backup (config via `<tenant>/backup.env`: `BACKUP_DRIVE_TOKEN`, optional `BACKUP_APP_DATA`, `BACKUP_D1_DATABASE`)
- `office-embed-backfill`, `modal-sweeper`, `oomwatch`: memory embedding, usage-limit modal sweeper, OOM detector
- `captain/` (opt-in, NOT installed by default): the emergency-captain units (detector, router, selftest, skills sync, guard). See `tools/captain/README.md` for the config and install steps.
