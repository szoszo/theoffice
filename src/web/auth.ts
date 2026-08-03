import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Load the dashboard API token, generating a 0600 one on first run. */
export function getOrCreateToken(file: string): string {
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const tok = randomBytes(32).toString("hex");
  writeFileSync(file, tok, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return tok;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Validate an `Authorization: Bearer <token>` header against the dashboard token. */
export function checkBearer(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m != null && safeEqual(m[1]!.trim(), token);
}

/** Name of the httpOnly session cookie the login form sets. */
export const SESSION_COOKIE = "office_session";

/**
 * Is this connection from the local machine?
 *
 * MUST be given `req.socket.remoteAddress` and NEVER an X-Forwarded-For value: the whole point is
 * that it cannot be asserted by the client. Anchored matching, because a substring test would
 * accept "127.0.0.1.evil.com".
 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr; // v4-mapped from a dual-stack socket
  if (a === "::1") return true;
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255) && Number(m[1]) === 127;
}

/** Parse a Cookie header into a plain object. Never throws on malformed input. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Validate the session cookie against the dashboard token. */
export function checkCookieAuth(cookieHeader: string | undefined, token: string): boolean {
  const v = parseCookies(cookieHeader)[SESSION_COOKIE];
  return !!v && safeEqual(v, token);
}
