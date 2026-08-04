/**
 * Pure pane-state machine for the v2 Session Manager.
 *
 * This is the one place that interprets a `tmux capture-pane` snapshot of a
 * `claude` TUI. It is dependency-free and side-effect-free so it can be unit
 * tested exhaustively (feed snapshot strings in, assert state out). The regexes
 * are ported verbatim from the battle-tested v1 implementation — they encode
 * hard-won knowledge about which screen signatures actually mean "busy" vs
 * "idle" vs "wedged", and must not be loosened without a failing test.
 */

export type PaneState = "idle" | "busy" | "typing" | "unknown" | "error";

/**
 * The idle footer. The live bypass-mode footer is prefixed by the `⏵⏵` toggle
 * glyph, which sits at the FRONT and so survives right-side truncation — the
 * footer runs `⏵⏵ bypass permissions on · <hint> · <hint> …` and at an 80-col
 * detached pane the tail (`↓ to manage`) is frequently cut off entirely when
 * several segments are present (`· install gh for PR status · 1 shell · ← for
 * agents · ↓ to manage`). So the primary anchor is `⏵⏵ … bypass permissions on`
 * (front, truncation-proof); the second alternative (bypass + a visible
 * `(shift+tab to cycle)` / `↓ to manage` tail) covers terminals that drop the
 * glyph; `? for shortcuts` is the strict-mode footer.
 *
 * Safe against scrollback: a quoted "bypass permissions on · 1 shell" in a
 * message has neither the `⏵⏵` glyph nor the affordance tail, so it is rejected;
 * and the footer is located from the BOTTOM, so the live last-line footer wins.
 * A BUSY pane is caught FIRST by BUSY_INDICATORS (the tokens-`↓` counter, now
 * minute-aware), so a mid-turn footer never reaches this idle test.
 *
 * The earlier regex required the shell count to be immediately followed by its
 * tail, so a footer with an intervening segment — or a truncated tail — read
 * `unknown` and the agent got ZERO deliveries while a background shell ran
 * (2026-07-30 incident: dwight went deaf to the owner + scheduled tasks for hours).
 */
const IDLE_FOOTER_RX =
  /⏵⏵[^\n]*bypass permissions on\b|bypass permissions on\b[^\n]*?(?:\(shift\+tab to cycle\)|↓ to manage)|\? for shortcuts/;

/**
 * Positive busy signals — only signatures that vanish the moment a turn ends.
 * The load-bearing one is the tokens-down-arrow counter `(Ns · ↓N`, which every
 * extended-thinking turn renders regardless of spinner label.
 */
