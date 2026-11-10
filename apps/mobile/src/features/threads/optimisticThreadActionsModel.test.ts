import { describe, expect, it } from "vite-plus/test";

import { displayedThreadTitle, threadStopping } from "./optimisticThreadActionsModel";

describe("optimistic rename", () => {
  const pending = { from: "Old", to: "New" };

  it("shows the new title until the node's title moves off the old one", () => {
    expect(displayedThreadTitle("Old", null)).toBe("Old");
    expect(displayedThreadTitle("Old", pending)).toBe("New");
    // The echo, or anyone else's rename: the node's title wins and the overlay ends.
    expect(displayedThreadTitle("New", pending)).toBe("New");
    expect(displayedThreadTitle("Other", pending)).toBe("Other");
  });

  it("keeps the new title while the thread has no title yet", () => {
    expect(displayedThreadTitle(undefined, pending)).toBe("New");
    expect(displayedThreadTitle(null, null)).toBeNull();
  });
});

describe("optimistic stop", () => {
  it("shows stopping for the turn the Stop was for, until it ends", () => {
    const pending = { turnId: "turn-1" };
    expect(threadStopping({ pending, running: true, activeTurnId: "turn-1" })).toBe(true);
    expect(threadStopping({ pending, running: false, activeTurnId: "turn-1" })).toBe(false);
    // A new turn started: the Stop was for the one before.
    expect(threadStopping({ pending, running: true, activeTurnId: "turn-2" })).toBe(false);
    expect(threadStopping({ pending: null, running: true, activeTurnId: "turn-1" })).toBe(false);
  });

  it("covers a running session with no known turn, and not a turn that starts later", () => {
    const pending = { turnId: null };
    expect(threadStopping({ pending, running: true, activeTurnId: null })).toBe(true);
    expect(threadStopping({ pending, running: true, activeTurnId: "turn-9" })).toBe(false);
  });
});
