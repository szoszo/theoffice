import { execFile } from "node:child_process";
import { log } from "../logger.js";

const logger = log("model-catalog");

/**
 * A provider's selectable model list, taken from the CLI itself instead of a hardcoded array: the
 * providers rename and retire models without notice (agy dropped gemini-3.6/3.5/3.1 and exits 1 on an
 * unknown --model). `get()` is synchronous and never blocks: it returns the last good list (or the
 * built-in fallback until the first refresh lands) and kicks off a background refresh when the cache is
 * older than `ttlMs`. A failed refresh keeps the previous list and retries after `retryMs`.
 */
export function createModelCatalog(opts: {
  fallback: readonly string[];
  /** resolves the current model slugs; rejecting or resolving empty keeps the old list */
  fetch: () => Promise<string[]>;
  ttlMs?: number;
  retryMs?: number;
  now?: () => number;
}) {
  const ttl = opts.ttlMs ?? 24 * 60 * 60_000; // once a day is plenty: the providers rename models every few weeks, not hourly
  const retry = opts.retryMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let list: readonly string[] = opts.fallback;
  let nextRefresh = 0;
  let inFlight = false;

  const refresh = () => {
    if (inFlight) return;
    inFlight = true;
    nextRefresh = now() + retry; // optimistic: only a success moves it out to the full ttl
    opts
      .fetch()
      .then((m) => {
        if (m.length > 0) {
          list = m;
          nextRefresh = now() + ttl;
        }
      })
      .catch((err) => logger.warn({ err: String((err as Error).message ?? err) }, "model list refresh failed; keeping the previous list"))
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    get(): readonly string[] {
      if (now() >= nextRefresh) refresh();
      return list;
    },
    /** resolves once the in-progress/just-started refresh finished (tests, startup warm-up) */
    async warm(): Promise<readonly string[]> {
      if (now() >= nextRefresh) refresh();
      while (inFlight) await new Promise((r) => setTimeout(r, 5));
      return list;
    },
  };
}

/**
 * The `--model` value to pass for an agent, or null to let the CLI use the account default: only a slug the
 * runtime itself lists. agent.json often keeps a model id from another provider (an agent flipped from
 * claude to codex keeps "claude-sonnet-5-5"), and the CLI rejects that as a config error, failing every
 * turn. Logs once per agent+model that the configured value was ignored.
 */
const ignoredModels = new Set<string>();
export function usableModel(agentId: string, runtime: string, model: string | undefined, models: readonly string[]): string | null {
  if (!model || model === "default") return null;
  if (models.includes(model)) return model;
  const key = `${agentId}\0${runtime}\0${model}`;
  if (!ignoredModels.has(key)) {
    ignoredModels.add(key);
    logger.warn({ agent: agentId, runtime, model }, "configured model is not in this runtime's model list; using the account default");
  }
  return null;
}

/** `agy models`: tab-separated "<slug>\t<label>" lines after a "Fetching..." banner. */
export function parseAgyModels(out: string): string[] {
  const slugs: string[] = [];
  for (const line of out.split("\n")) {
    const slug = line.split("\t")[0]?.trim() ?? "";
    if (line.includes("\t") && /^[a-z0-9][a-z0-9._-]*$/.test(slug)) slugs.push(slug);
  }
  return slugs;
}

/** `codex debug models`: JSON catalog; offer the entries the CLI itself lists as selectable. */
export function parseCodexModels(out: string): string[] {
  const d = JSON.parse(out);
  const ms: any[] = Array.isArray(d) ? d : (d?.models ?? []);
  return ms.filter((m) => m?.visibility === "list" && typeof m.slug === "string").map((m) => m.slug as string);
}

/**
 * The engine's env with the owner's ~/.local/bin in front, same as buildAgentEnv: agy and codex live
 * there, and the systemd unit's PATH does not have it (every refresh died with "spawn agy ENOENT" and
 * the dashboard kept serving the stale built-in list).
 */
export function cliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, PATH: `${base.HOME ?? ""}/.local/bin:${base.PATH ?? "/usr/local/bin:/usr/bin:/bin"}` };
}

export function runCli(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8_000_000, env: cliEnv() }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
