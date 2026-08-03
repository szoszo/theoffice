import { getDb } from "../db/index.js";

/**
 * Evidence gate for the `done` transition (issue #21 §1).
 *
 * The failure this addresses: an agent reports success on work that silently did not land. Nothing
 * in the platform ever asked it to prove otherwise, so whether a card was verified came down to
 * that agent's own diligence.
 *
 * This does NOT prove anything — nothing short of re-running the work does, and a determined agent
 * can write a sentence. What it changes is that the claim becomes explicit, attributable and
 * readable later, so a false one is a visible lie rather than a silent absence. That is the honest
 * ceiling here. The rejected alternative (require any comment) would have measured only that the
 * agent knows a comment is required, while making the board LOOK audited.
 */

/** Gestures that clear a presence check while saying nothing. Not a defence, just a floor. */
const EMPTY_GESTURES = new Set(["ok", "okay", "done", "yes", "y", "x", "fixed", "n/a", "na", "-", ".", "finished", "complete"]);
const MIN_EVIDENCE_CHARS = 12;

export interface EvidenceCheck {
  ok: boolean;
  error?: string;
  /** The evidence to persist, when the caller supplied fresh text. */
  verification?: string;
}

export function checkDoneEvidence(status: string, supplied: string | undefined, cardId: string): EvidenceCheck {
  if (status !== "done") return { ok: true };

  const text = (supplied ?? "").trim();
  if (text) {
    if (text.length < MIN_EVIDENCE_CHARS || EMPTY_GESTURES.has(text.toLowerCase())) {
      return {
        ok: false,
        error:
          "verification too thin — say what you RAN and what it returned (e.g. 'ran npm test: 471 passed'), not that it is done",
      };
    }
    return { ok: true, verification: text };
  }

  // No fresh evidence: accept only if the card already carries some, so re-closing a reopened card
  // does not demand the same sentence be retyped.
  const row = getDb().prepare(`SELECT verification FROM kanban_cards WHERE id = ?`).get(cardId) as
    | { verification: string | null }
    | undefined;
  // A missing card is the caller's 404 to raise. Answering "your evidence is bad" for a card that
  // does not exist would send whoever hit it looking in completely the wrong place.
  if (!row) return { ok: true };
  if (row.verification && row.verification.trim()) return { ok: true };

  return {
    ok: false,
    error:
      "a card may only reach 'done' with evidence: POST {\"status\":\"done\",\"verification\":\"<what you ran and what it returned>\"}",
  };
}