const BUSY_INDICATORS: RegExp[] = [
  /\besc to interrupt\b/,
  // Token counter: "(52s · ↓ 2.6k" AND the minute form "(1m 14s · ↓ 3.6k" once
  // a turn passes 60s. Missing the `\d+m` branch let long turns read not-busy.
  /\(\s*(?:\d+m\s*)?\d+s\s*·\s*↓\s*\d/,
  /\b(?:Combobulating|Beaming|Thinking|Pondering|Reticulating|Configuring|Noodling|Ruminating|Percolating|Cogitating|Deliberating|Contemplating|Musing|Brewing|Synthesizing|Distilling|Refining|Simmering|Crafting|Formulating|Consulting|Unfurling|Unspooling|Unraveling)…\s*\(\s*\d+s\s*·\s*↓/,
];

/** Pasted-text placeholder — sits in the buffer and never auto-submits on Enter. */
const PENDING_PASTE_RX = /\[Pasted text #\d+/;

/** Input-box separator: a run of U+2500 box-drawing chars (>=10 to ignore stray dashes). */
const BOX_SEP_RX = /^─{10,}/;

/** A parked prompt line: `❯` + space/tab + a non-space char (single-line). */
const PARKED_INPUT_RX = /❯[ \t]+\S/;

// Persistent Anthropic thinking-block API error (wedged session). All three
// guards required, within one chrome block, scoped to the live tail.
const ERROR_CHROME_RX = /⎿\s*API Error:\s*\d+/;
const ERROR_THINKING_PHRASE_RX = /cannot be modified/;
const ERROR_THINKING_KIND_RX = /\b(?:redacted_thinking|thinking)\b/;
const ERROR_LIVE_TAIL_LINES = 20;
const ERROR_BLOCK_LINES = 4;

/** True when the pane is wedged in the persistent thinking-block API error. */
export function detectsThinkingBlockError(pane: string): boolean {
  if (!pane) return false;
  const lines = pane.split("\n");
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (IDLE_FOOTER_RX.test(lines[i]!)) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return false;
  const start = Math.max(0, footerIdx - ERROR_LIVE_TAIL_LINES);
  const tail = lines.slice(start, footerIdx);
  for (let i = 0; i < tail.length; i++) {
    if (!ERROR_CHROME_RX.test(tail[i]!)) continue;
    const block = tail.slice(i, i + ERROR_BLOCK_LINES).join("\n");
    if (ERROR_THINKING_PHRASE_RX.test(block) && ERROR_THINKING_KIND_RX.test(block)) return true;
  }
  return false;
}

/**
 * Classify a pane snapshot. Order matters:
 *   busy signal anywhere -> busy; no idle footer -> unknown; wedged -> error;
 *   pending paste -> busy; parked text in the live input box -> typing; else idle.
 */
export function detectPaneState(pane: string): PaneState {
  if (!pane || !pane.trim()) return "unknown";
  for (const rx of BUSY_INDICATORS) if (rx.test(pane)) return "busy";
  if (!IDLE_FOOTER_RX.test(pane)) return "unknown";
  if (detectsThinkingBlockError(pane)) return "error";
  if (PENDING_PASTE_RX.test(pane)) return "busy";

  const box = liveInputBox(pane);
  if (box != null && box.split("\n").some((l) => PARKED_INPUT_RX.test(l))) return "typing";
  return "idle";
}

// The Claude Code "you've hit your usage limit" modal. When an agent exhausts its plan limit mid-turn,
// Claude Code halts the turn and replaces the whole footer with a blocking menu:
//
//     You've hit your session limit · resets 6:20am
//     What do you want to do?
//       ❯ 1. Stop and wait for limit to reset
//         2. Upgrade your plan
//       Enter to confirm · Esc to cancel
//
// That menu carries NO idle footer, so detectPaneState() returns 'unknown' and the deliverer's
// readiness gate parks every queued message behind it — the owner's included. It NEVER self-clears,
// even after the limit resets: it sits on the menu until someone presses Enter, so an agent that hits
// its limit unattended goes deaf until a human intervenes (marveen + dwight + toby all frozen this way,
// 2026-08-04). The session-hygiene sweeper dismisses it by selecting option 1 (Stop-and-wait, which
// makes Claude Code auto-resume at reset); it must NEVER pick option 2 (Upgrade spends the owner's money).
// The presence of the two menu labels only proves the usage-limit menu is ON SCREEN — NOT which option
// the cursor is on. Enter confirms whatever is highlighted, so a detector that gates Enter on presence
// alone will select Upgrade (a charge to the owner's card) any time the pane is captured with the
// highlight on option 2 — a human arrowed down and walked away, a future Claude Code default change, a
// mid-render frame, any variant we don't control. The highlight is the load-bearing bit, so it must be
// verified, never assumed (Michael, bus 9274; Toby's required test).
//
// The highlight marker is `❯` immediately before the option, verified against the REAL 2026-08-04
// captures (marveen, dwight, toby all rendered `❯ 1. Stop and wait for limit to reset`), not just the
// test fixture. STOP_HIGHLIGHTED anchors `❯` to the Stop-and-wait line; UPGRADE_PRESENT confirms this
// really is the usage-limit menu (that label never appears elsewhere).
const USAGE_LIMIT_STOP_HIGHLIGHTED_RX = /❯\s*1\.\s*Stop and wait for limit to reset/;
const USAGE_LIMIT_UPGRADE_PRESENT_RX = /Upgrade your plan/;
// The menu + its footer occupy the last ~6 lines; 12 gives margin without reaching deep scrollback.
const USAGE_LIMIT_TAIL_LINES = 12;

function usageLimitTail(pane: string): string | null {
  if (!pane) return null;
  // The real modal has no idle footer; an idle/busy pane that merely QUOTES the modal text still shows
  // its footer and is rejected here, so a quoted menu in a reply can never be mistaken for the live one.
  if (detectPaneState(pane) !== "unknown") return null;
  const lines = pane.split("\n");
  return lines.slice(Math.max(0, lines.length - USAGE_LIMIT_TAIL_LINES)).join("\n");
}

/**
 * True ONLY when the pane is on the usage-limit modal AND the highlight is provably on Stop-and-wait —
 * i.e. the exact arrangement where sending Enter confirms option 1 and NOTHING else. This is the only
 * state in which the sweeper may press Enter. Every other arrangement (highlight on Upgrade, no
 * highlight, an unrecognised marker) returns false, so the caller falls through to leave-and-alarm
 * rather than send a keystroke it cannot prove is safe. Whitelist, not blacklist: we recognise the one
 * safe frame, we do not try to enumerate the dangerous ones.
 */
export function detectsUsageLimitModal(pane: string): boolean {
  const tail = usageLimitTail(pane);
  if (tail == null) return false;
  return USAGE_LIMIT_STOP_HIGHLIGHTED_RX.test(tail) && USAGE_LIMIT_UPGRADE_PRESENT_RX.test(tail);
}

/**
 * True when a usage-limit modal is on screen but NOT in the safe-to-dismiss arrangement (both labels
 * present, but the highlight is not provably on Stop-and-wait). The sweeper uses this to LEAVE the pane
 * untouched and surface it — never to act. Mutually exclusive with detectsUsageLimitModal by construction.
 */
export function detectsUnsafeUsageLimitModal(pane: string): boolean {
  const tail = usageLimitTail(pane);
  if (tail == null) return false;
  // A usage-limit modal is present iff the Stop-and-wait LABEL and the Upgrade label both show.
  const present = /Stop and wait for limit to reset/.test(tail) && USAGE_LIMIT_UPGRADE_PRESENT_RX.test(tail);
  return present && !USAGE_LIMIT_STOP_HIGHLIGHTED_RX.test(tail);
}

// A permission / approval prompt. This is the class the sweeper must be STRUCTURALLY INCAPABLE of
// clearing (Michael 9248/9253): dismissing one APPROVES an action — a delete, a push, a payment, a
// deploy — blind, on the owner's box, with his credentials. So the sweeper only ever DETECTS + ALARMS
// on these and leaves the pane exactly as it is; a human decides. The strings are Claude Code's own
// approval-menu wording, which never appears in the usage-limit menu. Agents run
// --dangerously-skip-permissions, so these are rare — but Claude Code still surfaces a gate for
// operations it deems dangerous (a real one froze cfo on an `rm -f "$WORK"/*.pdf` on 2026-08-04), which
// is exactly why one appearing must be surfaced loudly rather than left to sit silently.
const PERMISSION_PROMPT_RX =
  /No, and tell Claude what to do differently|Yes, and (?:don't|do not) ask again|Do you want to (?:proceed|make this edit|create|run|allow)/;

/**
 * True when the pane is blocked on a permission/approval prompt. Gated on detectPaneState==='unknown'
 * (a live approval menu carries no idle footer) so an idle/busy pane that merely quotes the wording in a
 * reply is not mistaken for a live gate. The sweeper must ALARM on this, never send a keystroke.
 */
export function detectsPermissionPrompt(pane: string): boolean {
  if (!pane) return false;
  if (detectPaneState(pane) !== "unknown") return false;
  return PERMISSION_PROMPT_RX.test(pane);
}

/**
 * PROVABLY empty: the live input box is visible AND holds no text.
 *
 * Distinct from `detectPaneState(...) === "idle"`, which reports idle when `liveInputBox` returns
 * NULL — and it returns null exactly when the box's top separator has scrolled off the captured
 * pane, i.e. when the draft is LARGE. That detector is inverted: the more residue there is, the more
 * certainly it reports clean. On 2026-08-01/02 that produced 24 "draft cleared and verified" log
 * lines out of 24 while the residue survived and was later submitted behind an owner message.
 *
 * Here a box we cannot SEE is never counted as empty. Clearing shrinks the box, so repeated rounds
 * bring the top separator back into view and this converges rather than refusing forever.
 */
export function inputBoxProvablyEmpty(pane: string): boolean {
  const box = liveInputBox(pane);
  if (box == null) return false; // cannot see the box => cannot claim it is empty
  return box.split("\n").every((l) => boxLineText(l) === "");
}

/** The visible text a box line holds, with the prompt glyph removed. */
function boxLineText(line: string): string {
  return line.replace(/^\s*❯/, "").trim();
}

/**
 * ANSI escapes tmux emits with `capture-pane -e`: SGR/CSI sequences plus OSC strings (the v2.1.x
 * welcome screen wraps its docs link in OSC-8 hyperlinks, terminated by BEL or ST).
 */
const CSI_RX = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
/** The body excludes \n so a truncated hyperlink can never swallow a line break and drop rows — the
 *  styled reader indexes styled and plain lines against each other, so line count must be stable. */
const OSC_RX = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)/g;

/**
 * Drop styling from a `capture-pane -e` snapshot, yielding the exact text a plain `-p` capture gives.
 * Line count and column text are preserved, so a styled snapshot can be classified by every regex in
 * this file and indexed line-for-line against its styled original.
 *
 * Trailing blanks are trimmed per line because `-p` trims them and `-e` does not (a line ending in a
 * reset sequence keeps the spaces that preceded it). No regex here is end-anchored, so this changes no
 * verdict today — it just keeps `stripPaneStyling(-e) === -p` exactly true, which is the property that
 * lets the delivery path classify a styled capture instead of taking a second, racing plain one.
 */
export function stripPaneStyling(pane: string): string {
  return pane
    .replace(OSC_RX, "")
    .replace(CSI_RX, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * SGR 2 opens a faint run; 0 and 22 close it. Everything else leaves intensity alone.
 *
 * `faintIn` carries the intensity in force at the start of the line and the result reports the
 * intensity left in force at its end, because `capture-pane -e` emits an escape only where the
 * attribute CHANGES: a soft-wrapped continuation row inherits its predecessor's attributes and
 * carries no SGR-2 of its own. Reset per line and row 2 of a wrapped ghost hint reads as real text,
 * which bricks the pane permanently — C-u cannot clear chrome. Verified against tmux directly:
 * printing a dim string wider than the pane yields a continuation row with no SGR-2 prefix.
 */
function withoutFaintRuns(line: string, faintIn = false): { text: string; faintOut: boolean } {
  let out = "";
  let faint = faintIn;
  let cursor = 0;
  for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    if (!faint) out += line.slice(cursor, m.index);
    const codes = (m[1] ?? "").split(";").filter((c) => c !== "");
    for (const c of codes.length ? codes : ["0"]) {
      if (c === "2") faint = true;
      else if (c === "0" || c === "22") faint = false;
    }
    cursor = m.index + m[0].length;
  }
  if (!faint) out += line.slice(cursor);
  return { text: out, faintOut: faint };
}

/**
 * PROVABLY empty, judged on a STYLED (`capture-pane -e`) snapshot — the only view that can tell
 * Claude's ghost hint from residue.
 *
 * Since v2.1.x an empty composer is not blank: it renders `❯ ` plus a DIM (SGR 2) hint, and that hint
 * is the agent's own last prompt (`❯ approve the pending travel bookings`). Stripped of styling it is
 * indistinguishable from a parked draft, so on 2026-08-02 the pre-send guard called four agents' clean
 * panes dirty and refused 144 deliveries — C-u cannot clear chrome, so every clear-verify round failed
 * and the bus stayed wedged until the sessions were relaunched.
 *
 * Whitelisting hint strings cannot work: the hint IS a prompt, so the "safe" set is the residue set.
 * Faintness is the evidence — a composer that actually holds text renders it at normal intensity.
 *
 * The 8e35fb2 invariant is unchanged: a box we cannot SEE is never empty. Only the reading of a
 * VISIBLE box's content is styling-aware, and `[Pasted text #N]` stays disqualifying whatever its
 * intensity, because that placeholder stands for buffered content, not chrome.
 */
export function inputBoxProvablyEmptyStyled(styledPane: string): boolean {
  const styledLines = styledPane.split("\n");
  const range = liveInputBoxRange(styledLines.map(stripPaneStyling));
  if (range == null) return false; // cannot see the box => cannot claim it is empty
  // Faint state threads DOWN the box: a hint that soft-wraps leaves its continuation rows unmarked.
  // It starts false at the top separator, so nothing outside the box can make box content look dim.
  let faint = false;
  for (let i = range.top + 1; i < range.bottom; i++) {
    const styled = styledLines[i]!;
    if (PENDING_PASTE_RX.test(stripPaneStyling(styled))) return false;
    const { text, faintOut } = withoutFaintRuns(styled, faint);
    faint = faintOut;
    if (boxLineText(stripPaneStyling(text)) !== "") return false;
  }
  return true;
}

/** True only in the clean "ready to accept a fresh prompt" state. */
export function isReadyForPrompt(pane: string): boolean {
  return detectPaneState(pane) === "idle";
}

/**
 * Return the inner content of the live input box (between the two most recent
 * box separators above the idle footer), or null when there is no live box.
 * Bounded so a parked input in scrollback is never mistaken for live state.
 */
export function liveInputBox(pane: string): string | null {
  const lines = pane.split("\n");
  const range = liveInputBoxRange(lines);
  return range == null ? null : lines.slice(range.top + 1, range.bottom).join("\n");
}

/**
 * Line indices of the two separators bounding the live input box, or null when there is no live box
 * (no footer, or the box's top separator has scrolled off the capture). Shared so the plain and
 * styled readers can never disagree about WHERE the box is, only about what its content means.
 */
function liveInputBoxRange(lines: string[]): { top: number; bottom: number } | null {
  const footerIdx = lines.findIndex((l) => IDLE_FOOTER_RX.test(l));
  if (footerIdx < 0) return null;
  let bottomSep = -1;
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i]!)) {
      bottomSep = i;
      break;
    }
  }
  if (bottomSep <= 0) return null;
  let topSep = -1;
  for (let i = bottomSep - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i]!)) {
      topSep = i;
      break;
    }
  }
  if (topSep < 0) return null;
  return { top: topSep, bottom: bottomSep };
}

