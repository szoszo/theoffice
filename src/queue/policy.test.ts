import { describe, it, expect } from "vitest";
import { MAX_DELIVERY_ATTEMPTS } from "./index.js";
import {
  shouldEscalateDroppedOwnerItem,
  queueSourceRank,
  isStaleDroppableHeartbeat,
  ownerDropAlarmText,
  ownerStallAlarmText,
  permissionPromptAlarmText,
} from "./policy.js";

describe("shouldEscalateDroppedOwnerItem", () => {
  it("only the owner channel escalates; every other source fails quietly", () => {
    expect(shouldEscalateDroppedOwnerItem("channel")).toBe(true);
    for (const s of ["scheduler", "bus", "manual", "system"]) {
      expect(shouldEscalateDroppedOwnerItem(s)).toBe(false);
    }
  });
});

describe("queueSourceRank", () => {
  it("owner channel outranks everything else", () => {
    expect(queueSourceRank("channel")).toBe(0);
    for (const s of ["scheduler", "bus", "manual", "system"]) {
      expect(queueSourceRank(s)).toBe(1);
    }
  });
});

describe("isStaleDroppableHeartbeat", () => {
  const MAX = 2 * 60 * 60;
  it("drops a scheduler row older than the threshold", () => {
    expect(isStaleDroppableHeartbeat("scheduler", MAX + 1, MAX)).toBe(true);
  });
  it("keeps a scheduler row at or under the threshold", () => {
    expect(isStaleDroppableHeartbeat("scheduler", MAX, MAX)).toBe(false);
    expect(isStaleDroppableHeartbeat("scheduler", 10, MAX)).toBe(false);
  });
  it("NEVER drops owner/bus/manual/system however old", () => {
    for (const s of ["channel", "bus", "manual", "system"]) {
      expect(isStaleDroppableHeartbeat(s, 10 * MAX, MAX)).toBe(false);
    }
  });
  it("maxAgeSec <= 0 disables dropping", () => {
    expect(isStaleDroppableHeartbeat("scheduler", 10 * MAX, 0)).toBe(false);
    expect(isStaleDroppableHeartbeat("scheduler", 10 * MAX, -1)).toBe(false);
  });
});

describe("ownerDropAlarmText", () => {
  it("names the agent, the reason and the attempt budget, and quotes a preview", () => {
    const txt = ownerDropAlarmText("marveen", "dirty-pane", "Michael hasn't answered me for 30 minutes");
    expect(txt).toContain("*marveen*");
    expect(txt).toContain("dirty-pane");
    expect(txt).toContain(String(MAX_DELIVERY_ATTEMPTS));
    expect(txt).toContain("re-send");
    expect(txt).toContain("Michael hasn't answered me for 30 minutes");
  });
  it("flattens whitespace and truncates a long message with an ellipsis", () => {
    const long = "word ".repeat(100).trim(); // 500 chars, all one line after flattening
    const txt = ownerDropAlarmText("cfo", "submit-give-up", long);
    expect(txt).toContain("…");
    expect(txt).not.toContain("\n\n"); // preview is a single quoted line
    // preview capped at 140 chars of payload
    const previewLine = txt.split("\n").find((l) => l.startsWith("> "))!;
    expect(previewLine.length).toBeLessThanOrEqual(2 + 140 + 1);
  });
});

describe("ownerStallAlarmText — the queued-but-stuck case, worded honestly", () => {
  it("says 'not yet delivered / may be stuck', names the agent and minutes, quotes a preview", () => {
    const txt = ownerStallAlarmText("marveen", 16, "Michael its 10:46. And nothing from you since 5:46");
    expect(txt).toContain("*marveen*");
    expect(txt).toContain("16 min");
    expect(txt).toContain("queued but not");
    expect(txt).toMatch(/stuck|not yet/i);
    expect(txt).not.toMatch(/dropped|could not deliver/i); // NOT a confirmed drop — it may still land
    expect(txt).toContain("Michael its 10:46");
  });
});

describe("permissionPromptAlarmText — never dismissed, always surfaced", () => {
  it("names the agent, says it was left untouched, and gives the attach command", () => {
    const txt = permissionPromptAlarmText("cfo", "theoffice", "agent-cfo");
    expect(txt).toContain("*cfo*");
    expect(txt).toMatch(/did NOT touch|left|frozen/i);
    expect(txt).toContain("tmux -L theoffice attach -t agent-cfo");
    expect(txt).toMatch(/approve|reject/i);
  });
});
