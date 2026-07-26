import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlackFile } from "./slack-ingest.js";
import { log } from "../logger.js";

const logger = log("slack-files");

// P1#10: cap attachment downloads so a huge file can't exhaust disk/memory on the box. Slack's own
// upload ceiling is ~1GB; we only ever want small docs/images an agent can actually read, so 50MB is
// generous. Enforced from the Content-Length header BEFORE reading the body.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The bot token is attached to the download URL, so only ever send it to a Slack host — a hostile
 *  url_private (Slack-supplied field) must not be able to exfiltrate the bot token to another origin. */
export function isSlackHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "slack.com" || h.endsWith(".slack.com");
  } catch {
    return false;
  }
}

export interface DownloadedFile {
  name: string;
  path: string;
  mimetype: string;
  ok: boolean;
}

/**
 * Download Slack-attached files to the agent's local inbox so its `claude`
 * session can open them with the Read tool. The private download URL requires
 * the bot token AND the `files:read` scope; without that scope Slack returns an
 * HTML login page (not the bytes), which we detect and mark ok=false so the
 * agent can be told the attachment couldn't be fetched instead of failing silent.
 */
export async function downloadFiles(
  files: SlackFile[],
  botToken: string,
  destDir: string,
  tsPrefix: string
): Promise<DownloadedFile[]> {
  if (files.length === 0) return [];
  mkdirSync(destDir, { recursive: true });
  const out: DownloadedFile[] = [];
  for (const f of files) {
    const safe = (f.name || f.id).replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(destDir, `${tsPrefix}-${safe}`);
    let ok = false;
    const url = f.urlPrivateDownload;
    if (url && !isSlackHost(url)) {
      // Never attach the bot token to a non-Slack host (defense-in-depth on a Slack-supplied URL).
      logger.warn({ file: f.name }, "refusing file download from non-Slack host");
    } else if (url) {
      try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
        const ct = resp.headers.get("content-type") || "";
        const len = Number(resp.headers.get("content-length") || 0);
        // Reject oversize attachments by Content-Length BEFORE reading the body (don't buffer 100s of MB).
        if (Number.isFinite(len) && len > MAX_FILE_BYTES) {
          logger.warn({ file: f.name, bytes: len, capMB: MAX_FILE_BYTES / 1024 / 1024 }, "file too large -> skipped");
        } else if (resp.ok && !ct.includes("text/html")) {
          // Slack serves text/html (a login page) when the token lacks files:read.
          const bytes = Buffer.from(await resp.arrayBuffer());
          // Defensive: honor the cap even when Content-Length was absent/lied.
          if (bytes.length > MAX_FILE_BYTES) {
            logger.warn({ file: f.name, bytes: bytes.length, capMB: MAX_FILE_BYTES / 1024 / 1024 }, "file too large (post-read) -> skipped");
          } else {
            writeFileSync(path, bytes, { mode: 0o600 });
            ok = true;
          }
        } else {
          logger.warn({ file: f.name, status: resp.status, ct }, "file download not ok (missing files:read scope?)");
        }
      } catch (err) {
        logger.warn({ file: f.name, err }, "file download failed");
      }
    } else {
      logger.warn({ file: f.name }, "file has no private download url");
    }
    out.push({ name: f.name, path, mimetype: f.mimetype, ok });
  }
  return out;
}
