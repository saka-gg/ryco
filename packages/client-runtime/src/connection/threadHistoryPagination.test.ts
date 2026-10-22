import {
  EnvironmentId,
  MessageId,
  OrchestrationThreadHistoryCursor,
  ThreadId,
  type OrchestrationThreadHistoryPage,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadHistoryPaginationController,
  isThreadHistoryAnchorMissing,
} from "./threadHistoryPagination.ts";

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const cursor = OrchestrationThreadHistoryCursor.make("v1.cursor");
const page: OrchestrationThreadHistoryPage = {
  collection: "messages",
  snapshotSequence: 2,
  items: [],
  page: { oldestCursor: cursor, newestCursor: cursor, hasMoreBefore: false },
};

describe("thread history pagination", () => {
  it("coalesces identical cursor requests and applies the page once", async () => {
    const request = vi.fn(async () => page);
    const apply = vi.fn();
    const controller = createThreadHistoryPaginationController({
      request,
      apply,
      setRequestState: vi.fn(),
    });
    controller.beginSnapshot(scope);
    const input = {
      scope,
      collection: "messages" as const,
      page: { oldestCursor: cursor, newestCursor: cursor, hasMoreBefore: true },
      limit: 50,
    };

    await Promise.all([controller.loadBefore(input), controller.loadBefore(input)]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("ignores a page that resolves after a newer snapshot generation", async () => {
    let resolveRequest: ((value: OrchestrationThreadHistoryPage) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<OrchestrationThreadHistoryPage>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const apply = vi.fn();
    const controller = createThreadHistoryPaginationController({
      request,
      apply,
      setRequestState: vi.fn(),
    });
    controller.beginSnapshot(scope);
    const pending = controller.loadAroundMessage({
      scope,
      anchorId: MessageId.make("message-1"),
      limit: 50,
    });
    controller.beginSnapshot(scope);
    resolveRequest?.(page);

    await expect(pending).resolves.toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("records request failures without clearing loaded state", async () => {
    const setRequestState = vi.fn();
    const controller = createThreadHistoryPaginationController({
      request: vi.fn(async () => {
        throw new Error("offline");
      }),
      apply: vi.fn(),
      setRequestState,
    });
    controller.beginSnapshot(scope);

    await expect(
      controller.loadAroundMessage({
        scope,
        anchorId: MessageId.make("message-1"),
        limit: 50,
      }),
    ).rejects.toThrow("offline");
    expect(setRequestState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "error", error: "offline" }),
    );
  });

  it("resnapshots instead of exposing a stale cursor gap", async () => {
    const recoverStale = vi.fn(async () => undefined);
    const setRequestState = vi.fn();
    const controller = createThreadHistoryPaginationController({
      request: vi.fn(async () => {
        throw { _tag: "OrchestrationThreadHistoryError", reason: "stale-cursor" };
      }),
      apply: vi.fn(),
      setRequestState,
      recoverStale,
    });
    controller.beginSnapshot(scope);

    await expect(
      controller.loadBefore({
        scope,
        collection: "messages",
        page: { oldestCursor: cursor, newestCursor: cursor, hasMoreBefore: true },
        limit: 50,
      }),
    ).resolves.toBeNull();
    expect(recoverStale).toHaveBeenCalledWith(scope);
    expect(setRequestState).not.toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("tells a missing message from a load that failed", () => {
    const historyError = (reason: string) => ({ _tag: "OrchestrationThreadHistoryError", reason });
    expect(isThreadHistoryAnchorMissing(historyError("stale-cursor"))).toBe(true);
    expect(isThreadHistoryAnchorMissing(historyError("thread-not-found"))).toBe(true);
    expect(isThreadHistoryAnchorMissing(historyError("invalid-cursor"))).toBe(false);
    expect(isThreadHistoryAnchorMissing(new Error("socket closed"))).toBe(false);
    expect(
      isThreadHistoryAnchorMissing({
        _tag: "OrchestrationGetSnapshotError",
        reason: "stale-cursor",
      }),
    ).toBe(false);
    expect(isThreadHistoryAnchorMissing(undefined)).toBe(false);
  });

  it("reports a message the thread no longer has instead of resnapshotting", async () => {
    const recoverStale = vi.fn(async () => undefined);
    const setRequestState = vi.fn();
    const missingAnchor = { _tag: "OrchestrationThreadHistoryError", reason: "stale-cursor" };
    const controller = createThreadHistoryPaginationController({
      request: vi.fn(async () => {
        throw missingAnchor;
      }),
      apply: vi.fn(),
      setRequestState,
      recoverStale,
    });
    controller.beginSnapshot(scope);

    // A reveal or quote jump settles on this rejection; a resnapshot resolved null instead.
    await expect(
      controller.loadAroundMessage({
        scope,
        anchorId: MessageId.make("message-deleted"),
        limit: 101,
      }),
    ).rejects.toBe(missingAnchor);
    expect(recoverStale).not.toHaveBeenCalled();
    // Loading older messages did not fail, so the timeline shows no error.
    expect(setRequestState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "idle", cursor: null, error: null }),
    );
    expect(setRequestState).not.toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });
});
