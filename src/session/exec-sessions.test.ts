import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { vi } from "vitest";

let db: Database.Database;
vi.mock("../db/index.js", () => ({ getDb: () => db }));

import {
  usageFromGemini,
  usageFromCodex,
  recordUsage,
  saveSession,
  getSession,
  clearSession,
  sessionToResume,
  estimatedContextPct,
  CONTEXT_WINDOW,
  UNKNOWN_CONTEXT_MAX_TURNS,
} from "./exec-sessions.js";
import { runMigrations } from "../db/migrate.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { bookTurn } from "./gemini-runtime.js";

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  runMigrations(db);
});
afterEach(() => db.close());

describe("usage parsing", () => {
  it("gemini: maps the agy json usage block", () => {
    const u = usageFromGemini({ input_tokens: 6796, output_tokens: 30, thinking_tokens: 29, cache_read_tokens: 5, total_tokens: 6826 });
    expect(u).toEqual({ input: 6796, output: 30, cacheRead: 5, thinking: 29 });
  });
  it("codex: splits cached tokens out of input_tokens", () => {
    const u = usageFromCodex({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 20 });
    expect(u).toEqual({ input: 600, output: 50, cacheRead: 400, thinking: 20 });
  });
  it("garbage usage -> null / zeros, never throws", () => {
    expect(usageFromGemini(undefined)).toBeNull();
    expect(usageFromCodex("x")).toBeNull();
    expect(usageFromGemini({ input_tokens: "a" })).toEqual({ input: 0, output: 0, cacheRead: 0, thinking: 0 });
  });
});

describe("usage + sessions in the db (migration v10)", () => {
  it("records a usage row per turn", () => {
    recordUsage("a", "s1", { input: 10, output: 5, cacheRead: 2, thinking: 3 });
    const r = db.prepare("select * from token_usage").get() as any;
    expect(r).toMatchObject({ agent: "a", session_id: "s1", input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, thinking_tokens: 3 });
  });

  it("saveSession counts turns for the same conversation and restarts the count for a new id", () => {
    saveSession("a", "gemini", "c1", 100);
    saveSession("a", "gemini", "c1", 200);
    expect(getSession("a", "gemini")).toEqual({ sessionId: "c1", turns: 2, lastContextTokens: 200, contextWindow: 0 });
    saveSession("a", "gemini", "c2", 50);
    expect(getSession("a", "gemini")).toEqual({ sessionId: "c2", turns: 1, lastContextTokens: 50, contextWindow: 0 });
  });

  it("a session stored for another runtime is not resumed", () => {
    saveSession("a", "codex", "t1", 10);
    expect(getSession("a", "gemini")).toBeNull();
    expect(sessionToResume("a", "gemini")).toBeNull();
    expect(sessionToResume("a", "codex")).toBe("t1");
  });

  it("clearSession is the reset path", () => {
    saveSession("a", "gemini", "c1", 10);
    expect(clearSession("a")).toBe(true);
    expect(sessionToResume("a", "gemini")).toBeNull();
    expect(clearSession("a")).toBe(false);
  });

  it("past the context share of the window the stored conversation is dropped (roll-over)", () => {
    const win = CONTEXT_WINDOW.codex!;
    saveSession("a", "codex", "t1", Math.floor(win * 0.5));
    expect(sessionToResume("a", "codex")).toBe("t1");
    saveSession("a", "codex", "t1", Math.floor(win * 0.8));
    expect(sessionToResume("a", "codex")).toBeNull();
    expect(getSession("a", "codex")).toBeNull();
  });

  it("estimated fill % comes from the measured context, against the CLI-reported window when known", () => {
    saveSession("a", "codex", "t1", Math.floor(CONTEXT_WINDOW.codex! / 4));
    expect(estimatedContextPct("a", "codex")).toBe(25);
    saveSession("g", "gemini", "c1", 100_000, 200_000);
    expect(estimatedContextPct("g", "gemini")).toBe(50);
    expect(estimatedContextPct("none", "codex")).toBeNull();
  });

  it("an unmeasured context (0) shows n/a, never a made-up percentage", () => {
    saveSession("a", "gemini", "c1", 0);
    expect(estimatedContextPct("a", "gemini")).toBeNull();
  });

  it("unmeasured context rolls over by turn count instead", () => {
    for (let i = 0; i < UNKNOWN_CONTEXT_MAX_TURNS - 1; i++) saveSession("a", "gemini", "c1", 0);
    expect(sessionToResume("a", "gemini")).toBe("c1");
    saveSession("a", "gemini", "c1", 0);
    expect(sessionToResume("a", "gemini")).toBeNull();
  });

  it("a big SUMMED turn usage no longer forces a roll-over: only the measured context counts", () => {
    // regression: heat reported 3.5M summed input for a ~120k context and rolled over after every tool turn
    saveSession("h", "gemini", "c1", 122_787, 256_000);
    expect(sessionToResume("h", "gemini")).toBe("c1");
    expect(estimatedContextPct("h", "gemini")).toBe(48);
  });
});

describe("gemini bookTurn", () => {
  it("books usage and the conversation id from the agy json (verified live shape)", () => {
    bookTurn("g", '{"conversation_id":"98859470","status":"SUCCESS","response":"ok\\n","usage":{"input_tokens":6796,"output_tokens":30,"thinking_tokens":29,"cache_read_tokens":0,"total_tokens":6826}}\n');
    expect(getSession("g", "gemini")?.sessionId).toBe("98859470");
    expect((db.prepare("select count(*) n from token_usage").get() as any).n).toBe(1);
  });
  it("unparsable stdout books nothing and does not throw", () => {
    bookTurn("g", "plain text answer");
    expect(getSession("g", "gemini")).toBeNull();
  });
});