/**
 * True when a just-sent prompt appears stuck in the input box (placeholder or
 * verbatim parked text) and a retry-Enter is warranted.
 *
 * Accepts a plain OR a styled (`capture-pane -e`) snapshot. Styling matters here for the same reason
 * as in the emptiness gate, only inverted: after a SUCCESSFUL submit the composer's dim ghost hint is
 * the prompt we just sent, so a plain snapshot shows the payload sitting in the box and this reports
 * "still stuck" about a message that landed. Enter on a ghost hint does nothing (verified against
 * v2.1.220), so the retries were harmless in themselves — but the budget then ran out and the caller
 * reported submit-give-up, which requeues an already-delivered message. Busy/footer detection still
 * runs on the fully-stripped text so a dim spinner can never be de-fainted out of existence.
 */
export function shouldRetrySubmit(pane: string, payloadHint: string, opts: { minHintChars?: number } = {}): boolean {
  if (!pane || !pane.trim()) return false;
  const lines = pane.split("\n");
  const plainLines = lines.map(stripPaneStyling);
  const plain = plainLines.join("\n");
  for (const rx of BUSY_INDICATORS) if (rx.test(plain)) return false;
  if (!IDLE_FOOTER_RX.test(plain)) return false;
  const range = liveInputBoxRange(plainLines);
  if (range == null) return false;
  let faint = false;
  const box = lines
    .slice(range.top + 1, range.bottom)
    .map((l) => {
      const r = withoutFaintRuns(l, faint);
      faint = r.faintOut;
      return stripPaneStyling(r.text);
    })
    .join("\n");
  if (PENDING_PASTE_RX.test(plainLines.slice(range.top + 1, range.bottom).join("\n"))) return true;
  const rawMin = opts.minHintChars;
  const safeMin = typeof rawMin === "number" && Number.isFinite(rawMin) ? rawMin : 16;
  const minHint = Math.max(safeMin, 1);
  if (payloadHint.length < minHint) return false;
  return box.includes(payloadHint);
}

