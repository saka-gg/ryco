import { describe, expect, it } from "vite-plus/test";

import { isWebLink } from "./webLink";

describe("isWebLink", () => {
  it("lets absolute http(s) links out, whatever their case", () => {
    expect(isWebLink("https://github.com/acme/app/pull/7")).toBe(true);
    expect(isWebLink("http://example.test/docs")).toBe(true);
    expect(isWebLink("HTTPS://example.test")).toBe(true);
  });

  it("keeps every other scheme in: calls, messages, other apps and Ryco's own routes", () => {
    for (const url of [
      "tel:+15550100",
      "sms:+15550100&body=hi",
      "mailto:someone@example.test",
      "facetime:someone@example.test",
      "ryco://threads/abc",
      "exp://127.0.0.1:8081",
      "shortcuts://run-shortcut?name=x",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/hosts",
    ]) {
      expect(isWebLink(url), url).toBe(false);
    }
  });

  it("keeps relative, protocol-relative, padded and malformed links in", () => {
    for (const url of [
      "",
      "docs/readme.md",
      "/docs/readme.md",
      "#section",
      "//example.test/path",
      " https://example.test",
      "https:example.test",
      "httpx://example.test",
    ]) {
      expect(isWebLink(url), url).toBe(false);
    }
  });
});
