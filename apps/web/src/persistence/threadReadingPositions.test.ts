import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  configureThreadReadingPositionPersistence,
  readThreadReadingAnchor,
  rememberThreadReadingAnchor,
  rememberThreadReadingAtEnd,
  threadReadingPositions,
} from "./threadReadingPositions";

afterEach(() => {
  configureThreadReadingPositionPersistence(null);
  threadReadingPositions.clear();
});

describe("thread reading positions", () => {
  it("remembers an anchor with no persistence registered", () => {
    rememberThreadReadingAnchor("environment-local:thread-a", {
      rowId: "message-3",
      offsetWithinRow: 40,
    });
    expect(readThreadReadingAnchor("environment-local:thread-a")).toMatchObject({
      rowId: "message-3",
      offsetWithinRow: 40,
    });
    rememberThreadReadingAtEnd("environment-local:thread-a");
    expect(readThreadReadingAnchor("environment-local:thread-a")).toBeNull();
  });

  it("asks the registered persistence to save only a change", () => {
    const changed = vi.fn();
    configureThreadReadingPositionPersistence(changed);

    rememberThreadReadingAnchor("thread-a", { rowId: "message-3", offsetWithinRow: 40 });
    // The timeline re-reports its anchor on every scroll and streaming render.
    rememberThreadReadingAnchor("thread-a", { rowId: "message-3", offsetWithinRow: 40 });
    expect(changed).toHaveBeenCalledOnce();

    rememberThreadReadingAnchor("thread-a", { rowId: "message-3", offsetWithinRow: 52 });
    expect(changed).toHaveBeenCalledTimes(2);

    rememberThreadReadingAtEnd("thread-a");
    rememberThreadReadingAtEnd("thread-a");
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
