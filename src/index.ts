import { loadConfig } from "./config.js";
import { openDb, closeDb } from "./db/index.js";
import { startDeliverer, launchEnabledAgents } from "./session/session-manager.js";
import { deliverPendingSetupNotices } from "./web/setup-notices.js";
import { startSlackIngest } from "./channel/slack-ingest.js";
import { startSlackSender } from "./channel/slack-send.js";
import { startScheduler } from "./scheduler/index.js";
import { startBus } from "./bus/index.js";
import { startServer } from "./web/server.js";
import { startAuthWatchdog } from "./web/auth-watchdog.js";
import { reapStaleDelivering, reapStaleOutboundSending } from "./queue/index.js";
import { log } from "./logger.js";

const logger = log("boot");

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(
    { tenantRoot: cfg.paths.tenantRoot, port: cfg.web.port, tmuxSocket: cfg.tmux.socket, channel: cfg.channel.provider },
    "the office engine starting"
  );

  openDb(cfg.paths.dbFile);

  const stops: Array<() => void> = [];

  // P0#2: recover any 'delivering' rows orphaned by the previous process death BEFORE the deliverer
  // starts. At this point nothing else writes the queue, so the reset is race-free; without it those
  // rows are lost-on-restart (stuck in 'delivering' forever).
  const reaped = reapStaleDelivering();
  if (reaped.requeued > 0 || reaped.failed > 0)
    logger.warn({ requeued: reaped.requeued, failed: reaped.failed }, "boot reaper: recovered stale 'delivering' rows from prior run");

  // Same recovery for the outbound side: a row left 'sending' by a mid-post process death would be a
  // silently dropped owner message. Requeue it (at-least-once) BEFORE the sender starts. Race-free here.
  const reapedOut = reapStaleOutboundSending();
  if (reapedOut > 0) logger.warn({ requeued: reapedOut }, "boot reaper: requeued stale 'sending' outbound rows from prior run");

  // Phase 2: the single inbound-queue deliverer (only writer to a tmux pane).
  stops.push(startDeliverer(cfg));

  // Phase 2b: bring the fleet up. After a reboot the tmux server is fresh (only
  // __keepalive) and nothing else relaunches agents, so without this the
  // deliverer has no sessions to deliver to and the inbound queue piles up.
  launchEnabledAgents(cfg);

  // Phase 2c: offer any newly-updated capability that needs setup to the main agent
  // (one-time, dismissible) — the deliverer + main session are up, so the queued
  // offer will land. Generic: any capability shipping a tools/<cap>/POST_UPDATE.md.
  deliverPendingSetupNotices(cfg);

  // Phase 3: Slack channel — external ingest + per-agent-identity outbound.
  if (cfg.channel.provider === "slack") {
    stops.push(startSlackIngest(cfg));
    stops.push(startSlackSender(cfg));
  }

  // Phase 4: scheduler (cron -> queue), inter-agent bus, heartbeat-as-injected-
  // prompt (heartbeats are scheduled tasks of type 'heartbeat' — flat-rate, no SDK).
  if (process.env.OFFICE_SCHEDULER_PAUSED)
    logger.warn("OFFICE_SCHEDULER_PAUSED set — scheduler/heartbeats NOT started (incident mode)");
  else
    stops.push(startScheduler(cfg));
  if (process.env.OFFICE_BUS_PAUSED)
    logger.warn("OFFICE_BUS_PAUSED set — inter-agent bus NOT started (incident mode)");
  else
    stops.push(startBus(cfg));

  // Phase 5: dashboard HTTP API + web UI (bearer-auth, localhost-bound).
  stops.push(startServer(cfg));

  // Phase 6: auth watchdog. The engine keeps working through a Claude auth outage (Slack bot tokens
  // are unrelated to the Claude credential), so it is the only thing that can still raise the alarm
  // when every agent has gone silent. Also self-heals stale panes when the credential is actually fine.
  stops.push(startAuthWatchdog(cfg));

  logger.info("boot complete");

  const shutdown = (sig: string) => {
    logger.info({ sig }, "shutting down");
    for (const stop of stops) stop();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
