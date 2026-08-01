import { describe, it, expect } from "vitest";
import { decideRestart } from "./restart-safety.js";

/**
 * The gate is ASYMMETRIC on purpose: only a PROVEN-unsafe verdict may block a restart.
 *
 * Blocking on "cannot determine" would break updates for every install without a running fleet, and a
 * safety gate that blocks legitimate work is a safety gate people route around — which is how it dies.
 * Blocking on a proven-unsafe verdict is the whole point: that restart would kill every agent session.
 */
describe("decideRestart — only a PROVEN unsafe result may block", () => {
  it("exit 0 (proven safe) proceeds", () => {
    expect(decideRestart(0).proceed).toBe(true);
  });

  it("exit 1 (proven UNSAFE) REFUSES, and says why", () => {
    const d = decideRestart(1, "VERDICT: UNSAFE");
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/kill every agent session/i);
  });

  it("exit 2 (cannot determine) PROCEEDS — a box with no fleet must still be updatable", () => {
    expect(decideRestart(2).proceed).toBe(true);
  });

  it("a crashed / missing checker (null exit) proceeds rather than wedging updates", () => {
    expect(decideRestart(null).proceed).toBe(true);
  });

  it("an unexpected exit code proceeds — only 1 is a definite unsafe", () => {
    for (const code of [3, 127, 255]) expect(decideRestart(code).proceed).toBe(true);
  });

  it("carries the checker's own output into the reason, so the log explains itself", () => {
    expect(decideRestart(1, "server 999 shares cgroup").reason).toContain("server 999 shares cgroup");
  });
});
