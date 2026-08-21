// Auth watchdog — notices the fleet has lost its Claude login and TELLS THE OWNER, unprompted.
//
// The 2026-07-25 outage was silent: every agent was signed out for ~20 minutes and nothing anywhere
// said so. The dashboard was green, and the agents themselves obviously couldn't report the problem —
// they were the thing that was broken.
//
// The engine is the right place for this because it is the ONE component that keeps working during a
// Claude auth outage: the Slack sender posts through the agents' bot tokens (Slack credentials), which
// have nothing to do with the Claude credential. So the engine can still speak even when no agent can.
//
// Two jobs:
//   1. ALERT — DM the owner (as the main agent's bot) when the credential expires, is close to
//      expiring, or panes are found signed out. Rate-limited so it never becomes a pager storm.
//   2. SELF-HEAL — when the credential is VALID but panes are stale (the exact "a restart would fix
//      this" case), quietly restart those panes. That is the one failure mode that needs no human.

import type { EngineConfig } from "../types.js";
import { enqueueOutbound } from "../queue/index.js";
import { getAuthHealth, restartSignedOutAgents, formatDuration } from "./claude-auth.js";
import { log } from "../logger.js";

const logger = log("auth-watchdog");

const CHECK_MS = 5 * 60 * 1000;
/** Re-alert cadence, per severity. Hard-down states (expired / no-credential / panes signed out)
 *  page HOURLY until fixed — the fleet is mute, the owner needs nagging. But the non-urgent
 *  "expiring-soon" heads-up (nothing is broken, days of runway) re-alerts at most ONCE A DAY so it
 *  can never become the hourly spam that went out 2:57/3:57/4:57… A status change still alerts
 *  immediately, so a degrade from expiring-soon → hard-down pages at once regardless of this window. */
const REALERT_MS_URGENT = 60 * 60 * 1000;
const REALERT_MS_EXPIRING = 24 * 60 * 60 * 1000;
/** Self-heal is capped so a genuinely broken agent can't be restart-looped forever. */
const HEAL_COOLDOWN_MS = 10 * 60 * 1000;

export function startAuthWatchdog(cfg: EngineConfig): () => void {
  let stopped = false;
  let lastAlertStatus = "";
  let lastAlertAt = 0;
  let lastHealAt = 0;

  const alert = (text: string) => {
    const channel = cfg.owner.slackUserId;
    if (!channel) {
      logger.error("no owner slack id configured — cannot alert about auth");
      return;
    }
    try {
      enqueueOutbound(cfg.mainAgentId, channel, text);
    } catch (err) {
      logger.error({ err }, "could not enqueue auth alert");
    }
  };

  const tick = () => {
    if (stopped) return;
    let health;
    try {
      health = getAuthHealth(cfg);
    } catch (err) {
      logger.error({ err }, "auth health check failed");
      return;
    }

    if (health.ok) {
      // Recovered — allow the next incident to alert immediately.
      if (lastAlertStatus) logger.info("auth healthy again");
      lastAlertStatus = "";
      return;
    }

    const now = Date.now();

    // --- self-heal: credential good, panes stale. No human needed. ---
    if (health.restartWouldFix && now - lastHealAt > HEAL_COOLDOWN_MS) {
      lastHealAt = now;
      logger.warn({ count: health.signedOutCount }, "auth-watchdog: credential valid but panes signed out — self-healing");
      const r = restartSignedOutAgents(cfg);
      alert(
        `🔧 Auto-repair: ${r.restarted.length} agent(s) were still signed out even though the Claude login is valid. ` +
          `I restarted them (${r.restarted.join(", ") || "none"}). No action needed from you.` +
          (r.failed.length ? `\n⚠️ Could NOT restart: ${r.failed.join(", ")}` : ""),
      );
      return;
    }

    // --- alert: needs the owner to actually sign in ---
    const realertMs = health.status === "expiring-soon" ? REALERT_MS_EXPIRING : REALERT_MS_URGENT;
    const shouldAlert = health.status !== lastAlertStatus || now - lastAlertAt > realertMs;
    if (!shouldAlert) return;
    lastAlertStatus = health.status;
    lastAlertAt = now;

    if (health.status === "expiring-soon") {
      alert(
        `⏳ Heads up: the fleet's Claude login must be renewed within ${formatDuration(health.credential.refreshExpiresInSec ?? 0)}.\n` +
          `Nothing is broken yet. Open the dashboard → **Sign in to Claude** at a moment that suits you — ` +
          `if it lapses instead, every agent goes silent at once.`,
      );
    } else {
      alert(
        `🔴 THE FLEET CANNOT AUTHENTICATE — ${health.message}\n\n` +
          `No agent can answer you until this is fixed. You do NOT need a terminal:\n` +
          `open the dashboard → red **Sign in to Claude** banner → follow the link → paste the code.\n` +
          `Everything restarts automatically afterwards.`,
      );
    }
    logger.error({ status: health.status }, "auth-watchdog: alerted owner");
  };

  // Give the fleet a moment to settle after boot before the first judgement.
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, CHECK_MS);
  logger.info("auth watchdog started");
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
