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
