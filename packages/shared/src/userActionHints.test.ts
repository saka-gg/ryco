import { describe, expect, it } from "vite-plus/test";

import { isOpenableHintLink, userActionRequestHints } from "./userActionHints.ts";

const requestId = `user-action-${"a".repeat(32)}`;
const hint = (links: ReadonlyArray<string>, codes: ReadonlyArray<string>) => ({
  kind: "user-action.hint",
  payload: { requestId, links, codes },
});

describe("userActionRequestHints", () => {
  it("keeps each request's newest hint", () => {
    const hints = userActionRequestHints([
      hint(["https://example.com/old"], []),
      hint(["https://github.com/login/device"], ["ABCD-1234"]),
    ]);
    expect(hints.get(requestId)).toEqual({
      links: ["https://github.com/login/device"],
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
