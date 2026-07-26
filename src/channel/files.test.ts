import { describe, it, expect } from "vitest";
import { isSlackHost } from "./files.js";

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
