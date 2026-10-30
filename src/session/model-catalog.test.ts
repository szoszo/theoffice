import { describe, it, expect } from "vitest";
import { createModelCatalog, parseAgyModels, parseCodexModels } from "./model-catalog.js";

describe("parsers", () => {
  it("agy models: slugs from the tab-separated lines, banner ignored", () => {
    const out = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
    expect(parseAgyModels(out)).toEqual(["gemini-3.8-flash-high", "claude-sonnet-4-6"]);
    expect(parseAgyModels("garbage")).toEqual([]);
  });
  it("codex debug models: only visibility=list entries", () => {
    const out = JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list" }, { slug: "codex-auto-review", visibility: "hide" }] });
    expect(parseCodexModels(out)).toEqual(["gpt-5.5"]);
  });
});

describe("createModelCatalog", () => {
  it("serves the fallback until the first refresh lands, then the fetched list", async () => {
    const c = createModelCatalog({ fallback: ["old"], fetch: async () => ["new-a", "new-b"] });
    expect(c.get()).toEqual(["old"]);
    expect(await c.warm()).toEqual(["new-a", "new-b"]);
    expect(c.get()).toEqual(["new-a", "new-b"]);
  });
  it("a failing or empty fetch keeps the previous list", async () => {
    let mode: "ok" | "fail" | "empty" = "ok";
    let t = 0;
    const c = createModelCatalog({
      fallback: ["fb"],
      ttlMs: 10,
      retryMs: 10,
      now: () => t,
      fetch: async () => {
        if (mode === "fail") throw new Error("agy missing");
        return mode === "empty" ? [] : ["live"];
      },
    });
    expect(await c.warm()).toEqual(["live"]);
    mode = "fail";
    t += 20;
    expect(await c.warm()).toEqual(["live"]);
    mode = "empty";
    t += 20;
    expect(await c.warm()).toEqual(["live"]);
  });
  it("refreshes again once the ttl passed", async () => {
    let n = 0;
    let t = 0;
    const c = createModelCatalog({ fallback: [], ttlMs: 100, now: () => t, fetch: async () => [`v${++n}`] });
    expect(await c.warm()).toEqual(["v1"]);
    t += 50;
    expect(await c.warm()).toEqual(["v1"]);
    t += 100;
    expect(await c.warm()).toEqual(["v2"]);
  });
});
