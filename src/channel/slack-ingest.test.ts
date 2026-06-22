import { describe, it, expect } from "vitest";
import { parseInbound } from "./slack-ingest.js";

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

  it("rejects a plain non-DM channel message (channels enter via app_mention, not message.channels)", () => {
    expect(parseInbound({ ...dm, channel_type: "channel" }, "U_charly")).toBeNull();
    expect(parseInbound({ ...dm, channel_type: "group" }, "U_charly")).toBeNull();
  });

  it("accepts an app_mention in a channel and strips the leading bot mention", () => {
    const ev = { type: "app_mention", channel: "C1", user: "U_owner", text: "<@U_charly> hello there", ts: "2.1" };
    expect(parseInbound(ev, "U_charly")).toEqual({ text: "hello there", channel: "C1", user: "U_owner", ts: "2.1", files: [] });
  });

  it("strips the bot mention wherever it appears and trims, incl. the <@id|label> form", () => {
    const ev = { type: "app_mention", channel: "C1", user: "U_owner", text: "hey <@U_charly|charly>  what's up", ts: "2.2" };
    expect(parseInbound(ev, "U_charly")?.text).toBe("hey what's up");
  });

  it("accepts an app_mention carrying a file attachment", () => {
    const ev = {
      type: "app_mention",
      channel: "C1",
      user: "U_owner",
      text: "<@U_charly> look",
      ts: "2.3",
      files: [{ id: "F9", name: "p.png", mimetype: "image/png", url_private: "https://files.slack.com/F9/p.png" }],
    };
    const out = parseInbound(ev, "U_charly");
    expect(out?.text).toBe("look");
    expect(out?.files).toEqual([{ id: "F9", name: "p.png", mimetype: "image/png", urlPrivateDownload: "https://files.slack.com/F9/p.png" }]);
  });

  it("rejects an app_mention that is only the mention with no real content", () => {
    expect(parseInbound({ type: "app_mention", channel: "C1", user: "U_owner", text: "<@U_charly>", ts: "2.4" }, "U_charly")).toBeNull();
  });

  it("rejects an app_mention from a bot", () => {
    expect(parseInbound({ type: "app_mention", channel: "C1", user: "U_x", text: "<@U_charly> hi", ts: "2.5", bot_id: "B1" }, "U_charly")).toBeNull();
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
});
