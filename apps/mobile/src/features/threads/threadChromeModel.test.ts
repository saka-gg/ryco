import type { Thread } from "@ryco/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import {
  createThreadChromeSelector,
  createThreadSummaryChromeSelector,
  sameThreadChrome,
} from "./threadChromeModel";

function message(id: string, text: string, streaming = false) {
  return { id, role: "assistant", text, createdAt: "2026-11-10T10:00:00.000Z", streaming };
}

function thread(overrides: Record<string, unknown> = {}): Thread {
  return {
    id: "t1",
    title: "Thread",
    updatedAt: "2026-11-10T10:00:00.000Z",
    latestTurn: null,
    session: null,
    activities: [],
    messages: [message("u1", "hi"), message("a1", "Hel", true)],
    ...overrides,
  } as unknown as Thread;
}

describe("thread chrome", () => {
  it("ignores streamed text and updatedAt", () => {
    const base = thread();
    const delta = thread({
      updatedAt: "2026-11-10T10:00:01.000Z",
      messages: [base.messages[0], message("a1", "Hello there", true)],
      activities: base.activities,
    });
    expect(sameThreadChrome(base, delta)).toBe(true);
  });

  it("sees a new message, a settled reply and any other field", () => {
    const base = thread();
    const same = (overrides: Record<string, unknown>) =>
      sameThreadChrome(base, thread({ activities: base.activities, ...overrides }));
    expect(same({ messages: [...base.messages, message("u2", "more")] })).toBe(false);
    expect(same({ messages: [base.messages[0], message("a1", "Hello", false)] })).toBe(false);
    expect(same({ messages: base.messages, title: "Renamed" })).toBe(false);
    expect(same({ messages: base.messages, activities: [] })).toBe(false);
    expect(sameThreadChrome(base, undefined)).toBe(false);
  });

  it("returns the thread it returned before while the chrome is the same", () => {
    const select = createThreadChromeSelector();
    const base = thread();
    expect(select(base)).toBe(base);
    const delta = thread({
      activities: base.activities,
      messages: [base.messages[0], message("a1", "Hello", true)],
    });
    expect(select(delta)).toBe(base);
    const renamed = thread({ activities: base.activities, title: "Renamed" });
    expect(select(renamed)).toBe(renamed);
    expect(select(undefined)).toBeUndefined();
  });

  it("keeps a thread summary across updatedAt-only changes", () => {
    const select = createThreadSummaryChromeSelector<{
      id: string;
      updatedAt: string;
      title: string;
    }>();
    const first = { id: "t1", updatedAt: "a", title: "x" };
    expect(select(first)).toBe(first);
    expect(select({ id: "t1", updatedAt: "b", title: "x" })).toBe(first);
    const renamed = { id: "t1", updatedAt: "c", title: "y" };
    expect(select(renamed)).toBe(renamed);
  });
});
