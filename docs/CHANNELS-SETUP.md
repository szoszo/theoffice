# Channel setup — per-agent Slack identities

Each agent is its own Slack bot, so the owner can DM **@Charly** (CFO) or **@Lenny**
(Logistics) directly and get a reply *as that colleague*. One ingest daemon owns
exactly one Socket-Mode connection per agent-app, so there is no event-splitting.

## Two entry paths: DM and channel @-mention

The ingest accepts a human message on two paths (`src/channel/slack-ingest.ts`):

- **DM** — a `message` event with `channel_type: "im"`. The agent replies to
  *everything* you DM it. This is the original behaviour.
- **Channel @-mention** — an `app_mention` event. In a shared channel an agent
  reacts **only when it is explicitly @-mentioned** (so it never jumps into
  unrelated chatter). The leading `<@BOT>` / `<@BOT|label>` is stripped before the
  text reaches the agent, and the reply goes **back to the channel** (the reply
  channel is the channel id, so `office-say` posts there, not into a DM).

> A *plain* (non-mention) channel message is still ignored on purpose, even if the
> app later gains `channels:history` — channels are reached exclusively through
> `app_mention`. Replies are channel-level in v1, not threaded.

### To turn channel mentions on for an agent (owner, per Slack app)

1. **OAuth & Permissions** → Bot Token Scopes → add `app_mentions:read`.
2. **Event Subscriptions** → Subscribe to bot events → add `app_mention`.
3. **Reinstall to Workspace** (scope change requires it). If a new `xoxb-…` token
   is issued, update `tenant/secrets/slack/<id>.json`.
4. In the target channel, invite the bot: `/invite @AgentName`. A bot that is not a
   member of the channel receives **no** `app_mention` events.

### Verify

```
# scopes actually granted to the bot token (look for app_mentions:read)
curl -sD - -o /dev/null -XPOST https://slack.com/api/auth.test \
  -H "Authorization: Bearer $(node -e 'console.log(require("./tenant/secrets/slack/<id>.json").botToken)')" | grep -i x-oauth-scopes

# channels the bot is a member of
curl -s -XPOST 'https://slack.com/api/users.conversations?types=public_channel,private_channel' \
  -H "Authorization: Bearer <xoxb>"
```

Then `@AgentName hello` in the channel → the engine log shows
`inbound channel mention enqueued` and the agent replies in the channel.

## Per agent (one Slack app each)

1. Create a Slack app (https://api.slack.com/apps → From scratch), name it like the
   agent ("Charly"), set its display name + avatar (the persona's face).
2. **Socket Mode** → Enable. Generate an **App-Level Token** (`xapp-…`) with scope
   `connections:write`.
3. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `im:history`,
   `im:read`, `im:write`, `users:read`, `files:read`, `files:write` (`files:read`
   lets the agent open images/PDFs you send it; `files:write` lets it send files
   back. Add `channels:history`/`app_mentions:read` if the agent should also listen
   in channels). Install to workspace → copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Event Subscriptions** → Enable, subscribe to bot events: `message.im`
   (and `app_mention` if used).
5. Note the bot's user id (`U…`) from "OAuth & Permissions" / `auth.test`.

> For a product/customer box this whole step is scripted from an app **manifest**
> in the installer (Phase 6) — you don't do it by hand per customer.

### App manifest (paste under "From an app manifest") — replace the two names

CRITICAL: `app_home.messages_tab_enabled` + `messages_tab_read_only_enabled:false`
MUST be set, or Slack shows "sending messages to this app has been turned off" and
the owner can't DM the agent.

```json
{
  "display_information": { "name": "Michael Scott", "description": "back office colleague" },
  "features": {
    "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
    "bot_user": { "display_name": "Michael Scott", "always_online": true }
  },
  "oauth_config": {
    "scopes": { "bot": ["chat:write", "im:history", "im:read", "im:write", "users:read", "files:read", "files:write", "app_mentions:read"] }
  },
  "settings": {
    "event_subscriptions": { "bot_events": ["message.im", "app_mention"] },
    "interactivity": { "is_enabled": false },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

## Files (tenant layer — never in git)

`tenant/agents/<id>/agent.json` — persona metadata (the persona text lives in
`tenant/agents/<id>/CLAUDE.md`):

```json
{ "displayName": "CFO Charly", "model": "claude-sonnet-4-6", "enabled": true }
```

`tenant/secrets/slack/<id>.json` — the agent's Slack identity (gitignored):

```json
{ "appToken": "xapp-…", "botToken": "xoxb-…", "botUserId": "U0000CHARLY" }
```

Enable the channel in `tenant/config/overrides.json`:

```json
{ "channel": { "provider": "slack" }, "owner": { "slackUserId": "U0000OWNER" } }
```

## Flow

owner DMs @Charly → Charly's app Socket-Mode event → ingest enqueues to
`inbound_queue` (dedup by Slack ts) → Session Manager delivers into Charly's pure
`claude` tmux session → Charly replies → `outbound_queue` → sender posts via
Charly's `botToken` (appears as Charly).