/**
 * POSITIVE proof a just-sent prompt was actually SUBMITTED — not merely "not visibly parked".
 *
 * The confirm loop used to call a submit "done" whenever shouldRetrySubmit returned false. But that
 * function also returns false when the input box cannot be LOCATED (liveInputBoxRange === null), and the
 * box goes unlocatable exactly when a TALL parked payload pushes its top separator off the captured pane.
 * So a long owner message that never submitted (its Enter was dropped) read as delivered and the agent
 * sat silent — dwight (a message plus a `[Pasted text]` block of 8 photos) and marveen, 2026-08-04, ~20
 * min of owner-visible silence. This is the same "a box we cannot SEE is not proof" inversion the PRE-send
 * gate already fixed in inputBoxProvablyEmptyStyled; the confirm side needs the mirror of it.
 *
 * Submission is proven ONLY by a positive signal: the agent has started a turn (a busy indicator is up),
 * or the composer is PROVABLY EMPTY (styling-aware, so the dim ghost hint a successful submit leaves is
 * de-fainted to empty and never mistaken for parked text). Anything else — payload still parked, box not
 * locatable, a modal, an unknown frame — is NOT proof. Takes the STYLED (`capture-pane -e`) snapshot, the
 * only view the emptiness check can trust; the busy scan runs on the fully-stripped text.
 */
