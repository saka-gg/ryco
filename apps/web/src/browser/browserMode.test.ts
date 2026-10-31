import { describe, expect, it } from "vite-plus/test";

import { type BrowserModeInput, resolveBrowserMode } from "./browserMode";

const web: BrowserModeInput = {
  nativeBrowser: false,
  ownBackend: false,
  nodeBrowserAvailable: true,
  role: "owner",
  frameSocket: true,
  side: "node",
};
const desktop: BrowserModeInput = { ...web, nativeBrowser: true };

describe("the Browser panel's browser", () => {
  it("shows node tabs on the web when the node runs them for an operator over a direct connection", () => {
    expect(resolveBrowserMode(web)).toEqual({ mode: "node", choice: false });
    expect(resolveBrowserMode({ ...web, role: "operator" })).toEqual({
      mode: "node",
      choice: false,
    });
  });

  it("falls back to the frame for viewers, hosted connections and nodes without node tabs", () => {
    for (const input of [
      { ...web, role: "viewer" as const },
      { ...web, role: null },
      { ...web, frameSocket: false },
      { ...web, nodeBrowserAvailable: false },
    ]) {
      expect(resolveBrowserMode(input)).toEqual({ mode: "iframe", choice: false });
    }
  });

  it("keeps the desktop app's own tabs for its own backend", () => {
    expect(resolveBrowserMode({ ...desktop, ownBackend: true })).toEqual({
      mode: "native",
      choice: false,
    });
  });

  it("offers the node or this computer for a remote environment, starting on the node", () => {
    expect(resolveBrowserMode(desktop)).toEqual({ mode: "node", choice: true });
    expect(resolveBrowserMode({ ...desktop, side: "computer" })).toEqual({
      mode: "native",
      choice: true,
    });
    // A viewer of the remote node gets no choice: only this computer's tabs.
    expect(resolveBrowserMode({ ...desktop, role: "viewer" })).toEqual({
      mode: "native",
      choice: false,
    });
  });
});
