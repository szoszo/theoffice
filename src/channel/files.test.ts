import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSlackHost, downloadFiles } from "./files.js";

// The Slack bot token is attached to the download URL, and url_private is a Slack-SUPPLIED field, so
// the host guard is a real credential-exfil defense: only *.slack.com / slack.com may receive the token.
describe("isSlackHost (bot-token exfil guard)", () => {
  it("allows genuine Slack hosts (incl. url_private_download's files.slack.com)", () => {
    expect(isSlackHost("https://files.slack.com/files-pri/T1-F1/x.png")).toBe(true); // the real url_private host
    expect(isSlackHost("https://slack.com/foo")).toBe(true);
    expect(isSlackHost("https://edgeapi.slack.com/x")).toBe(true);
    expect(isSlackHost("https://FILES.SLACK.COM/x")).toBe(true); // case-insensitive
    expect(isSlackHost("https://files.slack.com:443/x")).toBe(true); // port ignored (host is what matters)
    expect(isSlackHost("https://files.slack.com./x")).toBe(true); // trailing-dot FQDN folds to the same host
  });

  it("rejects non-Slack hosts (would leak the bot token)", () => {
    expect(isSlackHost("https://evil.com/steal")).toBe(false);
    expect(isSlackHost("http://1.2.3.4/steal")).toBe(false);
    expect(isSlackHost("https://notslack.com/x")).toBe(false);
  });

  it("rejects the suffix-attack look-alikes", () => {
    expect(isSlackHost("https://slack.com.evil.com/x")).toBe(false); // ends with .evil.com, not .slack.com
    expect(isSlackHost("https://evilslack.com/x")).toBe(false); // no dot boundary
    expect(isSlackHost("https://slack.com@evil.com/x")).toBe(false); // userinfo trick -> host is evil.com
    expect(isSlackHost("https://evil.com./x")).toBe(false); // trailing-dot doesn't help an attacker host
    expect(isSlackHost("https://slack.com.evil.com./x")).toBe(false); // suffix trap + trailing dot
    expect(isSlackHost("https://xslack.com/x")).toBe(false); // substring, no dot boundary
  });

  it("rejects malformed/relative urls", () => {
    expect(isSlackHost("not a url")).toBe(false);
    expect(isSlackHost("")).toBe(false);
  });
});

// Phone screenshots all arrive named "image.png": several in ONE message share the message ts too, so a
// ts+name path made them overwrite each other (the agent got the same path N times, only the last image on disk).
describe("downloadFiles (several attachments in one message)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps every same-named file apart, each with its own bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-test-"));
    try {
      vi.stubGlobal("fetch", async (url: string) =>
        new Response(Buffer.from(`bytes of ${url.split("/").pop()}`), { status: 200, headers: { "content-type": "image/png" } })
      );
      const files = ["F1", "F2", "F3"].map((id) => ({
        id,
        name: "image.png",
        mimetype: "image/png",
        urlPrivateDownload: `https://files.slack.com/files-pri/T1-${id}/download/${id}`,
      }));
      const out = await downloadFiles(files as never, "xoxb-test", dir, "1794487578_517909");
      expect(out.every((f) => f.ok)).toBe(true);
      expect(new Set(out.map((f) => f.path)).size).toBe(3);
      expect(out.map((f) => readFileSync(f.path, "utf8"))).toEqual(["bytes of F1", "bytes of F2", "bytes of F3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a single attachment keeps the plain ts-name path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-test-"));
    try {
      vi.stubGlobal("fetch", async () => new Response(Buffer.from("x"), { status: 200, headers: { "content-type": "image/png" } }));
      const out = await downloadFiles(
        [{ id: "F1", name: "image.png", mimetype: "image/png", urlPrivateDownload: "https://files.slack.com/x/F1" }] as never,
        "xoxb-test",
        dir,
        "1_2"
      );
      expect(out[0].path).toBe(join(dir, "1_2-image.png"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
