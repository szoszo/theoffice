import { describe, it, expect } from "vitest";
import {
  inputBoxProvablyEmpty,
  inputBoxProvablyEmptyStyled,
  stripPaneStyling,
  detectPaneState,
  isReadyForPrompt,
  detectsThinkingBlockError,
  detectsUsageLimitModal,
  detectsUnsafeUsageLimitModal,
  detectsPermissionPrompt,
  shouldRetrySubmit,
  decideSubmitFollowup,
  submitConfirmed,
  safeToResubmit,
  liveInputBox,
} from "./pane-state.js";

const SEP = "─".repeat(40);
const FOOTER = "  bypass permissions on (shift+tab to cycle)";
const FOOTER_SHELLS = "  bypass permissions on · 1 shell · ↓ to manage";

function pane(...lines: string[]): string {
  return lines.join("\n");
}

describe("detectPaneState", () => {
  it("empty / blank -> unknown", () => {
    expect(detectPaneState("")).toBe("unknown");
    expect(detectPaneState("   \n  ")).toBe("unknown");
  });

  it("no idle footer -> unknown", () => {
    expect(detectPaneState(pane("just some scrollback", "no footer here"))).toBe("unknown");
  });

  it("clean idle box -> idle", () => {
    expect(detectPaneState(pane("assistant reply text", SEP, "❯ ", SEP, FOOTER))).toBe("idle");
    expect(detectPaneState(pane("reply", SEP, "❯ ", SEP, FOOTER_SHELLS))).toBe("idle");
  });

  it("esc-to-interrupt anywhere -> busy", () => {
    expect(detectPaneState(pane("✻ Working… (3s · ↓ 0.1k tokens · esc to interrupt)", SEP, "❯ ", SEP, FOOTER))).toBe("busy");
  });

  it("tokens-down-arrow counter -> busy (even if footer looks idle)", () => {
    expect(detectPaneState(pane("✻ Thinking… (52s · ↓ 2.6k tokens", SEP, "❯ ", SEP, FOOTER))).toBe("busy");
  });

  it("pending paste placeholder -> busy", () => {
    expect(detectPaneState(pane(SEP, "❯ [Pasted text #1 +812 chars]", SEP, FOOTER))).toBe("busy");
  });

  it("verbatim text parked in the input box -> typing", () => {
    expect(detectPaneState(pane(SEP, "❯ summarize the quarterly report", SEP, FOOTER))).toBe("typing");
  });

  it("parked ❯ in scrollback (not in live box) does NOT read as typing", () => {
    // a ❯ line ABOVE the live box, with a clean live box below -> idle
    const p = pane("❯ old historical command", "output", SEP, "❯ ", SEP, FOOTER);
    expect(detectPaneState(p)).toBe("idle");
  });

  it("wedged thinking-block error -> error", () => {
    const p = pane(
      "assistant turn",
      "⎿  API Error: 400 the thinking block cannot be modified (redacted_thinking)",
      SEP,
      "❯ ",
      SEP,
      FOOTER
    );
    expect(detectPaneState(p)).toBe("error");
  });

  it("quoted 'API Error' prose in a message is NOT an error state", () => {
    const p = pane("user asked about an API Error 400 earlier", SEP, "❯ ", SEP, FOOTER);
    expect(detectPaneState(p)).toBe("idle");
    expect(detectsThinkingBlockError(p)).toBe(false);
  });
});

describe("isReadyForPrompt", () => {
  it("only idle is ready", () => {
    expect(isReadyForPrompt(pane(SEP, "❯ ", SEP, FOOTER))).toBe(true);
    expect(isReadyForPrompt(pane(SEP, "❯ parked text here", SEP, FOOTER))).toBe(false);
    expect(isReadyForPrompt(pane("esc to interrupt"))).toBe(false);
  });
});

describe("liveInputBox", () => {
  it("returns inner box content, null when no live box", () => {
    expect(liveInputBox(pane(SEP, "❯ hello", SEP, FOOTER))).toBe("❯ hello");
    expect(liveInputBox(pane("no footer"))).toBeNull();
  });
});

