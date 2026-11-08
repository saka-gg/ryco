import { expect, it } from "vitest";

import { normalizeBrowserUrl } from "./browserUrl.ts";

it.each([
  "file:///tmp/page.html",
  "javascript://example.com/",
  "https://user:password@example.com/",
  "data:text/html,hello",
])("rejects non-browser targets: %s", (value) => {
  expect(() => normalizeBrowserUrl(value)).toThrow();
});

it("normalizes local addresses without losing their port or path", () => {
  expect(normalizeBrowserUrl("localhost:3000/test")).toBe("http://localhost:3000/test");
});
