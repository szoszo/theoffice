# The Office

A clean, self-hostable **AI agent back-office engine**. Run a team of Claude-powered agents that
talk to you on **Slack**, remember things, run scheduled work, and delegate to each other — each
agent a distinct colleague you DM directly.

## Install (fresh Debian/Ubuntu server)

```bash
curl -fsSL https://raw.githubusercontent.com/szoszo/theoffice/main/bootstrap.sh | bash
```

Run it as your normal user (it `sudo`s only for apt). It installs all dependencies (Node, tmux,
sqlite3, git, Claude Code), the engine, and a **clean empty tenant** (no agents/data of anyone
else's) — then launches a guided wizard that helps you create your main agent, wire it to Slack,
and bring it online. Your main agent then introduces itself and offers to build out your team.

## Why it's stable

It keeps the **flat-rate** interactive `claude` runtime (tmux, under your Claude subscription — not
the metered SDK), but earns reliability from two structural choices:

1. **The channel is decoupled from the TUI.** A standalone Slack ingest daemon feeds a durable
   queue; the `claude` sessions are *pure* (no channel plugin inside). Agents reply via the Slack
   Web API. This removes plugin-timeout / poller-conflict / reconnect failure classes.
2. **One inbound queue, one deliverer.** Exactly one component types into any tmux pane, with
   idempotent submit — no "parked draft" / double-writer races.

## Architecture (three layers)

- **Platform** — this engine (`src/`). Identical on every install.
- **Product** — optional defaults (personas, skills, scheduled tasks).
- **Tenant** — one install's agents + data + secrets under a single writable `tenant/`, never
  committed to git, never overwritten by an update. Effective config = `deepMerge(platform, product, tenant)`.

## What you get

- **Per-agent Slack identities** — DM each agent directly; replies come back as that agent.
- **Memory** (tiers + FTS search), **kanban**, **scheduler** (cron), **inter-agent bus**, heartbeats.
- **Semantic recall** — agents also search memory by *meaning*, not just keywords, so a fact saved
  once is found however the question is phrased. Optional (needs a local Ollama); keyword search
  works with no setup at all. Setup + `npm run memory:status` in
  [`docs/MEMORY-SEMANTIC-RECALL.md`](docs/MEMORY-SEMANTIC-RECALL.md).
- **Web dashboard** (`:3430`) — agents (live state, model, security profile), memory browser with
  tier filters, a real kanban board, human-readable schedules, token-usage by time window, live
  controls (set an agent's model, restart/start/stop, enable/disable, move/archive kanban cards), and
  built-in IP-based brute-force rate limiting. (Security note: on direct LAN access bypassing nginx, X-Forwarded-For can be spoofed; public access via nginx is secure since it overwrites the header.)
- **Per-agent model & thinking effort** — pin either per agent; the pin survives restarts, and
  switching applies to the *running* session, so the agent keeps its conversation. Settable from the
  dashboard or by just asking the agent on Slack. See
  [`docs/MODEL-AND-EFFORT.md`](docs/MODEL-AND-EFFORT.md).
- **Per-agent security profiles** — restrict which connectors/files an agent can touch (e.g. a
  shared agent that can't reach your email or finances).

## Adding agents

Your main agent guides you, or see [`docs/CHANNELS-SETUP.md`](docs/CHANNELS-SETUP.md) for the
per-agent Slack setup. Under the hood: `scripts/new-agent.sh <id> "<name>" "<role>" <xapp> <xoxb>`.

## Dev

```bash
npm install
npm run typecheck
npm test
OFFICE_TENANT_ROOT=./tenant npm run dev
```

Config/env overrides are all `OFFICE_*` (e.g. `OFFICE_TENANT_ROOT`, `OFFICE_PORT`, `OFFICE_TMUX_SOCKET`,
`OFFICE_EXTRA_PORTS`). MIT licensed.
