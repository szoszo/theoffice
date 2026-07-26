import { describe, it, expect } from "vitest";
import { parseInbound, prepareInboundDelivery, parseDeri6Signal } from "./slack-ingest.js";
import { isAllowedSender } from "./access.js";

describe("prepareInboundDelivery (non-owner sender identity + routing safety)", () => {
  // SECURITY: a non-owner allowed contact (e.g. Hanga via allowFrom) must never be mistaken for the owner,
  // and a reply must always go to the actual sender — never to the owner's DM. (2026-06-20 orchid-cancel bug.)
  const base = "cancel the orchid watering task";
  const ownerName = "Szoszo";

  it("non-owner allowed sender: banner NAMES them, warns NOT-owner, reply routes to the SENDER", () => {
    const { prompt, replyUser } = prepareInboundDelivery({
      basePrompt: base, senderId: "U_hanga", ownerId: "U_owner", ownerName, senderName: "Hanga",
    });
    expect(prompt).toContain("Hanga"); // names them
    expect(prompt).toContain("NOT your owner");
    expect(prompt).toContain(ownerName);
    expect(prompt).toMatch(/owner-only/i); // warns against owner-only authority
    expect(prompt.endsWith(base)).toBe(true); // original message preserved, after the banner
    expect(prompt).not.toBe(base);
    expect(replyUser).toBe("U_hanga"); // reply goes to the sender, NOT the owner
  });

  it("owner: NO banner, prompt unchanged, reply routes to owner", () => {
    const { prompt, replyUser } = prepareInboundDelivery({
      basePrompt: base, senderId: "U_owner", ownerId: "U_owner", ownerName, senderName: ownerName,
    });
    expect(prompt).toBe(base); // owner flow unaffected
    expect(replyUser).toBe("U_owner");
  });

  it("no owner configured (setup mode): defaults to NON-owner (secure), still routes to sender", () => {
    const { prompt, replyUser } = prepareInboundDelivery({
      basePrompt: base, senderId: "U_x", ownerId: undefined, ownerName, senderName: "X",
    });
    expect(prompt).toContain("NOT your owner"); // never silently grant owner authority
    expect(replyUser).toBe("U_x");
  });
});

describe("parseInbound", () => {
  const dm = { type: "message", channel_type: "im", channel: "D123", user: "U_owner", text: "hey Charly", ts: "1.1" };

  it("accepts a real DM", () => {
    expect(parseInbound(dm, "U_charly")).toEqual({ text: "hey Charly", channel: "D123", user: "U_owner", ts: "1.1", files: [] });
  });

  it("accepts a file upload (subtype file_share) with a caption", () => {
    const ev = {
      ...dm,
      subtype: "file_share",
      text: "look at this",
      files: [{ id: "F1", name: "photo.png", mimetype: "image/png", url_private_download: "https://files.slack.com/F1/photo.png" }],
    };
    expect(parseInbound(ev, "U_charly")).toEqual({
      text: "look at this",
      channel: "D123",
      user: "U_owner",
      ts: "1.1",
      files: [{ id: "F1", name: "photo.png", mimetype: "image/png", urlPrivateDownload: "https://files.slack.com/F1/photo.png" }],
    });
  });

  it("accepts a file upload with NO caption (empty text but files present)", () => {
    const ev = { ...dm, subtype: "file_share", text: "", files: [{ id: "F2", name: "doc.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/F2/doc.pdf" }] };
    const out = parseInbound(ev, "U_charly");
    expect(out?.text).toBe("");
    expect(out?.files).toEqual([{ id: "F2", name: "doc.pdf", mimetype: "application/pdf", urlPrivateDownload: "https://files.slack.com/F2/doc.pdf" }]);
  });

  it("rejects the agent's own echo", () => {
    expect(parseInbound({ ...dm, user: "U_charly" }, "U_charly")).toBeNull();
  });

  it("rejects bot messages", () => {
    expect(parseInbound({ ...dm, bot_id: "B1" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, subtype: "bot_message" }, "U_charly")).toBeNull();
  });

  it("rejects edits / system subtypes", () => {
    expect(parseInbound({ ...dm, subtype: "message_changed" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, subtype: "channel_join" }, "U_charly")).toBeNull();
  });

  it("rejects empty / non-message / malformed", () => {
    expect(parseInbound({ ...dm, text: "   " }, "U_charly")).toBeNull();
    expect(parseInbound({ type: "app_home_opened" }, "U_charly")).toBeNull();
    expect(parseInbound(null, "U_charly")).toBeNull();
    expect(parseInbound({ type: "message", text: "hi" }, "U_charly")).toBeNull(); // no channel/user/ts
  });

  it("trims text", () => {
    expect(parseInbound({ ...dm, text: "  spaced  " }, "U_charly")?.text).toBe("spaced");
  });

  // Channel @-mention support (PR#11 feature port). RED-FIRST: pre-port parseInbound only knew `message`,
  // so the app_mention accept fails and a non-"im" channel message was wrongly accepted.
  it("accepts a channel app_mention and strips the bot's own mention from the text", () => {
    const ev = { type: "app_mention", channel: "C42", user: "U_owner", text: "<@U_charly> what's the weather", ts: "2.2" };
    expect(parseInbound(ev, "U_charly")).toEqual({ text: "what's the weather", channel: "C42", user: "U_owner", ts: "2.2", files: [] });
  });

  it("strips a labelled mention and collapses whitespace", () => {
    const ev = { type: "app_mention", channel: "C42", user: "U_owner", text: "<@U_charly|charly>   ping ", ts: "2.3" };
    expect(parseInbound(ev, "U_charly")?.text).toBe("ping");
  });

  it("ignores an app_mention that is only the bot mention (nothing to answer)", () => {
    expect(parseInbound({ type: "app_mention", channel: "C42", user: "U_owner", text: "<@U_charly>", ts: "2.4" }, "U_charly")).toBeNull();
  });

  it("ignores a self app_mention (the bot mentioning itself)", () => {
    expect(parseInbound({ type: "app_mention", channel: "C42", user: "U_charly", text: "<@U_charly> hi", ts: "2.5" }, "U_charly")).toBeNull();
  });

  it("DM-only: rejects a channel `message` so it can't double-fire alongside its app_mention", () => {
    const chanMsg = { type: "message", channel_type: "channel", channel: "C42", user: "U_owner", text: "hello all", ts: "2.6" };
    expect(parseInbound(chanMsg, "U_charly")).toBeNull();
  });

  it("still accepts a DM whose channel_type is absent (backward-compatible)", () => {
    const ev = { type: "message", channel: "D9", user: "U_owner", text: "hi", ts: "2.7" };
    expect(parseInbound(ev, "U_charly")?.channel).toBe("D9");
  });
});

