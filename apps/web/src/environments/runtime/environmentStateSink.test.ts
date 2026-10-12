import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const applyOrchestrationEvents = vi.fn();
// Mirrors the store's batch: each event is prepared against the state it applies to.
const applyShellEvents = vi.fn(
  (
    events: ReadonlyArray<unknown>,
    _environmentId: string,
    prepare?: (state: unknown, event: unknown) => unknown,
  ) => events.map((event) => prepare?.({ environmentStateById }, event)),
);
const syncProjects = vi.fn();
const syncThreads = vi.fn();
const seedThreadVisitedAt = vi.fn();
const { markPromotedDraftThreadByRef, markPromotedDraftThreadsByRef } = vi.hoisted(() => ({
  markPromotedDraftThreadByRef: vi.fn(),
  markPromotedDraftThreadsByRef: vi.fn(),
}));
const threadShells: Array<{
  id: string;
  environmentId: string;
  updatedAt?: string;
  createdAt: string;
  archivedAt: string | null;
}> = [];
const environmentStateById: Record<string, Record<string, unknown>> = {
  live: { bootstrapComplete: true, threadShellById: {} },
  cached: { bootstrapComplete: false, hydratedFromCacheAt: 1, threadShellById: {} },
  connecting: { bootstrapComplete: false, threadShellById: {} },
};

vi.mock("~/store", () => ({
  useStore: {
    getState: () => ({ applyOrchestrationEvents, applyShellEvents, environmentStateById }),
  },
  selectEnvironmentState: (
    state: { environmentStateById: Record<string, unknown> },
    environmentId: string,
  ) => state.environmentStateById[environmentId],
  selectProjectsAcrossEnvironments: () => [],
  selectThreadShellsAcrossEnvironments: () => threadShells,
}));
vi.mock("~/composerDraftStore", () => ({
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore: {
    getState: () => ({
      clearDraftThread: vi.fn(),
      clearProjectDraftThreadId: vi.fn(),
      listDraftThreadKeys: () => [],
    }),
  },
}));
vi.mock("~/hooks/useSettings", () => ({ getClientSettings: () => ({}) }));
vi.mock("~/logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: vi.fn(),
  derivePhysicalProjectKey: vi.fn(),
}));
vi.mock("~/terminalStateStore", () => ({
  useTerminalStateStore: { getState: () => ({ removeTerminalState: vi.fn() }) },
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: {
    getState: () => ({ syncProjects, syncThreads, seedThreadVisitedAt, clearThreadUi: vi.fn() }),
  },
}));

import { createWebEnvironmentStateSink } from "./environmentStateSink";

function makeSink() {
  return createWebEnvironmentStateSink({
    markProviderInvalidationNeeded: vi.fn(),
    flushProviderInvalidation: vi.fn(),
  });
}

function upsert(threadId: string, updatedAt: string) {
  return {
    kind: "thread-upserted",
    sequence: 1,
    thread: { id: threadId, createdAt: "2026-10-01T00:00:00.000Z", updatedAt, archivedAt: null },
  } as never;
}

describe("web environment state sink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadShells.length = 0;
    environmentStateById.live!.threadShellById = {};
  });

  it("allows preference cleanup only for nodes with a current live shell", () => {
    const sink = makeSink();
    sink.syncProjects("live" as never);
    sink.syncThreads("live" as never);
    const scope = { authoritativeEnvironmentIds: new Set(["live"]) };
    expect(syncProjects).toHaveBeenCalledWith([], scope);
    expect(syncThreads).toHaveBeenCalledWith([], scope);
  });

  it("maps orchestration application to the thread store with the environment id", () => {
    const sink = makeSink();
    const events = [{ type: "thread.created" }] as never;

    sink.applyOrchestrationEvents("environment-a" as never, events);

    expect(applyOrchestrationEvents).toHaveBeenCalledWith(events, "environment-a");
  });

  it("syncs every thread's UI state only when a shell upsert adds a thread", () => {
    const sink = makeSink();
    threadShells.push({
      id: "thread-1",
      environmentId: "live",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:01.000Z",
      archivedAt: null,
    });
    const created = upsert("thread-1", "2026-10-01T00:00:01.000Z");
    const [createdContext] = sink.applyShellEvents("live" as never, [created]);
    sink.afterShellEventApplied("live" as never, created, createdContext);

    expect(syncThreads).toHaveBeenCalledTimes(1);
    expect(markPromotedDraftThreadsByRef).toHaveBeenCalledTimes(1);
    expect(markPromotedDraftThreadByRef).toHaveBeenCalledWith({
      environmentId: "live",
      threadId: "thread-1",
    });

    // A streaming delta bumps the same thread again: O(1), no full sync and
    // no all-threads x all-drafts promotion scan.
    environmentStateById.live!.threadShellById = { "thread-1": { archivedAt: null } };
    const streamed = upsert("thread-1", "2026-10-01T00:00:02.000Z");
    const [streamedContext] = sink.applyShellEvents("live" as never, [streamed]);
    sink.afterShellEventApplied("live" as never, streamed, streamedContext);

    expect(syncThreads).toHaveBeenCalledTimes(1);
    expect(markPromotedDraftThreadsByRef).toHaveBeenCalledTimes(1);
    expect(markPromotedDraftThreadByRef).toHaveBeenCalledTimes(1);
    expect(seedThreadVisitedAt).toHaveBeenCalledWith("live:thread-1", "2026-10-01T00:00:02.000Z");
  });
});
