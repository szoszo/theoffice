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
  return box
    .split("\n")
    .every((l) => l.replace(/^\s*❯/, "").trim() === "");
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
  return lines.slice(topSep + 1, bottomSep).join("\n");
}

/**
 * True when a just-sent prompt appears stuck in the input box (placeholder or
 * verbatim parked text) and a retry-Enter is warranted.
 */
export function shouldRetrySubmit(pane: string, payloadHint: string, opts: { minHintChars?: number } = {}): boolean {
  if (!pane || !pane.trim()) return false;
  for (const rx of BUSY_INDICATORS) if (rx.test(pane)) return false;
  if (!IDLE_FOOTER_RX.test(pane)) return false;
  const box = liveInputBox(pane);
  if (box == null) return false;
  if (PENDING_PASTE_RX.test(box)) return true;
  const rawMin = opts.minHintChars;
  const safeMin = typeof rawMin === "number" && Number.isFinite(rawMin) ? rawMin : 16;
  const minHint = Math.max(safeMin, 1);
  if (payloadHint.length < minHint) return false;
  return box.includes(payloadHint);
}

export type SubmitFollowupAction = "retry-enter" | "done" | "give-up";

/**
 * Decide the next action of the post-send confirm loop. Pure so the I/O loop in
 * session-manager stays trivially testable.
 *   - pane === null (capture failed)         -> give-up
 *   - prompt no longer parked / pane busy    -> done
 *   - parked + retry budget remaining        -> retry-enter
 *   - parked + budget spent                  -> give-up
 */
export function decideSubmitFollowup(
  pane: string | null,
  payloadHint: string,
  attempt: number,
  maxAttempts: number
): SubmitFollowupAction {
  if (pane == null) return "give-up";
  if (!shouldRetrySubmit(pane, payloadHint)) return "done";
  if (attempt >= maxAttempts) return "give-up";
  return "retry-enter";
}
