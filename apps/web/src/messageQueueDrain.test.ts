import {
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  hosted: false,
  apis: new Set<string>(),
  savedRecords: new Map<string, object>(),
  retainDetail: vi.fn(),
  releaseDetail: vi.fn(),
  background: vi.fn(),
}));

vi.mock("./env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./env")>()),
  isHostedHubMode: () => harness.hosted,
}));
vi.mock("./environmentApi", () => ({
  readEnvironmentApi: (environmentId: string) =>
    harness.apis.has(environmentId) ? ({ orchestration: {} } as never) : undefined,
}));
vi.mock("./environments/runtime/service", () => ({
  retainThreadDetailSubscription: (environmentId: string, threadId: string) => {
    harness.retainDetail(environmentId, threadId);
    return harness.releaseDetail;
  },
}));
vi.mock("./environments/runtime", async () => {
  const { createStore } = await import("zustand/vanilla");
  return {
    getSavedEnvironmentRecord: (environmentId: string) =>
      harness.savedRecords.get(environmentId) ?? null,
    useSavedEnvironmentRegistryStore: createStore(() => ({ byId: {} })),
    useSavedEnvironmentRuntimeStore: createStore<{ byId: Record<string, object> }>(() => ({
      byId: {},
    })),
  };
});
vi.mock("./hooks/sendQueuedMessageInBackground", () => ({
  sendQueuedMessageInBackground: (...args: unknown[]) => harness.background(...args),
}));

import { useSavedEnvironmentRuntimeStore } from "./environments/runtime";
import { hostedWebConnectionScopes } from "./hostedHub/hostedConnectionScopes";
import { useHostedHubStore } from "./hostedHub/state";
import {
  inspectMessageQueueDrain,
  readWebQueueEnvironment,
  registerForegroundQueueSender,
  resolveWebQueueSender,
  retainMessageQueueDrain,
  type WebQueueSender,
} from "./messageQueueDrain";
import { useMessageQueueStore, type WebQueuedMessage } from "./messageQueueStore";
import { useStore } from "./store";

const ENV = EnvironmentId.make("env-queue-drain");
const OTHER_ENV = EnvironmentId.make("env-queue-other");
const THREAD = ThreadId.make("thread-queue-drain");
const KEY = `${ENV}:${THREAD}`;
const AT = "2026-10-01T10:00:00.000Z";

function shellSnapshot(started: boolean): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: ProjectId.make("project-queue"),
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    threads: [
      {
        id: THREAD,
        projectId: ProjectId.make("project-queue"),
        title: "Queued",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: started
          ? {
              turnId: TurnId.make("turn-1"),
              state: "completed",
              requestedAt: AT,
              startedAt: AT,
              completedAt: AT,
              assistantMessageId: null,
            }
          : null,
        createdAt: AT,
        updatedAt: AT,
        archivedAt: null,
        session: {
          threadId: THREAD,
          status: "ready",
          providerName: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: AT,
        },
        latestUserMessageAt: started ? AT : null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
    updatedAt: AT,
  } as unknown as OrchestrationShellSnapshot;
}