describe("shouldRetrySubmit / decideSubmitFollowup", () => {
  const payload = "please summarize the quarterly report now";

  it("placeholder parked -> retry", () => {
    const p = pane(SEP, "❯ [Pasted text #2 +900 chars]", SEP, FOOTER);
    expect(shouldRetrySubmit(p, "")).toBe(true);
  });

  it("verbatim payload parked -> retry", () => {
    const p = pane(SEP, `❯ ${payload}`, SEP, FOOTER);
    expect(shouldRetrySubmit(p, payload)).toBe(true);
  });

  it("clean idle box -> no retry", () => {
    expect(shouldRetrySubmit(pane(SEP, "❯ ", SEP, FOOTER), payload)).toBe(false);
  });

  it("busy pane -> no retry", () => {
    expect(shouldRetrySubmit(pane("esc to interrupt"), payload)).toBe(false);
  });

  it("decideSubmitFollowup branches", () => {
    const stuck = pane(SEP, `❯ ${payload}`, SEP, FOOTER);
    const clean = pane(SEP, "❯ ", SEP, FOOTER);
    expect(decideSubmitFollowup(null, payload, 0, 4)).toBe("give-up");
    expect(decideSubmitFollowup(clean, payload, 0, 4)).toBe("done");
    expect(decideSubmitFollowup(stuck, payload, 0, 4)).toBe("retry-enter");
    expect(decideSubmitFollowup(stuck, payload, 4, 4)).toBe("give-up");
  });
});

/**
 * 2026-08-04: dwight + marveen went silent ~20 min. The delivery worker typed each owner message in but
 * the submit Enter was dropped; the message sat parked, yet the confirm loop marked it DELIVERED. Root
 * cause: "done" was returned whenever the payload was not VISIBLY parked — and a TALL parked payload
 * (dwight's message carried a `[Pasted text]` block of 8 photos) pushes the input box's top separator off
 * the captured pane, so liveInputBoxRange returns null and the old shouldRetrySubmit read false = "done".
 * The mirror of the pre-send inversion. The fix makes "done" require POSITIVE proof of submission.
 */
describe("submit-confirm requires positive proof (2026-08-04 strand regression)", () => {
  const payload = "please summarize the quarterly report now";
  // A box so tall its TOP separator scrolled off the capture — the exact live shape that stranded the
  // agents. Only the bottom separator + footer are visible, so the input box cannot be located.
  const tallStuck = [
    "❯ residue starts here",
    ...Array.from({ length: 40 }, (_, i) => `parked payload line ${i}`),
    SEP,
    FOOTER,
  ].join("\n");
  const clean = pane(SEP, "❯ ", SEP, FOOTER);
  const stuck = pane(SEP, `❯ ${payload}`, SEP, FOOTER);
  const busy = pane("✻ Thinking… (3s · ↓ 2.6k tokens · esc to interrupt)", SEP, "❯ ", SEP, FOOTER);
  // Real usage-limit modal: no idle footer. Pressing Enter here could select "Upgrade" (owner charge).
  const modal = pane(
    "You've hit your session limit · resets 6:20am",
    "What do you want to do?",
    "❯ 1. Stop and wait for limit to reset",
    "  2. Upgrade your plan",
    "Enter to confirm · Esc to cancel"
  );
  // Styled dim ghost hint a SUCCESSFUL submit leaves — must read as confirmed-empty, not still-parked.
  const SEP_S = "\x1b[38;5;244m" + "─".repeat(80);
  const FOOTER_S =
    "\x1b[39m  \x1b[38;5;211m⏵⏵ bypass permissions on\x1b[38;5;246m (shift+tab to cycle) · ← for agents\x1b[39m";
  const ghost = [
    "\x1b[39msome earlier reply",
    SEP_S,
    "\x1b[39m❯\xa0\x1b[2mapprove the pending travel bookings\x1b[0m",
    SEP_S,
    FOOTER_S,
  ].join("\n");

  it("THE BUG: a tall unsubmitted payload (box unlocatable) is NOT marked delivered", () => {
    expect(liveInputBox(tallStuck)).toBeNull(); // documents why the old code failed
    expect(submitConfirmed(tallStuck)).toBe(false);
    // was "done" (silent false-delivery) before the fix; now retried, then requeued at budget.
    expect(decideSubmitFollowup(tallStuck, payload, 0, 4)).toBe("retry-enter");
    expect(decideSubmitFollowup(tallStuck, payload, 4, 4)).toBe("give-up");
  });

  it("submitConfirmed: proof is busy OR a provably-empty box, nothing less", () => {
    expect(submitConfirmed(busy)).toBe(true); // agent started a turn
    expect(submitConfirmed(clean)).toBe(true); // composer cleared
    expect(submitConfirmed(ghost)).toBe(true); // dim ghost hint de-faints to empty
    expect(submitConfirmed(stuck)).toBe(false); // payload still parked
    expect(submitConfirmed(tallStuck)).toBe(false); // box unlocatable is NOT proof
    expect(submitConfirmed(null)).toBe(false);
  });

  it("a genuine submit still confirms done (busy, empty, or dim ghost hint)", () => {
    expect(decideSubmitFollowup(busy, payload, 0, 4)).toBe("done");
    expect(decideSubmitFollowup(clean, payload, 0, 4)).toBe("done");
    expect(decideSubmitFollowup(ghost, payload, 0, 4)).toBe("done");
  });

  it("FAST-TURN RACE (Michael 9498): turn ends before the poll, busy never sampled -> still done, no retry", () => {
    // The false-NEGATIVE twin of the strand: a short turn submits AND finishes before the ~1s confirm
    // sample, so the busy frame is never observed. Keying on busy ALONE would conclude not-delivered and
    // re-Enter, double-submitting (the identical duplicate Michael received). The composer-cleared branch
    // is the load-bearing proof here: payload gone from the box == submitted, even with no busy seen.
    expect(submitConfirmed(ghost)).toBe(true); // busy absent, composer cleared to a dim ghost hint
    expect(submitConfirmed(clean)).toBe(true); // busy absent, composer plainly empty
    // done on the FIRST sample -> the loop returns before it ever presses Enter again.
    expect(decideSubmitFollowup(ghost, payload, 0, 4)).toBe("done");
    // Contrast: payload STILL in the box + idle is the ONLY true retry case.
    expect(decideSubmitFollowup(stuck, payload, 0, 4)).toBe("retry-enter");
  });

  it("never presses Enter into a modal: unconfirmed + unsafe pane -> give-up (requeue), not retry", () => {
    expect(safeToResubmit(modal)).toBe(false); // no idle footer -> not safe to Enter
    expect(safeToResubmit(busy)).toBe(false);
    expect(safeToResubmit(clean)).toBe(true);
    expect(decideSubmitFollowup(modal, payload, 0, 4)).toBe("give-up");
  });
});

