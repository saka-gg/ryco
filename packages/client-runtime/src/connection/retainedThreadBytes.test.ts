import { describe, expect, it } from "vite-plus/test";

import { MAX_THREAD_ACTIVITIES, MAX_THREAD_MESSAGES } from "../state/threads/limits.ts";
import { approximateJsonSize } from "./approximateJsonSize.ts";
import { createRetainedThreadBytes, RETAINED_ROW_OVERHEAD_BYTES } from "./retainedThreadBytes.ts";

const activityEvent = (id: string, bytes: number) => ({
  type: "thread.activity-appended",
  payload: { activity: { id, payload: { output: "x".repeat(bytes) } } },
});
const messageEvent = (messageId: string, text: string, streaming: boolean) => ({
  type: "thread.message-sent",
  payload: { messageId, text, streaming },
});

describe("createRetainedThreadBytes", () => {
  it("drops the oldest rows past the store's activity cap", () => {
    const retained = createRetainedThreadBytes();
    const rowBytes = approximateJsonSize(activityEvent("tool-0", 1_000).payload.activity);
    for (let index = 0; index < MAX_THREAD_ACTIVITIES * 4; index += 1) {
      retained.recordEvent(activityEvent(`tool-${index}`, 1_000));
    }
    const expected = MAX_THREAD_ACTIVITIES * (rowBytes + RETAINED_ROW_OVERHEAD_BYTES);
    // Ids differ in length by a few characters; the estimate stays at the cap.
    expect(retained.bytes()).toBeGreaterThan(expected * 0.99);
    expect(retained.bytes()).toBeLessThan(expected * 1.01);
  });

  it("caps messages at the store's message cap, snapshot rows included", () => {
    const retained = createRetainedThreadBytes();
    const messages = Array.from({ length: MAX_THREAD_MESSAGES }, (_, index) => ({
      id: `message-${index}`,
      text: "y".repeat(100),
    }));
    retained.recordSnapshot({ snapshotSequence: 1, thread: { id: "thread", messages } });
    const atCap = retained.bytes();
    for (let index = 0; index < 1_000; index += 1) {
      retained.recordEvent(messageEvent(`live-${index}`, "y".repeat(100), false));
    }
    // Each live row replaces one snapshot row of about the same size.
    expect(retained.bytes()).toBeLessThan(atCap + 1_000 * (RETAINED_ROW_OVERHEAD_BYTES + 50));
  });

  it("appends a streamed delta to the snapshot row it continues", () => {
    const retained = createRetainedThreadBytes();
    retained.recordSnapshot({
      snapshotSequence: 1,
      thread: { id: "thread", messages: [{ id: "message-1", text: "a".repeat(1_000) }] },
    });
    const before = retained.bytes();
    retained.recordEvent(messageEvent("message-1", "b".repeat(10), true));
    expect(retained.bytes()).toBe(before + 10);
  });

  it("counts a history page applied twice once", () => {
    const retained = createRetainedThreadBytes();
    retained.recordSnapshot({ snapshotSequence: 1, thread: { id: "thread", activities: [] } });
    const page = {
      collection: "activities",
      items: Array.from({ length: 50 }, (_, index) => ({ id: `old-${index}`, summary: "z" })),
    };
    retained.recordHistoryPage(page);
    const once = retained.bytes();
    retained.recordHistoryPage(page);
    expect(retained.bytes()).toBe(once);
    expect(once).toBeGreaterThan(approximateJsonSize(page.items) * 0.9);
  });

  it("starts over from each snapshot", () => {
    const retained = createRetainedThreadBytes();
    retained.recordEvent(activityEvent("tool-1", 50_000));
    const snapshot = { snapshotSequence: 2, thread: { padding: "x".repeat(1_000) } };
    retained.recordSnapshot(snapshot);
    expect(retained.bytes()).toBe(approximateJsonSize(snapshot));
  });
});
