import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The REAL context size of an exec-runtime conversation, as opposed to the per-turn usage totals.
 *
 * Why separate: a turn with tools makes many model calls and each re-sends the whole context, so the CLI's
 * per-turn usage is a SUM over the calls (a heat turn reported 3.5M "input" for a ~120k context). Summed
 * usage is the right number for consumption stats and the wrong one for "how full is the context".
 * The size of the context is the prompt of the LAST model call.
 *
 * Both readers return null when the figure cannot be read reliably; the caller then reports "n/a" and falls
 * back to a turn-count roll-over instead of inventing a number.
 */
export interface ContextReading {
  tokens: number;
  /** the model's context window as reported by the CLI itself; 0 = not reported */
  window: number;
}

// ---- gemini (agy): ~/.gemini/antigravity-cli/conversations/<id>.db, table gen_metadata (one protobuf per model call)

function varint(b: Buffer, i: number): [number, number] {
  let r = 0;
  let mul = 1;
  for (;;) {
    if (i >= b.length) throw new Error("truncated");
    const c = b[i++]!;
    r += (c & 0x7f) * mul;
    mul *= 128;
    if (!(c & 0x80)) return [r, i];
  }
}

/** Minimal protobuf field walk: field number -> list of values (varint as number, length-delimited as Buffer). */
export function pbFields(b: Buffer): Map<number, (number | Buffer)[]> {
  const out = new Map<number, (number | Buffer)[]>();
  let i = 0;
  while (i < b.length) {
    let k: number;
    [k, i] = varint(b, i);
    const f = Math.floor(k / 8);
    const w = k % 8;
    let v: number | Buffer;
    if (w === 0) [v, i] = varint(b, i);
    else if (w === 2) {
      let l: number;
      [l, i] = varint(b, i);
      if (i + l > b.length) throw new Error("bad length");
      v = b.subarray(i, i + l);
      i += l;
    } else if (w === 1) {
      v = b.subarray(i, i + 8);
      i += 8;
    } else if (w === 5) {
      v = b.subarray(i, i + 4);
      i += 4;
    } else throw new Error("bad wire type");
    (out.get(f) ?? out.set(f, []).get(f)!).push(v);
  }
  return out;
}

const first = (m: Map<number, (number | Buffer)[]>, f: number) => m.get(f)?.[0];
const asNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Decode one gen_metadata blob. Layout, measured on real agy conversations (2026-10-30): field 1 holds the
 * call record; its field 4 is the usage {2: uncached input, 5: cache-read input, ...} and its field 9.10 is
 * agy's own context meter {1: used, 4: window}. Sum(2)+Sum(5) over all calls equalled the CLI's per-turn
 * `usage.input_tokens` total to the token, which is how field 2/5 were identified. Context = prompt of the call
 * = uncached + cache-read.
 */
export function decodeGeminiCall(blob: Buffer): ContextReading | null {
  try {
    const rec = first(pbFields(blob), 1);
    if (!Buffer.isBuffer(rec)) return null;
    const r = pbFields(rec);
    const usage = first(r, 4);
    if (!Buffer.isBuffer(usage)) return null; // not a model-call row
    const u = pbFields(usage);
    const tokens = asNum(first(u, 2)) + asNum(first(u, 5));
    if (tokens <= 0) return null;
    let window = 0;
    const g9 = first(r, 9);
    if (Buffer.isBuffer(g9)) {
      const g10 = first(pbFields(g9), 10);
      if (Buffer.isBuffer(g10)) window = asNum(first(pbFields(g10), 4));
    }
    return { tokens, window };
  } catch {
    return null;
  }
}

export function agyConversationDb(conversationId: string): string {
  return join(process.env.HOME ?? homedir(), ".gemini", "antigravity-cli", "conversations", `${conversationId}.db`);
}

export function readGeminiContext(conversationId: string, dbPath = agyConversationDb(conversationId)): ContextReading | null {
  if (!/^[A-Za-z0-9-]+$/.test(conversationId) || !existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // newest model-call row wins; non-call rows (no usage field) decode to null and are skipped
    const rows = db.prepare(`SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 8`).all() as { data: Buffer }[];
    for (const r of rows) {
      const c = Buffer.isBuffer(r.data) ? decodeGeminiCall(r.data) : null;
      if (c) return sane(c);
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- codex: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl, last token_count event

/** Pull {last_token_usage.input_tokens, model_context_window} out of a rollout JSONL tail (newest event wins). */
export function parseCodexRollout(text: string): ContextReading | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!.trim();
    if (!ln.includes("token_count")) continue;
    try {
      const o = JSON.parse(ln);
      const p = o?.payload ?? o;
      if (p?.type !== "token_count") continue;
      const last = p.info?.last_token_usage;
      const tokens = asNum(last?.input_tokens); // codex counts cached input inside input_tokens
      if (tokens > 0) return sane({ tokens, window: asNum(p.info?.model_context_window) });
    } catch {
      /* partial / non-JSON line */
    }
  }
  return null;
}

function findRollout(threadId: string, home = process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), ".codex")): string | null {
  const root = join(home, "sessions");
  if (!/^[A-Za-z0-9-]+$/.test(threadId) || !existsSync(root)) return null;
  const walk = (dir: string, depth: number): string | null => {
    let names: string[];
    try {
      names = readdirSync(dir).sort().reverse(); // newest dates first
    } catch {
      return null;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (depth === 3) {
        if (n.endsWith(`${threadId}.jsonl`)) return p;
      } else {
        try {
          if (!statSync(p).isDirectory()) continue;
        } catch {
          continue;
        }
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root, 0);
}

export function readCodexContext(threadId: string, home?: string): ContextReading | null {
  try {
    const file = findRollout(threadId, home);
    if (!file) return null;
    const size = statSync(file).size;
    const len = Math.min(size, 512 * 1024);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return parseCodexRollout(buf.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Reject readings that cannot be right (a context larger than ~1.2x its own window, or absurdly large). */
function sane(c: ContextReading): ContextReading | null {
  if (c.tokens <= 0 || c.tokens > 20_000_000) return null;
  if (c.window > 0 && c.tokens > c.window * 1.2) return null;
  return c;
}