export function submitConfirmed(styledPane: string | null): boolean {
  if (!styledPane || !styledPane.trim()) return false;
  const plain = stripPaneStyling(styledPane);
  for (const rx of BUSY_INDICATORS) if (rx.test(plain)) return true;
  return inputBoxProvablyEmptyStyled(styledPane);
}

/**
 * True when it is SAFE to press Enter again during submit-confirm: the pane is idle (a live idle footer,
 * no busy signal). Enter on such a pane either submits parked text or no-ops on the dim ghost hint — both
 * harmless. Deliberately does NOT require the payload to be locatable, so a tall parked payload (top
 * separator scrolled off) still gets its retry-Enters instead of being abandoned on the first sample.
 *
 * The load-bearing exclusion is a MODAL: a usage-limit or permission menu carries NO idle footer, so it
 * fails this test and never receives an Enter — pressing Enter there could select "Upgrade" (a charge to
 * the owner) or blind-approve a dangerous action. Those panes fall through to give-up (requeue) and are
 * left for the session-hygiene sweeper, which alone knows the safe keystroke.
 */
export function safeToResubmit(pane: string): boolean {
  if (!pane || !pane.trim()) return false;
  const plain = stripPaneStyling(pane);
  for (const rx of BUSY_INDICATORS) if (rx.test(plain)) return false;
  return IDLE_FOOTER_RX.test(plain);
}