describe("inputBoxProvablyEmpty — a box we cannot SEE is never 'empty'", () => {
  const SEP2 = "─".repeat(40);
  const F = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

  it("visible and empty -> true", () => {
    expect(inputBoxProvablyEmpty(["reply", SEP2, "❯ ", SEP2, F].join("\n"))).toBe(true);
  });

  it("UNSTYLED text is never whitelisted by its wording — chrome is proven by styling, not by string", () => {
    // Tempting fix, wrong fix: whitelist the hint strings. The v2.1.x ghost hint is the agent's own
    // LAST PROMPT, so the set of "safe" strings is the set of all prompts — i.e. exactly the residue
    // we must refuse. Without the dim marker there is no evidence, so a plain capture must say false.
    expect(inputBoxProvablyEmpty(["reply", SEP2, '❯ Try "how do I log an error?"', SEP2, F].join("\n"))).toBe(false);
    expect(inputBoxProvablyEmpty(["reply", SEP2, "❯ run the morning briefing now", SEP2, F].join("\n"))).toBe(false);
  });

  it("visible with parked text -> false", () => {
    expect(inputBoxProvablyEmpty(["reply", SEP2, "❯ leftover residue", SEP2, F].join("\n"))).toBe(false);
  });

  it("REGRESSION: a box too tall to show its top separator is NOT empty", () => {
    // The live failure: thousands of chars of residue push the top border off the captured pane, so
    // liveInputBox returns null and detectPaneState calls it "idle". The bigger the mess, the cleaner
    // it looked. 24 of 24 clears "verified" this way.
    const huge = Array.from({ length: 40 }, (_, i) => `residue line ${i}`);
    const pane = ["❯ residue starts here", ...huge, SEP2, F].join("\n"); // no TOP separator visible
    expect(inputBoxProvablyEmpty(pane)).toBe(false);
    expect(detectPaneState(pane)).toBe("idle"); // documents the inverted detector we work around
  });

  it("multi-line residue inside a visible box -> false", () => {
    expect(inputBoxProvablyEmpty(["r", SEP2, "❯ line one", "line two", SEP2, F].join("\n"))).toBe(false);
  });

  it("no live box at all -> false (cannot prove empty)", () => {
    expect(inputBoxProvablyEmpty("just some text with no footer")).toBe(false);
  });
});

