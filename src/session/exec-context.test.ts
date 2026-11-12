import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeGeminiCall, readGeminiContext, parseCodexRollout, readCodexContext } from "./exec-context.js";

// --- tiny protobuf encoder for fixtures (varint + length-delimited)
const vi = (n: number): number[] => {
  const o: number[] = [];
  while (n > 127) {
    o.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  o.push(n);
  return o;
};
const fVar = (f: number, n: number) => Buffer.from([...vi(f * 8), ...vi(n)]);
const fBytes = (f: number, b: Buffer) => Buffer.concat([Buffer.from([...vi(f * 8 + 2), ...vi(b.length)]), b]);

/** one agy gen_metadata row shaped like the real ones: 1 { 4 {2: uncached, 5: cacheRead}, 9 { 10 { 1: meter, 4: window } } } */
const callRow = (uncached: number, cacheRead: number, window = 256000) =>
  fBytes(
    1,
    Buffer.concat([
      fBytes(4, Buffer.concat([fVar(1, 1318), fVar(2, uncached), fVar(5, cacheRead)])),
      fBytes(9, fBytes(10, Buffer.concat([fVar(1, 104488), fVar(4, window)]))),
    ]),
  );
const nonCallRow = () => fBytes(3, fVar(1, 1318));

let tmp: string;
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

describe("gemini context from agy's conversation db", () => {
  it("decodes the last call's prompt (uncached + cache read) and the reported window", () => {
    expect(decodeGeminiCall(callRow(2339, 120448))).toEqual({ tokens: 122787, window: 256000 });
  });
  it("a row without a usage record is not a model call", () => {
    expect(decodeGeminiCall(nonCallRow())).toBeNull();
    expect(decodeGeminiCall(Buffer.from([0xff, 0xff, 0xff]))).toBeNull();
  });
  it("reads the newest model-call row, skipping a trailing non-call row", () => {
    tmp = mkdtempSync(join(tmpdir(), "agy-"));
    const f = join(tmp, "c.db");
    const db = new Database(f);
    db.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)");
    const ins = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    ins.run(0, callRow(11537, 0));
    ins.run(1, callRow(2339, 120448));
    ins.run(2, nonCallRow());
    db.close();
    expect(readGeminiContext("c", f)).toEqual({ tokens: 122787, window: 256000 });
  });
  it("missing db / bad id -> null (unmeasured), never throws", () => {
    expect(readGeminiContext("nope", "/nonexistent/x.db")).toBeNull();
    expect(readGeminiContext("../etc", "/nonexistent/x.db")).toBeNull();
  });
  it("an implausible reading (far above its own window) is rejected", () => {
    tmp = mkdtempSync(join(tmpdir(), "agy-"));
    const f = join(tmp, "c.db");
    const db = new Database(f);
    db.exec("CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)");
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (0, ?)").run(callRow(900_000, 0, 256000));
    db.close();
    expect(readGeminiContext("c", f)).toBeNull();
  });
});

describe("codex context from the rollout file", () => {
  const ev = (input: number, win: number) =>
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input }, total_token_usage: { input_tokens: input * 9 }, model_context_window: win } } });
  it("uses last_token_usage (not the running total) and the model window", () => {
    expect(parseCodexRollout([ev(1000, 272000), '{"type":"other"}', ev(50_000, 272000)].join("\n"))).toEqual({ tokens: 50000, window: 272000 });
  });
  it("no token_count event -> null", () => {
    expect(parseCodexRollout('{"type":"other"}\n')).toBeNull();
  });
  it("finds the rollout by thread id under sessions/YYYY/MM/DD", () => {
    tmp = mkdtempSync(join(tmpdir(), "codex-"));
    const d = join(tmp, "sessions", "2026", "10", "30");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "rollout-2026-10-30T10-00-00-abc-123.jsonl"), ev(7000, 272000) + "\n");
    expect(readCodexContext("abc-123", tmp)).toEqual({ tokens: 7000, window: 272000 });
    expect(readCodexContext("zzz", tmp)).toBeNull();
  });
});
