import { describe, it, expect } from "vitest";
import { decideRestart, OVERRIDE_ENV } from "./restart-safety.js";

/**
 * The gate keys on IS THERE ANYTHING TO LOSE, not on COULD I DETERMINE SAFETY (Michael, 2026-08-01).
 *
 * The first version collapsed both into "cannot determine -> proceed", which waved through the one
 * case the gate exists for: a LIVE FLEET whose blast radius is unreadable. Meanwhile a fresh tenant
 * with no fleet must never be blocked, or the gate becomes something people route around.
 */
describe("decideRestart — proceed only when safe OR when nothing is at stake", () => {
  it("0 (proven safe) proceeds", () => {
    expect(decideRestart(0).proceed).toBe(true);
  });

  it("3 (nothing to protect) proceeds — fresh installs must never block", () => {
    expect(decideRestart(3).proceed).toBe(true);
  });

  it("1 (proven UNSAFE) refuses", () => {
    const d = decideRestart(1);
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/kill every agent session/i);
  });

  it("2 (fleet LIVE, blast radius unreadable) REFUSES — the case the gate exists for", () => {
    const d = decideRestart(2);
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/could not be determined/i);
  });

  it("a crashed checker refuses WHEN A FLEET EXISTS", () => {
    expect(decideRestart(null, "", true).proceed).toBe(false);
  });

  it("a crashed checker proceeds when there is NO fleet to lose", () => {
    expect(decideRestart(null, "", false).proceed).toBe(true);
  });

  it("an unexpected exit code follows the same rule: fleet decides", () => {
    expect(decideRestart(127, "", true).proceed).toBe(false);
    expect(decideRestart(127, "", false).proceed).toBe(true);
  });

  it("every refusal names the sanctioned override, so nobody has to invent one", () => {
    for (const code of [1, 2]) expect(decideRestart(code).reason).toContain(OVERRIDE_ENV);
    expect(decideRestart(null, "", true).reason).toContain(OVERRIDE_ENV);
  });

  it("carries the checker's own output into the reason so the log explains itself", () => {
    expect(decideRestart(2, "MULTIPLE servers matched").reason).toContain("MULTIPLE servers matched");
  });
});
