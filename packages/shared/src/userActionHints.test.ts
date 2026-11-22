import { describe, expect, it } from "vite-plus/test";

import { hintLinkHost, isOpenableHintLink, userActionRequestHints } from "./userActionHints.ts";

const requestId = `user-action-${"a".repeat(32)}`;
const hint = (links: ReadonlyArray<string>, codes: ReadonlyArray<string>, host = "github.com") => ({
  kind: "user-action.hint",
  payload: { requestId, links: links.map((url) => ({ url, host })), codes },
});

describe("userActionRequestHints", () => {
  it("keeps each request's newest hint", () => {
    const hints = userActionRequestHints([
      hint(["https://example.com/old"], []),
      hint(["https://github.com/login/device"], ["ABCD-1234"]),
    ]);
    expect(hints.get(requestId)).toEqual({
      links: [{ url: "https://github.com/login/device", host: "github.com", international: false }],
      codes: ["ABCD-1234"],
    });
  });

  it("ignores other kinds and payloads that do not decode", () => {
    const hints = userActionRequestHints([
      { kind: "user-action.requested", payload: { requestId } },
      hint(["javascript:alert(1)"], []),
      hint([], ["has space"]),
    ]);
    expect(hints.size).toBe(0);
  });
});

describe("isOpenableHintLink", () => {
  it("opens http and https only", () => {
    expect(isOpenableHintLink("https://github.com/login/device")).toBe(true);
    expect(isOpenableHintLink("http://localhost:8080/callback")).toBe(true);
    expect(isOpenableHintLink("javascript:alert(1)")).toBe(false);
    expect(isOpenableHintLink("file:///etc/passwd")).toBe(false);
    expect(isOpenableHintLink("not a url")).toBe(false);
  });
});

describe("hintLinkHost", () => {
  it("names the real host, never a user name dressed as one", () => {
    expect(hintLinkHost("https://github.com/login/device")).toBe("github.com");
    expect(hintLinkHost("https://github.com@evil.example/login/device")).toBeNull();
    expect(hintLinkHost("https://user:pass@github.com/")).toBeNull();
  });

  it("shows an international look-alike host as punycode", () => {
    expect(hintLinkHost("https://gíthub.com/login/device")).toBe("xn--gthub-zsa.com");
  });

  it("shows the host the node stored and flags an international one, parsing nothing", () => {
    const hints = userActionRequestHints([
      hint(["https://xn--gthub-zsa.com/login/device"], [], "xn--gthub-zsa.com"),
    ]);
    expect(hints.get(requestId)?.links).toEqual([
      {
        url: "https://xn--gthub-zsa.com/login/device",
        host: "xn--gthub-zsa.com",
        international: true,
      },
    ]);
  });

  it("refuses a stored host that is not plain ASCII", () => {
    expect(userActionRequestHints([hint(["https://gíthub.com/x"], [], "gíthub.com")]).size).toBe(0);
  });
});