export type SubmitFollowupAction = "retry-enter" | "done" | "give-up";

/**
 * Decide the next action of the post-send confirm loop. Pure so the I/O loop in
 * session-manager stays trivially testable.
 *   - pane === null (capture failed)                       -> give-up (requeue)
 *   - submission POSITIVELY confirmed (busy / box empty)   -> done
 *   - unconfirmed, budget spent                            -> give-up (requeue)
 *   - unconfirmed, pane safe to Enter, budget remaining    -> retry-enter
 *   - unconfirmed, pane NOT safe to Enter (modal/unknown)  -> give-up (requeue)
 *
 * "done" now requires POSITIVE proof (submitConfirmed), not just the absence of a visibly-parked payload.
 * That closes the false-delivery where a tall unsubmitted message (input box unlocatable) read as
 * delivered and stranded the agent for ~20 min (dwight + marveen, 2026-08-04). An unproven submit is
 * retried while the pane is safe to Enter, and otherwise requeued WHOLE — never silently marked delivered.
 * payloadHint is retained for signature stability; the decision no longer depends on matching it, because
 * matching a visibly-parked payload is exactly what failed when the box scrolled out of view.
 */
export function decideSubmitFollowup(
  pane: string | null,
  payloadHint: string,
  attempt: number,
  maxAttempts: number
): SubmitFollowupAction {
  if (pane == null) return "give-up";
  if (submitConfirmed(pane)) return "done";
  if (attempt >= maxAttempts) return "give-up";
  if (safeToResubmit(pane)) return "retry-enter";
  return "give-up";
}
