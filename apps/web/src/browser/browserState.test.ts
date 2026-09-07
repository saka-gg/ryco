import { expect, it } from "vitest";
import { normalizeBrowserUrl, projectBrowserKey } from "./browserState";
import { buildOpenBrowserSearch } from "../workspaceRouteSearch";
import { getRightPanelMode, parseRightPanelRouteSearch } from "../rightPanelRouteSearch";
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
it("keeps environment and project identities distinct", () => {
  expect(projectBrowserKey("a:b", "c")).not.toBe(projectBrowserKey("a", "b:c"));
});
it("opens the browser route and clears the previous file/diff panel", () => {
  const search = parseRightPanelRouteSearch({
    ...buildOpenBrowserSearch({ diff: "1", preview: "1", diffFilePath: "src/a.ts" }),
  });
  expect(getRightPanelMode(search)).toBe("browser");
  expect(search).toEqual({ workspaceOpen: "1", workspaceTab: "browser" });
});
