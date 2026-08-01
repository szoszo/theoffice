import type { QueuedItem } from "./runtime.js";

/**
 * Synthetic system-signal reply_user sentinels: they arrive source='channel' but are NOT from the human
 * owner (the rental ingest exception — OCR + bill triggers). Kept in one set so frameForDelivery, the
 * drift-detector and the stop-guard all agree on what is and isn't an owner message. When you add a new
 * signal type, add its reply_user in ALL THREE places (they live in two repos — this set is the engine
 * copy; the other two are agent-dir scripts OUTSIDE the engine repo):
 *   - tenant/agents/darryl/tools/drift-detector/drift_detect.py   (two queries: delivered + undelivered)
 *   - tenant/agents/marveen/hooks/office-say-stop-guard.py        (the latest-owner-inbound query)
 */
export const SYNTHETIC_SIGNAL_USERS = new Set(["ocr-signal", "bill-signal", "archive-signal"]);

/**
 * Tag a queued item for delivery to the agent. A channel message is normally framed as coming from the
 * owner. The exception is a synthetic system signal (reply_user in SYNTHETIC_SIGNAL_USERS) — it arrives
 * source='channel' but is NOT from the owner, so it is framed as a system signal instead. Non-channel
 * items pass through unwrapped.
 *
 * Lives in its own leaf module (type-only import of QueuedItem, no value edge back into runtime.ts)
 * so the three runtimes can import it without forming a circular dependency with runtime.ts, which
 * imports + registers those runtimes at module load.
 */
export function frameForDelivery(item: QueuedItem): string {
  if (item.source !== "channel") return item.prompt;
  if (item.reply_user && SYNTHETIC_SIGNAL_USERS.has(item.reply_user)) return `[System signal, not from the owner]\n\n${item.prompt}`;
  return `[Slack message from the owner]\n\n${item.prompt}`;
}
