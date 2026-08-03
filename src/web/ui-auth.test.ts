import { describe, it, expect } from "vitest";
import { isLoopbackAddress, checkCookieAuth, parseCookies } from "./auth.js";

/**
 * Issue #5: `/api/*` was bearer-gated but the static UI shell was served to anyone who could reach
 * the port. On a LAN bind (OFFICE_HOST=0.0.0.0) that means any device on the network loads the
 * dashboard shell unauthenticated. Data stayed protected, but serving the app to strangers is a
 * weak posture, and the owner filed it as a security issue.
 *
 * The gate keys on whether the REQUEST came from loopback, not on how the server was bound. That is
 * strictly tighter: a LAN-bound server still serves the local browser without a login, while a LAN
 * client must authenticate even though the bind config is identical for both.
 */

const TOKEN = "a".repeat(64);

describe("isLoopbackAddress — the gate's only input, and it must be unspoofable", () => {
  it("accepts the loopback forms node actually reports", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true); // v4-mapped, what a dual-stack socket gives
    expect(isLoopbackAddress("127.1.2.3")).toBe(true); // all of 127.0.0.0/8 is loopback
  });

  it("rejects LAN and public addresses", () => {
    for (const a of ["192.168.1.50", "10.0.0.7", "172.16.0.1", "8.8.8.8", "2001:db8::1"]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });

  it("rejects the near-misses an attacker would reach for", () => {
    // Naive substring/prefix checks let these through.
    for (const a of ["127.0.0.1.evil.com", "1127.0.0.1", "0.0.0.0", "", undefined]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });
});

describe("parseCookies", () => {
  it("reads one cookie among several", () => {
    expect(parseCookies("a=1; office_session=xyz; b=2").office_session).toBe("xyz");
  });
  it("survives absent, empty and malformed headers without throwing", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("garbage;;=;")).toBeTypeOf("object");
  });
});

describe("checkCookieAuth", () => {
  it("accepts the session cookie carrying the dashboard token", () => {
    expect(checkCookieAuth(`office_session=${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a wrong, empty or absent cookie", () => {
    expect(checkCookieAuth(`office_session=${"b".repeat(64)}`, TOKEN)).toBe(false);
    expect(checkCookieAuth("office_session=", TOKEN)).toBe(false);
    expect(checkCookieAuth("other=x", TOKEN)).toBe(false);
    expect(checkCookieAuth(undefined, TOKEN)).toBe(false);
  });

  it("a length-mismatched value is rejected rather than throwing", () => {
    // timingSafeEqual throws on differing lengths; the guard must handle it, since the value is
    // fully attacker-controlled.
    expect(() => checkCookieAuth("office_session=short", TOKEN)).not.toThrow();
    expect(checkCookieAuth("office_session=short", TOKEN)).toBe(false);
  });
});
