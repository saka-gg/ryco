import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  NODE_BROWSER_INPUT_BATCH_LIMIT,
  NODE_BROWSER_TEXT_LIMIT,
  NodeBrowserCapability,
  NodeBrowserCommand,
  NodeBrowserInputRequest,
  NodeBrowserReadRequest,
} from "./nodeBrowser.ts";

const accepts = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
) => Schema.is(schema)(value);

describe("node browser contracts", () => {
  it("bounds input batches, text and coordinates", () => {
    const text = (length: number) => ({ type: "text", text: "x".repeat(length) });
    expect(
      accepts(NodeBrowserInputRequest, { tabId: "t-1", events: [text(NODE_BROWSER_TEXT_LIMIT)] }),
    ).toBe(true);
    expect(
      accepts(NodeBrowserInputRequest, {
        tabId: "t-1",
        events: [text(NODE_BROWSER_TEXT_LIMIT + 1)],
      }),
    ).toBe(false);
    expect(accepts(NodeBrowserInputRequest, { tabId: "t-1", events: [text(0)] })).toBe(false);
    const release = { type: "release" };
    expect(
      accepts(NodeBrowserInputRequest, {
        tabId: "t-1",
        events: Array.from({ length: NODE_BROWSER_INPUT_BATCH_LIMIT + 1 }, () => release),
      }),
    ).toBe(false);
    const wheel = { type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 20_000, modifiers: 0 };
    expect(accepts(NodeBrowserInputRequest, { tabId: "t-1", events: [wheel] })).toBe(false);
    const mouse = {
      type: "mouse",
      action: "down",
      x: Number.NaN,
      y: 1,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    };
    expect(accepts(NodeBrowserInputRequest, { tabId: "t-1", events: [mouse] })).toBe(false);
    expect(accepts(NodeBrowserInputRequest, { tabId: "../etc", events: [] })).toBe(false);
  });

  it("decodes an unavailability reason a newer node adds", () => {
    expect(
      accepts(NodeBrowserCapability, { available: false, reason: "host-setup-required" }),
    ).toBe(true);
    expect(accepts(NodeBrowserCapability, { available: false, reason: "x".repeat(65) })).toBe(
      false,
    );
  });

  it("bounds stills and viewport sizes", () => {
    const still = { type: "still", tabId: "t-1", maxWidth: 1280, maxHeight: 800, quality: 50 };
    expect(accepts(NodeBrowserReadRequest, still)).toBe(true);
    expect(accepts(NodeBrowserReadRequest, { ...still, maxWidth: 4000 })).toBe(false);
    expect(accepts(NodeBrowserReadRequest, { ...still, quality: 95 })).toBe(false);
    const resize = { type: "resize", tabId: "t-1", width: 1280, height: 800 };
    expect(accepts(NodeBrowserCommand, resize)).toBe(true);
    expect(accepts(NodeBrowserCommand, { ...resize, width: 5000 })).toBe(false);
    expect(accepts(NodeBrowserCommand, { type: "history", tabId: "t-1", delta: 2 })).toBe(false);
  });
});