describe("parseDeri6Signal (scoped bot-message exception — deri6 OCR + bill triggers)", () => {
  // SECURITY: the global bot-drop in parseInbound stays intact; this is the ONE narrow exception —
  // a bot post in the dedicated channel carrying the shared secret + a valid UUID, delivered as
  // DATA ONLY (a fixed prompt template, never the bot's free text). Adversarial coverage per Toby's
  // review: wrong channel / not-a-bot / bad-or-missing secret / non-UUID / non-object JSON are all dropped.
  // The `type` field is a strict enum (ocr|bill, absent=ocr); anything else is rejected.
  const sig = { channelId: "C_ocr", secret: "s3cr3t-signal" };
  const UUID = "0adb4dcd-6677-4a34-a862-251687cd4e39";
  const signal = (over: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}) => ({
    type: "message",
    channel: sig.channelId,
    bot_id: "B_webhook",
    text: JSON.stringify({ submission_id: UUID, signal_secret: sig.secret, ...payloadOver }),
    ...over,
  });

  it("accepts a valid bot signal: absent type defaults to ocr (back-compat)", () => {
    expect(parseDeri6Signal(signal(), sig)).toEqual({ submissionId: UUID, channel: sig.channelId, type: "ocr", sorszam: null });
  });

  it("honors explicit type: ocr and bill (sorszam null for non-archive)", () => {
    expect(parseDeri6Signal(signal({}, { type: "ocr" }), sig)).toEqual({ submissionId: UUID, channel: sig.channelId, type: "ocr", sorszam: null });
    expect(parseDeri6Signal(signal({}, { type: "bill" }), sig)).toEqual({ submissionId: UUID, channel: sig.channelId, type: "bill", sorszam: null });
  });

  it("archive: needs a strict YYYY/NNN sorszám alongside the UUID", () => {
    expect(parseDeri6Signal(signal({}, { type: "archive", sorszam: "2026/001" }), sig))
      .toEqual({ submissionId: UUID, channel: sig.channelId, type: "archive", sorszam: "2026/001" });
    // missing / malformed / injection-y sorszám → dropped (the only extra value interpolated downstream)
    for (const bad of [undefined, "2026-001", "2026/1", "2026/001/x", "../../x", "2026/001; rm", 12, { s: 1 }]) {
      expect(parseDeri6Signal(signal({}, { type: "archive", sorszam: bad }), sig)).toBeNull();
    }
  });

  it("REJECTS an unknown or non-string type (never default-accept a malformed signal)", () => {
    expect(parseDeri6Signal(signal({}, { type: "exec" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { type: "OCR" }), sig)).toBeNull(); // case-sensitive enum
    expect(parseDeri6Signal(signal({}, { type: "Archive" }), sig)).toBeNull(); // case-sensitive
    expect(parseDeri6Signal(signal({}, { type: 1 }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { type: null }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { type: { evil: true } }), sig)).toBeNull();
  });

  it("bill AND archive still pass EVERY other gate (bad UUID / wrong secret / wrong channel → null)", () => {
    expect(parseDeri6Signal(signal({}, { type: "bill", submission_id: "nope" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { type: "bill", signal_secret: "wrong" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({ channel: "C_other" }, { type: "bill" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { type: "archive", sorszam: "2026/001", submission_id: "nope" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { type: "archive", sorszam: "2026/001", signal_secret: "wrong" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({ channel: "C_other" }, { type: "archive", sorszam: "2026/001" }), sig)).toBeNull();
  });

  it("feature disabled (no sig) → null, path inert", () => {
    expect(parseDeri6Signal(signal(), undefined)).toBeNull();
  });

  it("wrong channel → null even with the correct secret (channel gate is independent)", () => {
    expect(parseDeri6Signal(signal({ channel: "C_other" }), sig)).toBeNull();
  });

  it("not a bot post (human message, no bot_id) → null", () => {
    const ev = signal();
    delete (ev as Record<string, unknown>).bot_id;
    expect(parseDeri6Signal(ev, sig)).toBeNull();
  });

  it("non-message event type → null", () => {
    expect(parseDeri6Signal(signal({ type: "reaction_added" }), sig)).toBeNull();
  });

  it("missing / wrong secret → null (secret gate)", () => {
    expect(parseDeri6Signal(signal({}, { signal_secret: "wrong" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({ text: JSON.stringify({ submission_id: UUID }) }), sig)).toBeNull();
  });

  it("correct secret but non-UUID submission_id → null (strict UUID, nothing else trusted)", () => {
    expect(parseDeri6Signal(signal({}, { submission_id: "not-a-uuid" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { submission_id: "../../etc/passwd" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({}, { submission_id: 12345 }), sig)).toBeNull();
  });

  it("non-object JSON payloads never throw and are dropped (Toby null-guard: null/array/number/string/bool)", () => {
    for (const t of ["null", "[1,2,3]", "42", '"a string"', "true"]) {
      expect(parseDeri6Signal(signal({ text: t }), sig)).toBeNull();
    }
  });

  it("malformed / empty / missing text → null (never throws)", () => {
    expect(parseDeri6Signal(signal({ text: "{not json" }), sig)).toBeNull();
    expect(parseDeri6Signal(signal({ text: "" }), sig)).toBeNull();
    expect(parseDeri6Signal({ type: "message", channel: sig.channelId, bot_id: "B1" }, sig)).toBeNull();
    expect(parseDeri6Signal(null, sig)).toBeNull();
  });
});

// SECURITY GATE for the NEW channel input surface: an @-mention lets anyone in a shared channel reach an
// agent, so the app_mention path MUST pass through the SAME allowed-sender gate as a DM and cannot bypass
// it. This composes the two real functions EXACTLY as the shared handler does (parseInbound -> isAllowedSender,
// slack-ingest.ts). RED-FIRST: without the app_mention port, parseInbound returns null for a mention, so an
// allowed user's @-mention would be dropped (the "accepts owner/allow-listed" case fails) — i.e. the port is
// required for a mention to reach the gate at all, and the gate then still rejects non-allowed senders.
describe("app_mention auth gate (new channel surface can't bypass isAllowedSender)", () => {
  const OWNER = "U_owner";
  const EXT = "U_ext";
  const BOT = "U_charly";
  const mention = (user: string) => ({ type: "app_mention", channel: "C1", user, text: "<@U_charly> do a thing", ts: "9.9" });
  // mirrors slack-ingest's shared handler: parse, then gate on the SENDER's id.
  const handlerAccepts = (event: unknown, allowFrom: string[] | undefined) => {
    const p = parseInbound(event, BOT);
    return !!p && isAllowedSender(p.user, allowFrom, OWNER);
  };

  it("REJECTS a non-allowed user's channel @-mention (same drop as a non-allowed DM)", () => {
    expect(handlerAccepts(mention("U_random"), undefined)).toBe(false); // not owner, no allowFrom
    expect(handlerAccepts(mention(EXT), [])).toBe(false); // empty allowFrom
    expect(handlerAccepts(mention("U_random"), [EXT])).toBe(false); // allow-listed someone else, not them
  });

  it("accepts the owner's and an allow-listed user's @-mention (feature still works for the right people)", () => {
    expect(handlerAccepts(mention(OWNER), undefined)).toBe(true);
    expect(handlerAccepts(mention(EXT), [EXT])).toBe(true);
  });

  it("parseInbound surfaces the MENTIONER as the sender, so the gate checks the real person (not the bot)", () => {
    expect(parseInbound(mention("U_random"), BOT)?.user).toBe("U_random");
  });
});
