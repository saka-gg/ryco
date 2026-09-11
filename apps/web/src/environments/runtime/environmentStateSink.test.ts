import { describe, expect, it, vi } from "vite-plus/test";

const applyOrchestrationEvents = vi.fn();
const syncProjects = vi.fn();
const syncThreads = vi.fn();
const environmentStateById = {
  live: { bootstrapComplete: true },
  cached: { bootstrapComplete: false, hydratedFromCacheAt: 1 },
  connecting: { bootstrapComplete: false },
};

vi.mock("~/store", () => ({
  useStore: { getState: () => ({ applyOrchestrationEvents, environmentStateById }) },
  selectProjectsAcrossEnvironments: () => [],
  selectThreadsAcrossEnvironments: () => [],
}));
vi.mock("~/composerDraftStore", () => ({
  markPromotedDraftThreadsByRef: vi.fn(),
  useComposerDraftStore: {
    getState: () => ({ clearDraftThread: vi.fn(), clearProjectDraftThreadId: vi.fn() }),
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
    getState: () => ({ syncProjects, syncThreads, clearThreadUi: vi.fn() }),
  },
}));

import { createWebEnvironmentStateSink } from "./environmentStateSink";

describe("web environment state sink", () => {
  it("allows preference cleanup only for nodes with a current live shell", () => {
    const sink = createWebEnvironmentStateSink({
      markProviderInvalidationNeeded: vi.fn(),
      flushProviderInvalidation: vi.fn(),
    });
    sink.syncProjects("live" as never);
    sink.syncThreads("live" as never);
    const scope = { authoritativeEnvironmentIds: new Set(["live"]) };
    expect(syncProjects).toHaveBeenCalledWith([], scope);
    expect(syncThreads).toHaveBeenCalledWith([], scope);
  });
  it("maps orchestration application to the thread store with the environment id", () => {
    const sink = createWebEnvironmentStateSink({
      markProviderInvalidationNeeded: vi.fn(),
      flushProviderInvalidation: vi.fn(),
    });
    const events = [{ type: "thread.created" }] as never;

    sink.applyOrchestrationEvents("environment-a" as never, events);

    expect(applyOrchestrationEvents).toHaveBeenCalledWith(events, "environment-a");
  });
});
