import { describe, expect, it, vi } from "vitest";
import type { EnvironmentApi, OrchestrationThreadWindowSnapshot, ThreadId } from "@ryco/contracts";
import { loadThreadForExport } from "./threadExport.ts";

const end = { hasMoreBefore: false, oldestCursor: null, newestCursor: null };
const more = (cursor: string) => ({ ...end, hasMoreBefore: true, oldestCursor: cursor });
function setup(pages: unknown[] = [], first = more("c1")) {
  const snapshot = {
    snapshotSequence: 4,
    thread: {
      id: "thread",
      modelSelection: { instanceId: "codex", model: "model" },
      messages: [{ id: "m3", text: "third" }],
      activities: [],
    },
    history: { messages: first, activities: end },
  } as unknown as OrchestrationThreadWindowSnapshot;
  const getThreadWindow = vi.fn().mockResolvedValue(snapshot);
  const getThreadHistoryPage = vi.fn();
  pages.forEach((page) => getThreadHistoryPage.mockResolvedValueOnce(page));
  const controller = new AbortController();
  const isCurrent = vi.fn(() => true);
  const run = () =>
    loadThreadForExport({
      api: {
        orchestration: { getThreadWindow, getThreadHistoryPage },
      } as unknown as EnvironmentApi,
      threadId: "thread" as ThreadId,
      signal: controller.signal,
      isCurrent,
    });
  return { run, getThreadWindow, getThreadHistoryPage, controller, isCurrent };
}
const page = (id: string, next = end, sequence = 4) => ({
  collection: "messages",
  snapshotSequence: sequence,
  items: [{ id, text: id }],
  page: next,
});
describe("complete retained-history export", () => {
  it("exhausts actual pages before returning and revalidates", async () => {
    const t = setup([page("m2", more("c2")), page("m1")]);
    expect((await t.run()).messages.map((m) => m.id)).toEqual(["m3", "m2", "m1"]);
    expect(t.getThreadHistoryPage).toHaveBeenCalledTimes(2);
    expect(t.getThreadWindow).toHaveBeenCalledTimes(2);
  });
  it("loads all activity pages too", async () => {
    const t = setup(
      [
        {
          collection: "activities",
          snapshotSequence: 4,
          items: [
            {
              id: "tool",
              kind: "tool.completed",
              summary: "Done",
              payload: { raw: "not retained" },
            },
          ],
          page: end,
        },
      ],
      end,
    );
    const snapshot = await t.getThreadWindow();
    snapshot.history.activities = more("tool-cursor");
    expect((await t.run()).activities).toHaveLength(1);
  });
  it.each([
    [page("m2", more("c1"))],
    [page("m2", { ...end, oldestCursor: "c1" } as typeof end)],
    [page("m2", more("c2")), page("m1", more("c1"))],
    [{ ...page("m2"), items: [] }],
    [page("m3")],
    [page("m2", end, 5)],
  ])("rejects stalled, repeated, empty, overlapping or changed pages %j", async (...pages) => {
    await expect(setup(pages).run()).rejects.toThrow();
  });
  it("rejects a final revision change", async () => {
    const t = setup([], end);
    t.getThreadWindow
      .mockResolvedValueOnce(await t.getThreadWindow())
      .mockResolvedValueOnce({ snapshotSequence: 5, thread: { id: "thread" } });
    await expect(t.run()).rejects.toThrow("changed");
  });
  it("cancels immediately while a page is pending", async () => {
    const t = setup();
    t.getThreadHistoryPage.mockImplementation(() => new Promise(() => {}));
    const result = t.run();
    await vi.waitFor(() => expect(t.getThreadHistoryPage).toHaveBeenCalled());
    t.controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
  });
  it("rejects reconnection without publishing loaded pages", async () => {
    const t = setup([page("m2")]);
    t.getThreadHistoryPage.mockReset().mockImplementation(async () => {
      t.isCurrent.mockReturnValue(false);
      return page("m2");
    });
    await expect(t.run()).rejects.toThrow("connection changed");
  });
});

describe("export resource limits", () => {
  it("rejects oversized initial activity history even when already exhausted", async () => {
    const t = setup([], end);
    const snapshot = await t.getThreadWindow();
    snapshot.thread.activities = [
      { id: "large", kind: "tool.completed", summary: "x".repeat(9 * 1024 * 1024) },
    ];
    await expect(t.run()).rejects.toThrow("resource limit");
    expect(t.getThreadHistoryPage).not.toHaveBeenCalled();
  });
  it("rejects an oversized final activity page", async () => {
    const t = setup(
      [
        {
          collection: "activities",
          snapshotSequence: 4,
          items: [{ id: "large", kind: "tool.completed", summary: "x".repeat(9 * 1024 * 1024) }],
          page: end,
        },
      ],
      end,
    );
    const snapshot = await t.getThreadWindow();
    snapshot.history.activities = more("a");
    await expect(t.run()).rejects.toThrow("No partial file");
  });
  it("rejects an oversized final message page", async () => {
    const t = setup([
      { ...page("large"), items: [{ id: "large", text: "x".repeat(9 * 1024 * 1024) }] },
    ]);
    await expect(t.run()).rejects.toThrow("No partial file");
  });
  it("bounds total record count including activities", async () => {
    const t = setup([], end);
    const snapshot = await t.getThreadWindow();
    snapshot.thread.activities = Array.from({ length: 20_001 }, (_, i) => ({
      id: `a${i}`,
      kind: "unknown",
      summary: "",
    }));
    await expect(t.run()).rejects.toThrow("resource limit");
  });
  it("never retains activity payloads or message attachment credentials", async () => {
    const t = setup([], end);
    const snapshot = await t.getThreadWindow();
    snapshot.thread.activities = [
      {
        id: "a",
        kind: "tool.completed",
        summary: "Done",
        payload: { raw: "x".repeat(100_000), token: "private" },
      },
    ];
    snapshot.thread.messages[0].attachments = [{ url: "private", name: "private" }];
    const result = await t.run();
    expect(result.activities[0]).not.toHaveProperty("payload");
    expect(result.messages[0]).not.toHaveProperty("attachments");
    expect(result.messages[0]?.attachmentCount).toBe(1);
  });
});

describe("export request lifecycle", () => {
  it("does not start a request when already cancelled", async () => {
    const t = setup([], end);
    t.controller.abort();
    await expect(t.run()).rejects.toThrow("cancelled");
    expect(t.getThreadWindow).not.toHaveBeenCalled();
  });
  it("times out a stalled request without retrying", async () => {
    vi.useFakeTimers();
    try {
      const t = setup([], end);
      t.getThreadWindow.mockImplementation(() => new Promise(() => {}));
      const failure = expect(t.run()).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await failure;
      expect(t.getThreadWindow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
