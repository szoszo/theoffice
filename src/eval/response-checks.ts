/**
 * Executable form of the output contract the shipped persona states in prose (issue #21 §4, tier 2).
 *
 * `templates/product/agent.CLAUDE.md` tells every agent how to write to the owner: Slack mrkdwn, no
 * markdown headings, no em dashes, no AI throat-clearing, never a terminal menu. Those rules are
 * currently enforced only by the model's goodwill, and a persona edit that drops one shows up days
 * later as a weird Slack message — the exact "blind flying" the issue describes.
 *
 * These checks make the rules mechanically decidable, so a case set can be scored without a human
 * reading every reply. Each returns null when clean, or a one-line reason when violated.
 *
 * Deliberately NOT a style opinion of mine: every rule here traces to a line in the shipped persona
 * or an owner correction. Adding a check nobody asked for would turn a regression gate into taste.
 */

export type Check = (text: string) => string | null;

/** Slack renders `*bold*`; `**bold**` shows the asterisks literally. */
export const noDoubleAsteriskBold: Check = (t) =>
  /\*\*[^*\n]+\*\*/.test(t) ? "uses **double-asterisk** bold, which Slack renders literally" : null;

/** Slack does not render markdown headings; they arrive as a stray '#'. */
export const noMarkdownHeadings: Check = (t) =>
  /^\s{0,3}#{1,6}\s+\S/m.test(t) ? "uses a markdown '#' heading, which Slack does not render" : null;

/** Explicit standing rule in the persona, and a repeated owner correction. */
export const noEmDash: Check = (t) => (/[—–]/.test(t) ? "contains an em/en dash" : null);

/** Slack shows `[text](url)` verbatim; the mrkdwn form is `<url|text>`. */
export const noMarkdownLinks: Check = (t) =>
  /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(t) ? "uses a [text](url) markdown link, which Slack shows verbatim" : null;

/** Tables do not render in Slack. A pipe row is the giveaway. */
export const noMarkdownTables: Check = (t) =>
  // The separator row carries the inner column pipes too (`| --- | --- |`), so they must be part of
  // the allowed character set — omitting them silently matched nothing.
  /^\s*\|.*\|\s*$/m.test(t) && /^\s*\|[\s:|-]+\|\s*$/m.test(t) ? "contains a markdown table, which Slack cannot render" : null;

/** The persona's banned openers. Anchored to the start so a quotation of one is not flagged. */
const CLICHES = [
  /^\s*certainly[!,.]/i,
  /^\s*great question[!,.]/i,
  /^\s*i'?d be happy to help/i,
  /^\s*as an ai\b/i,
  /^\s*of course[!,.]/i,
  /^\s*absolutely[!,.]/i,
];
export const noAiCliche: Check = (t) => {
  const hit = CLICHES.find((rx) => rx.test(t));
  return hit ? "opens with an AI cliché the persona bans" : null;
};

/**
 * The owner is on Slack and cannot answer a terminal menu — offering one hangs the agent. Matches a
 * numbered-choice block, which is the shape that actually strands a session.
 */
export const noInteractiveMenu: Check = (t) =>
  /^\s*(?:\[?1[).\]]|\(1\))\s+\S.*\n(?:.*\n)?\s*(?:\[?2[).\]]|\(2\))\s+\S/m.test(t) &&
  /\b(choose|select|which (one|option)|pick one|reply with the number)\b/i.test(t)
    ? "offers a numbered menu to pick from, which the owner cannot answer on Slack"
    : null;

export const ALL_CHECKS: Record<string, Check> = {
  noDoubleAsteriskBold,
  noMarkdownHeadings,
  noEmDash,
  noMarkdownLinks,
  noMarkdownTables,
  noAiCliche,
  noInteractiveMenu,
};

/** Run every check; returns the names that fired, in declaration order. */
export function violations(text: string): string[] {
  return Object.entries(ALL_CHECKS)
    .filter(([, check]) => check(text) !== null)
    .map(([name]) => name);
}
