import { expect, it } from "vitest";
import { projectBrowserKey } from "./browserState";
import { buildOpenBrowserSearch } from "../workspaceRouteSearch";
import { getRightPanelMode, parseRightPanelRouteSearch } from "../rightPanelRouteSearch";
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