/**
 * Ghost-placeholder false positive, 2026-08-02. Claude Code v2.1.220 renders an EMPTY composer as
 * `❯ ` followed by a DIM (SGR 2) hint — and that hint is the agent's own last prompt, e.g.
 * `❯ approve the pending travel bookings` on pam or `❯ run the morning briefing now` on marveen.
 * `tmux capture-pane -p` discards styling, so the hint arrived looking exactly like parked residue and
 * the pre-send guard refused every delivery: 144 refusals across marveen/darryl/dwight/pam in one
 * morning, with the bus wedged. The text cannot be recognised by its wording (it IS a prompt), so the
 * discriminator has to be the styling: chrome is faint, text the composer really holds is not.
 *
 * All byte sequences below are copied verbatim out of `tmux capture-pane -e` on the live panes.
 */
describe("inputBoxProvablyEmptyStyled — a DIM ghost hint is chrome, real text is not", () => {
  const SEP_S = "\x1b[38;5;244m" + "─".repeat(80);
  const FOOTER_S =
    "\x1b[39m  \x1b[38;5;211m⏵⏵ bypass permissions on\x1b[38;5;246m (shift+tab to cycle) · ← for agents\x1b[39m";
  const boxed = (...inner: string[]) => ["\x1b[39msome earlier reply", SEP_S, ...inner, SEP_S, FOOTER_S].join("\n");

  it("REAL CAPTURE (agent-pam): dim ghost of the last prompt is EMPTY", () => {
    const pane = boxed("\x1b[39m❯\xa0\x1b[2mapprove the pending travel bookings\x1b[0m");
    expect(inputBoxProvablyEmptyStyled(pane)).toBe(true);
  });

  it("REAL CAPTURE (fresh v2.1.220 welcome screen): dim Try-hint is EMPTY", () => {
    const pane = boxed('\x1b[39m❯\xa0\x1b[2mTry "fix typecheck errors"\x1b[0m');
    expect(inputBoxProvablyEmptyStyled(pane)).toBe(true);
  });

  it("REAL CAPTURE (agent-darryl): a genuinely blank composer is EMPTY", () => {
    expect(inputBoxProvablyEmptyStyled(boxed("\x1b[38;5;246m❯\xa0\x1b[39m"))).toBe(true);
  });

  it("the SAME pane read without styling is refused — that is the bug, and why we capture -e", () => {
    const pane = boxed("\x1b[39m❯\xa0\x1b[2mapprove the pending travel bookings\x1b[0m");
    expect(inputBoxProvablyEmpty(stripPaneStyling(pane))).toBe(false);
  });

  it("normal-intensity text is residue, however much it looks like a hint", () => {
    expect(inputBoxProvablyEmptyStyled(boxed("\x1b[39m❯\xa0run the morning briefing now"))).toBe(false);
    expect(inputBoxProvablyEmptyStyled(boxed('\x1b[39m❯\xa0Try "fix typecheck errors"'))).toBe(false);
  });

  it("residue does not get to hide behind a dim run that ended", () => {
    // SGR 22 (normal intensity) and SGR 0 both close the faint run; text after it is real.
    expect(inputBoxProvablyEmptyStyled(boxed("\x1b[39m❯\xa0\x1b[2mghost\x1b[22m leftover residue"))).toBe(false);
    expect(inputBoxProvablyEmptyStyled(boxed("\x1b[39m❯\xa0\x1b[2mghost\x1b[0m leftover residue"))).toBe(false);
  });

  it("a second line of real text inside the box -> not empty", () => {
    expect(inputBoxProvablyEmptyStyled(boxed("\x1b[39m❯\xa0\x1b[2mghost\x1b[0m", "\x1b[39mline two"))).toBe(false);
  });

  it("REGRESSION HOLDS: a box too tall to show its top separator is still NOT empty", () => {
    // 8e35fb2's invariant. Styling changes what counts as text INSIDE a visible box; it must not
    // reopen the case where we cannot see the box at all — the more residue, the more certainly the
    // old detector called it clean.
    const huge = Array.from({ length: 40 }, (_, i) => `\x1b[39mresidue line ${i}`);
    const pane = ["\x1b[39m❯\xa0residue starts here", ...huge, SEP_S, FOOTER_S].join("\n");
    expect(inputBoxProvablyEmptyStyled(pane)).toBe(false);
  });

  it("no footer / no visible box -> false", () => {
    expect(inputBoxProvablyEmptyStyled("\x1b[2mjust some dim text with no box\x1b[0m")).toBe(false);
  });

  it("a WRAPPED ghost hint stays chrome on its continuation row", () => {
    // Toby's Q1, and the mechanism is confirmed: `capture-pane -e` emits an escape only where the
    // attribute CHANGES, so a soft-wrapped row inherits faintness from the row above and carries no
    // SGR-2 of its own. Reset faint per line and row 2 of a wrapped hint reads as normal-intensity
    // text — permanently non-empty, and C-u cannot clear chrome, so the pane bricks exactly the way
    // it did before dd5a073. Faint state therefore has to be threaded down the box.
    const wrapped = boxed(
      "\x1b[39m❯\xa0\x1b[2mapprove the pending travel bookings for the team offsite and then",
      "confirm the seat selection with Dajana\x1b[0m"
    );
    expect(inputBoxProvablyEmptyStyled(wrapped)).toBe(true);
  });

  it("the faint run must not leak past the box into a later line's meaning", () => {
    // Threading is scoped to the box and only forward: a hint closed on row 1 leaves row 2 real.
    const closed = boxed("\x1b[39m❯\xa0\x1b[2mghost row one\x1b[0m", "\x1b[39mreal residue row two");
    expect(inputBoxProvablyEmptyStyled(closed)).toBe(false);
  });

  it("a pending paste placeholder is dim chrome to the eye but MUST NOT read empty", () => {
    // `[Pasted text #1]` really is buffered content waiting on Enter; only the composer's own hint is
    // chrome. Guard it explicitly so a future dim-rendered paste marker can never slip through.
    expect(inputBoxProvablyEmptyStyled(boxed("\x1b[39m❯\xa0\x1b[2m[Pasted text #1 +40 lines]\x1b[0m"))).toBe(false);
  });
});