function queued(id: string): WebQueuedMessage {
  return {
    id,
    composer: {
      prompt: id,
      trimmedPrompt: id,
      images: [],
      sendableTerminalContexts: [],
      sourceControlContexts: [],
      selectedProvider: ProviderDriverKind.make("codex"),
      selectedModel: "gpt-5",
      selectedProviderModels: [],
      selectedPromptEffort: null,
      selectedModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      expiredTerminalContextCount: 0,
    },
    settings: { runtimeMode: "full-access", interactionMode: "default", tokenMode: "balanced" },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function setHostedNode(environmentId: EnvironmentId | null): void {
  useHostedHubStore.setState({
    selectedNode: environmentId ? ({ id: "node", environmentId } as never) : null,
    effectiveRole: "owner",
    directoryStatus: "ready",
    transportStatus: "online",
    browserStatus: "current",
    sessionStatus: "ready",
  });
}

let releaseDrain: (() => void) | null = null;

beforeEach(() => {
  harness.hosted = false;
  harness.apis = new Set([ENV, OTHER_ENV]);
  harness.savedRecords.clear();
  harness.retainDetail.mockClear();
  harness.releaseDetail.mockClear();
  harness.background.mockReset();
  harness.background.mockResolvedValue({ kind: "accepted" });
  resetWsConnectionStateForTests();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useStore.getState().syncServerShellSnapshot(shellSnapshot(true), ENV);
  useMessageQueueStore.getState().reset();
  hostedWebConnectionScopes.reset();
});

afterEach(() => {
  releaseDrain?.();
  releaseDrain = null;
  useMessageQueueStore.getState().reset();
});

describe("readWebQueueEnvironment", () => {
  it("is never mutation-ready for a hosted node that is not the selected one", () => {
    harness.hosted = true;
    setHostedNode(OTHER_ENV);
    expect(readWebQueueEnvironment(ENV)).toEqual({ shellLive: true, mutationReady: false });
    setHostedNode(ENV);
    expect(readWebQueueEnvironment(ENV)).toEqual({ shellLive: true, mutationReady: true });
  });

  it("waits on a disconnected socket or a saved environment that is not connected", () => {
    expect(readWebQueueEnvironment(ENV).mutationReady).toBe(false);
    recordWsConnectionOpened({ environmentId: ENV });
    expect(readWebQueueEnvironment(ENV).mutationReady).toBe(true);
    harness.savedRecords.set(ENV, { environmentId: ENV });
    expect(readWebQueueEnvironment(ENV).mutationReady).toBe(false);
    useSavedEnvironmentRuntimeStore.setState({
      byId: { [ENV]: { connectionState: "connected" } as never },
    });
    expect(readWebQueueEnvironment(ENV).mutationReady).toBe(true);
    recordWsConnectionClosed({ code: 1006, reason: "gone" }, { environmentId: ENV });
    expect(readWebQueueEnvironment(ENV).mutationReady).toBe(false);
  });

  it("does not trust cached rows", () => {
    recordWsConnectionOpened({ environmentId: ENV });
    useStore.getState().demoteEnvironmentStateToCachedSnapshot(ENV, Date.now());
    expect(readWebQueueEnvironment(ENV)).toEqual({ shellLive: false, mutationReady: false });
  });
});

describe("web queue senders", () => {
  it("prefers the newest foreground sender and falls back to background only for started threads", () => {
    const first: WebQueueSender = { send: vi.fn() };
    const second: WebQueueSender = { send: vi.fn() };
    const releaseFirst = registerForegroundQueueSender(KEY, first);
    const releaseSecond = registerForegroundQueueSender(KEY, second);
    expect(resolveWebQueueSender(KEY, null)).toEqual({ kind: "foreground", sender: second });
    releaseSecond();
    expect(resolveWebQueueSender(KEY, null)?.sender).toBe(first);
    releaseFirst();
    expect(resolveWebQueueSender(KEY, { started: true } as never)?.kind).toBe("background");
    expect(resolveWebQueueSender(KEY, { started: false } as never)).toBeNull();
    expect(resolveWebQueueSender(KEY, null)).toBeNull();
  });

  it("drains a started off-screen thread through the background sender", async () => {
    recordWsConnectionOpened({ environmentId: ENV });
    releaseDrain = retainMessageQueueDrain();
    // Detail is required before sending; the drain retains it itself.
    useStore.getState().syncServerThreadDetail(
      {
        ...shellSnapshot(true).threads[0],
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      } as never,
      ENV,
    );
    useMessageQueueStore.getState().enqueue(KEY, queued("q-1"));
    await flush();
    expect(harness.retainDetail).toHaveBeenCalledWith(ENV, THREAD);
    expect(harness.background).toHaveBeenCalledTimes(1);
    expect(harness.background.mock.calls[0]?.[0]).toBe(KEY);
  });

  it("leaves an unstarted thread without a foreground sender waiting", async () => {
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    useStore.getState().syncServerShellSnapshot(shellSnapshot(false), ENV);
    recordWsConnectionOpened({ environmentId: ENV });
    releaseDrain = retainMessageQueueDrain();
    useMessageQueueStore.getState().enqueue(KEY, queued("q-1"));
    await flush();
    expect(inspectMessageQueueDrain(KEY).lastStep).toEqual({ kind: "wait", reason: "no-sender" });
    expect(harness.background).not.toHaveBeenCalled();
  });

  it("never creates hosted connection demand for a queue on another node", async () => {
    harness.hosted = true;
    setHostedNode(OTHER_ENV);
    releaseDrain = retainMessageQueueDrain();
    useMessageQueueStore.getState().enqueue(KEY, queued("q-1"));
    await flush();
    expect(inspectMessageQueueDrain(KEY).lastStep).toEqual({
      kind: "wait",
      reason: "environment",
    });
    expect(harness.retainDetail).not.toHaveBeenCalled();
    expect(hostedWebConnectionScopes.list()).toEqual([]);
    setHostedNode(ENV);
    await flush();
    expect(harness.retainDetail).toHaveBeenCalledWith(ENV, THREAD);
    expect(hostedWebConnectionScopes.list()).toEqual([]);
  });
});
