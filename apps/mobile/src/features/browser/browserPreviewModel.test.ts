import { describe, expect, it } from "vite-plus/test";

import type { ThreadLocalServer } from "@ryco/contracts";
import type { NodeBrowserTab } from "@ryco/contracts/node-browser";

import {
  clickEvents,
  nodeBrowserUnavailableMessage,
  pagePoint,
  previewViewport,
  scrollEvent,
  serverRows,
  tabForUrl,
  tabLabel,
  tabsInScope,
  typingEvents,
  viewportToRestore,
} from "./browserPreviewModel";

const tab = (overrides: Partial<NodeBrowserTab>): NodeBrowserTab =>
  ({
    id: "t1",
    scope: "/repo",
    url: "http://localhost:3000/",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    state: "live",
    viewport: null,
    dialog: null,
    error: null,
    ...overrides,
  }) as NodeBrowserTab;

const image = { cssWidth: 390, cssHeight: 780, viewWidth: 195, viewHeight: 390 };

describe("browser preview", () => {
  it("keeps the project's tabs and reuses one already on the address", () => {
    const tabs = [tab({ id: "a" }), tab({ id: "b", scope: "/other" })];
    expect(tabsInScope(tabs, "/repo").map((each) => each.id)).toEqual(["a"]);
    expect(tabForUrl(tabs, "http://localhost:3000")?.id).toBe("a");
    expect(tabForUrl(tabs, "http://localhost:4000/")).toBeNull();
  });

  it("labels tabs by title, else host", () => {
    expect(tabLabel(tab({ title: " Vite App " }))).toBe("Vite App");
    expect(tabLabel(tab({}))).toBe("localhost:3000");
  });

  it("maps a tap on the drawn still to page pixels", () => {
    expect(pagePoint(image, 50, 100)).toEqual({ x: 100, y: 200 });
    expect(pagePoint(image, 500, -5)).toEqual({ x: 389, y: 0 });
    expect(
      clickEvents({ x: 1, y: 2 }).map((event) => (event as { action: string }).action),
    ).toEqual(["move", "down", "up"]);
  });

  it("turns a drag into a wheel scroll the other way", () => {
    expect(scrollEvent(image, { x: 10, y: 10 }, 0, -50)).toMatchObject({
      type: "wheel",
      deltaX: 0,
      deltaY: 100,
    });
    expect(scrollEvent(image, { x: 10, y: 10 }, 0, 0)).toBeNull();
  });

  it("types text and presses Enter when asked", () => {
    expect(typingEvents("hi", true).map((event) => event.type)).toEqual(["text", "key", "key"]);
    expect(typingEvents("", false)).toEqual([]);
  });

  it("sizes the tab to the preview area, never below the node's minimum", () => {
    expect(previewViewport(402.4, 690)).toEqual({ width: 402, height: 690 });
    expect(previewViewport(200, 100)).toEqual({ width: 320, height: 240 });
    expect(previewViewport(0, 500)).toBeNull();
  });

  it("gives a shared tab its earlier size back", () => {
    const own = { width: 402, height: 690 };
    expect(viewportToRestore({ width: 1280, height: 800 }, own)).toEqual({
      width: 1280,
      height: 800,
    });
    expect(viewportToRestore(own, own)).toBeNull();
    expect(viewportToRestore(null, own)).toBeNull();
  });

  it("explains why previews are off", () => {
    expect(nodeBrowserUnavailableMessage({ available: false, reason: "installing" })).toContain(
      "installing",
    );
    expect(nodeBrowserUnavailableMessage(null)).toContain("Update Ryco");
  });

  it("lists servers by port with their page title", () => {
    const server = (port: number, pageTitle: string | null): ThreadLocalServer =>
      ({
        pid: port,
        startTimeMs: 1,
        port,
        host: "127.0.0.1",
        url: `http://localhost:${port}/`,
        processName: "node",
        pageTitle,
        origin: "terminal",
      }) as ThreadLocalServer;
    expect(serverRows([server(5173, "Vite"), server(3000, null)]).map((row) => row.title)).toEqual([
      "node",
      "Vite",
    ]);
  });
});
