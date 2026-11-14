import { describe, expect, it } from "vite-plus/test";

import { buildHeldTimelineMessages, resolveQueuedMessagesWait } from "./ChatView.queue";

describe("resolveQueuedMessagesWait", () => {
  it("does not wait off a hosted connection or while commands are allowed", () => {
    expect(
      resolveQueuedMessagesWait({ hosted: false, allowed: false, reason: null }, false, "Mac"),
    ).toBeNull();
    expect(
      resolveQueuedMessagesWait({ hosted: true, allowed: true, reason: null }, false, "Mac"),
    ).toBeNull();
  });

  it("names why queued messages wait", () => {
    expect(
      resolveQueuedMessagesWait({ hosted: true, allowed: false, reason: "Syncing" }, true, "Mac"),
    ).toEqual({ kind: "connecting", copy: "Sends when Mac is ready", failure: "Syncing" });
    expect(
      resolveQueuedMessagesWait(
        { hosted: true, allowed: false, reason: null, kind: "role" },
        false,
        "Mac",
      )?.kind,
    ).toBe("role");
    expect(
      resolveQueuedMessagesWait({ hosted: true, allowed: false, reason: null }, false, "Mac"),
    ).toEqual({ kind: "unavailable", copy: "Commands are unavailable on this connection." });
  });
});

describe("buildHeldTimelineMessages", () => {
  it("shows nothing without held sends", () => {
    expect(buildHeldTimelineMessages(new Map())).toEqual([]);
  });
});
