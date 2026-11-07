import type { TimelineEntry } from "@ryco/client-runtime/state/session";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => {}) }));

import { latestStreamingAssistantMessage, shouldTickStreamHaptic } from "./threadStreamHaptics";

function message(id: string, role: "user" | "assistant", text: string, streaming: boolean) {
  return {
    id,
    kind: "message",
    createdAt: "2026-11-07T10:00:00.000Z",
    message: { id, role, text, streaming, createdAt: "2026-11-07T10:00:00.000Z" },
  } as unknown as TimelineEntry;
}

describe("thread stream haptics", () => {
  it("finds the newest streaming assistant reply", () => {
    expect(
      latestStreamingAssistantMessage([
        message("a", "assistant", "done", false),
        message("b", "assistant", "typing", true),
        message("c", "user", "next", false),
      ]),
    ).toEqual({ id: "b", textLength: 6 });
    expect(latestStreamingAssistantMessage([message("a", "assistant", "x", false)])).toBeNull();
  });

  it("ticks on a new stream and throttles growth of the same one", () => {
    const at = (textLength: number, id = "m") => ({ id, textLength });
    expect(shouldTickStreamHaptic({ previous: null, latest: at(1), lastTickAt: 0, now: 0 })).toBe(
      true,
    );
    expect(
      shouldTickStreamHaptic({ previous: at(1), latest: at(5), lastTickAt: 1_000, now: 1_100 }),
    ).toBe(false);
    expect(
      shouldTickStreamHaptic({ previous: at(1), latest: at(5), lastTickAt: 1_000, now: 1_320 }),
    ).toBe(true);
    expect(
      shouldTickStreamHaptic({ previous: at(5), latest: at(5), lastTickAt: 0, now: 9_999 }),
    ).toBe(false);
    expect(shouldTickStreamHaptic({ previous: at(5), latest: null, lastTickAt: 0, now: 0 })).toBe(
      false,
    );
  });
});
