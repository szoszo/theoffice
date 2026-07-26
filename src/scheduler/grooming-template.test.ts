import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineConfig } from "../types.js";
import { loadScheduledTasks } from "./index.js";

/**
 * Portability lock for the shipped kanban-grooming default (issue #21 §2 fast-follow). The template must
 * NOT hardcode a tenant-specific agent: on a foreign install (JMarty, the lawyer fleet) a literal
 * "marveen" doesn't exist and the seeded task silently enqueues to nobody. The fix is to OMIT `agent` so
 * the loader's `tc.agent ?? cfg.mainAgentId` fallback targets whatever the install's main agent is. This
 * test loads the ACTUAL shipped template and asserts it resolves to the tenant's mainAgentId, not a literal.
 */
const here = dirname(fileURLToPath(import.meta.url));
const shippedTasksDir = join(here, "..", "..", "templates", "scheduled-tasks");

const cfgWithMain = (mainAgentId: string): EngineConfig =>
  ({ mainAgentId, paths: { scheduledTasksDir: shippedTasksDir } }) as unknown as EngineConfig;

describe("shipped kanban-grooming template — agent portability", () => {
  it("resolves the grooming task's agent to the tenant's mainAgentId (not a hardcoded agent)", () => {
    const probe = "portability-probe-agent";
    const tasks = loadScheduledTasks(cfgWithMain(probe));
    const grooming = tasks.find((t) => t.name === "kanban-grooming");
    expect(grooming, "kanban-grooming template should load").toBeTruthy();
    expect(grooming!.agent).toBe(probe); // follows the install's main agent, not a literal like "marveen"
  });

  it("targets a different main agent on a different install (proves it's not baked)", () => {
    const grooming = loadScheduledTasks(cfgWithMain("some-other-main")).find((t) => t.name === "kanban-grooming");
    expect(grooming!.agent).toBe("some-other-main");
  });
});