describe("stripPaneStyling — the plain view must survive the -e capture", () => {
  const STYLED_IDLE = [
    "\x1b[38;5;174m ▐\x1b[48;5;16m▛███▜\x1b[49m▌\x1b[39m   \x1b[1mClaude Code\x1b[0m \x1b[38;5;246mv2.1.220\x1b[39m",
    " \x1b[38;5;246m\x1b]8;id=zaxmda;https://code.claude.com/docs/en/security\x1b\\Security guide\x1b[39m\x1b]8;;\x1b\\",
    "\x1b[38;5;244m" + "─".repeat(80),
    '\x1b[39m❯\xa0\x1b[2mTry "fix typecheck errors"\x1b[0m',
    "\x1b[38;5;244m" + "─".repeat(80),
    "\x1b[39m  \x1b[38;5;211m⏵⏵ bypass permissions on\x1b[38;5;246m (shift+tab to cycle) · ← for agents\x1b[39m",
  ].join("\n");

  const plainIdleWith = (inner: string) =>
    ["earlier reply", "─".repeat(80), inner, "─".repeat(80), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join(
      "\n"
    );

  it("an unterminated OSC string cannot swallow the line break", () => {
    // Toby's finding: the OSC body class allowed \n, so a truncated hyperlink (right-side truncation
    // at the pane edge is routine) would eat everything up to the next terminator INCLUDING newlines,
    // dropping lines and breaking the line-for-line alignment the styled reader indexes on.
    // Needs a later terminator to bite (the body class already stops at ESC), so this is a narrow
    // case — but "narrow" is how the ghost bug got here too, and excluding \n costs nothing.
    const truncated = "\x1b]8;id=x;https://example.com/very-long\nsecond line\nthird\x07 line";
    const out = stripPaneStyling(truncated);
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("second line");
  });

  it("reproduces a plain -p capture exactly, trailing blanks included", () => {
    // `-e` keeps the spaces before a line's reset sequence; `-p` trims them. Verified against a live
    // pam pane on 2026-08-02, where this was the ONLY byte difference between the two captures.
    expect(stripPaneStyling("  Ran 1 shell command \x1b[39m")).toBe("  Ran 1 shell command");
    expect(stripPaneStyling("  indent kept\x1b[0m")).toBe("  indent kept");
  });

  it("drops SGR runs and OSC-8 hyperlink wrappers, keeping the visible text", () => {
    const plain = stripPaneStyling(STYLED_IDLE);
    expect(plain).not.toMatch(/\x1b/);
    expect(plain).toContain("Security guide");
    expect(plain).toContain('❯\xa0Try "fix typecheck errors"');
    expect(plain.split("\n")).toHaveLength(STYLED_IDLE.split("\n").length); // line-for-line alignment
  });

  it("leaves every classifier working on the stripped view", () => {
    const plain = stripPaneStyling(STYLED_IDLE);
    expect(liveInputBox(plain)).toBe('❯\xa0Try "fix typecheck errors"');
    expect(detectPaneState(stripPaneStyling("\x1b[2m✻ Pondering… (57s · ↓ 2.9k tokens)\x1b[0m"))).toBe("busy");
  });

  it("DOCUMENTS: v2.1.220 pads the prompt glyph with U+00A0, so PARKED_INPUT_RX never fires", () => {
    // `❯\xa0text` is what the live pane emits — PARKED_INPUT_RX wants `❯` + space/tab, so the "typing"
    // state is effectively dead and BOTH a ghost hint and real residue classify as "idle". Do not
    // "fix" the regex casually: isReady() gates delivery on idle, so making residue read "typing"
    // would leave messages queued forever instead of refused. inputBoxProvablyEmptyStyled is the
    // load-bearing guard, and it reads the box content directly rather than trusting this label.
    expect(detectPaneState(plainIdleWith("❯\xa0some real residue"))).toBe("idle");
    expect(detectPaneState(plainIdleWith("❯ some real residue"))).toBe("typing"); // ASCII space: matches
    expect(inputBoxProvablyEmpty(plainIdleWith("❯\xa0some real residue"))).toBe(false); // caught here
  });
});

describe("detectsUsageLimitModal — dismissable ONLY when Stop-and-wait is highlighted", () => {
  // Real 2026-08-04 shape (marveen/dwight/toby): cursor `❯` on option 1.
  const HIGHLIGHT_ON_STOP = pane(
    "  ✻ Cooked for 1m 19s",
    "  You've hit your session limit · resets 6:20am",
    "   What do you want to do?",
    "   ❯ 1. Stop and wait for limit to reset",
    "     2. Upgrade your plan",
    "   Enter to confirm · Esc to cancel",
  );
  // THE DANGEROUS ONE (Toby's required test, Michael 9274): cursor `❯` on Upgrade. Enter here would
  // spend the owner's money — the detector MUST refuse so the sweeper never presses it.
  const HIGHLIGHT_ON_UPGRADE = pane(
    "   What do you want to do?",
    "     1. Stop and wait for limit to reset",
    "   ❯ 2. Upgrade your plan",
    "   Enter to confirm · Esc to cancel",
  );
  // No highlight at all (mid-render / unrecognised marker): also refuse.
  const NO_HIGHLIGHT = pane(
    "   What do you want to do?",
    "     1. Stop and wait for limit to reset",
    "     2. Upgrade your plan",
    "   Enter to confirm · Esc to cancel",
  );

  it("highlight on Stop-and-wait -> dismissable (Enter provably selects option 1)", () => {
    expect(detectPaneState(HIGHLIGHT_ON_STOP)).toBe("unknown");
    expect(detectsUsageLimitModal(HIGHLIGHT_ON_STOP)).toBe(true);
    expect(detectsUnsafeUsageLimitModal(HIGHLIGHT_ON_STOP)).toBe(false);
  });

  it("highlight on UPGRADE -> NOT dismissable (never spend the owner's money), flagged unsafe", () => {
    expect(detectsUsageLimitModal(HIGHLIGHT_ON_UPGRADE)).toBe(false); // the money-safety invariant
    expect(detectsUnsafeUsageLimitModal(HIGHLIGHT_ON_UPGRADE)).toBe(true); // sweeper leaves + surfaces it
  });

  it("no highlight on either option -> NOT dismissable, flagged unsafe", () => {
    expect(detectsUsageLimitModal(NO_HIGHLIGHT)).toBe(false);
    expect(detectsUnsafeUsageLimitModal(NO_HIGHLIGHT)).toBe(true);
  });

  it("dismissable and unsafe are mutually exclusive across all four fixtures", () => {
    for (const p of [HIGHLIGHT_ON_STOP, HIGHLIGHT_ON_UPGRADE, NO_HIGHLIGHT]) {
      expect(detectsUsageLimitModal(p) && detectsUnsafeUsageLimitModal(p)).toBe(false);
    }
  });

  it("does NOT fire on an idle pane that merely QUOTES the modal text in a reply", () => {
    const quoted = pane(
      "● The limit menu offered: ❯ 1. Stop and wait for limit to reset / 2. Upgrade your plan",
      SEP,
      "❯ ",
      SEP,
      FOOTER,
    );
    expect(detectPaneState(quoted)).toBe("idle"); // has the real footer -> not 'unknown'
    expect(detectsUsageLimitModal(quoted)).toBe(false);
    expect(detectsUnsafeUsageLimitModal(quoted)).toBe(false);
  });

  it("does NOT fire on a busy pane quoting the modal", () => {
    const busy = pane(
      "  Thinking… (12s · ↓ 1.2k tokens) ❯ 1. Stop and wait for limit to reset / 2. Upgrade your plan",
      "  esc to interrupt",
    );
    expect(detectsUsageLimitModal(busy)).toBe(false);
    expect(detectsUnsafeUsageLimitModal(busy)).toBe(false);
  });

  it("empty / blank pane is not the modal", () => {
    expect(detectsUsageLimitModal("")).toBe(false);
    expect(detectsUnsafeUsageLimitModal("")).toBe(false);
  });
});

describe("detectsPermissionPrompt — DETECT (to alarm), the sweeper must NEVER dismiss these", () => {
  const PERM_EDIT = pane(
    "  Do you want to make this edit to config.ts?",
    "   ❯ 1. Yes",
    "     2. Yes, and don't ask again this session",
    "     3. No, and tell Claude what to do differently (esc)",
  );
  const PERM_BASH = pane(
    "  Do you want to run this command?",
    "     rm -rf /opt/claude/theoffice/tenant/store",
    "   ❯ 1. Yes",
    "     2. No, and tell Claude what to do differently (esc)",
  );

  it("fires on a live edit/bash approval gate (no idle footer -> unknown + approval wording)", () => {
    expect(detectPaneState(PERM_EDIT)).toBe("unknown");
    expect(detectsPermissionPrompt(PERM_EDIT)).toBe(true);
    expect(detectsPermissionPrompt(PERM_BASH)).toBe(true);
    // and it is NOT confused with the usage-limit modal -> never gets a keystroke
    expect(detectsUsageLimitModal(PERM_EDIT)).toBe(false);
    expect(detectsUsageLimitModal(PERM_BASH)).toBe(false);
  });

  it("does NOT fire on an idle/busy pane that quotes the approval wording in a reply", () => {
    const quoted = pane("● I asked: Do you want to proceed? and you said yes", SEP, "❯ ", SEP, FOOTER);
    expect(detectPaneState(quoted)).toBe("idle");
    expect(detectsPermissionPrompt(quoted)).toBe(false);
  });
});

describe("usage-limit sweeper acts on NOTHING but the positive limit-modal signature (point 3)", () => {
  // busy / typing / normal-idle / unrecognised-modal -> neither dismissable nor flagged unsafe
  const BUSY = pane("✻ Thinking… (12s · ↓ 2.6k tokens · esc to interrupt)", SEP, "❯ ", SEP, FOOTER);
  const TYPING = pane(SEP, "❯ some half-typed thing", SEP, FOOTER);
  const IDLE = pane("● reply", SEP, "❯ ", SEP, FOOTER);
  const UNRECOGNISED_MODAL = pane("  Some future modal we've never seen", "   ❯ 1. Do a thing", "     2. Do another", "   Enter to confirm");

  for (const [name, p] of [["busy", BUSY], ["typing", TYPING], ["idle", IDLE], ["unrecognised modal", UNRECOGNISED_MODAL]] as const) {
    it(`${name}: not dismissable, not flagged unsafe, not a permission prompt`, () => {
      expect(detectsUsageLimitModal(p)).toBe(false);
      expect(detectsUnsafeUsageLimitModal(p)).toBe(false);
      expect(detectsPermissionPrompt(p)).toBe(false);
    });
  }
});
