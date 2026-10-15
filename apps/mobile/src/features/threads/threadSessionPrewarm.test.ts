import type { EnvironmentApi, EnvironmentId, ServerConfig, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "@ryco/client-runtime/rpc";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../connection/environmentApi";
import {
  resetEnvironmentServerConfigsForTests,
  writeEnvironmentServerConfig,
} from "../../state/environmentServerConfigs";
import { useStore } from "../../state/threadsRuntime";
import { prewarmThreadProviderSession } from "./threadSessionPrewarm";

let environmentCounter = 0;
const THREAD_ID = "thread-prewarm" as ThreadId;
const modelSelection = { instanceId: "claude-1", model: "claude-opus" } as never;

function setup(options: {
  readonly sessionStatus?: "stopped" | "running" | null;
  readonly connected?: boolean;
  readonly supported?: boolean;
}) {
  // A fresh environment per case: the prewarm throttle is keyed per API object
  // and thread, and the store is shared across the file.
  const environmentId = `env-prewarm-${++environmentCounter}` as EnvironmentId;
  const prewarmProviderSession = vi.fn(async (_request: unknown) => ({
    status: "started" as const,
  }));
  __setEnvironmentApiOverrideForTests(environmentId, {
    server: { prewarmProviderSession },
  } as unknown as EnvironmentApi);
  writeEnvironmentServerConfig(environmentId, {
    environment: { capabilities: { providerSessionPrewarm: options.supported ?? true } },
    providers: [],
  } as unknown as ServerConfig);
  if (options.connected ?? true) {
    recordWsConnectionAttempt("wss://node.test", { connectionLabel: "node", environmentId });
    recordWsConnectionOpened({ connectionLabel: "node", environmentId });
  }
  useStore.getState().syncServerShellSnapshot(
    {
      snapshotSequence: 1,
      projects: [],
      worktrees: [],
      threads: [],
      updatedAt: "2026-08-23T00:00:00.000Z",
    } as never,
    environmentId,
  );
  const sessionStatus = options.sessionStatus === undefined ? null : options.sessionStatus;
  useStore.getState().syncServerThreadDetail(
    {
      id: THREAD_ID,
      projectId: "project-1",
      title: "Prewarm",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      worktreeId: null,
      manualStatusBucket: null,
      manualPosition: 0,
      latestTurn: null,
      createdAt: "2026-08-19T10:00:00.000Z",
      updatedAt: "2026-08-19T10:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session:
        sessionStatus === null
          ? null
          : {
              threadId: THREAD_ID,
              status: sessionStatus,
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-08-19T10:00:00.000Z",
            },
    } as never,
    environmentId,
  );
  return { environmentId, prewarmProviderSession };
}

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  resetEnvironmentServerConfigsForTests();
  resetWsConnectionStateForTests();
});

describe("prewarmThreadProviderSession", () => {
  it("sends one prewarm per composer intent burst for a thread without a live session", () => {
    const { environmentId, prewarmProviderSession } = setup({});

    expect(
      prewarmThreadProviderSession({
        environmentId,
        threadId: THREAD_ID,
        modelSelection: null,
        mutationReady: true,
      }),
    ).toBe(true);
    // Focus followed by the first keystroke: the shared throttle drops the repeat.
    expect(
      prewarmThreadProviderSession({
        environmentId,
        threadId: THREAD_ID,
        modelSelection: null,
        mutationReady: true,
      }),
    ).toBe(false);
    expect(prewarmProviderSession).toHaveBeenCalledExactlyOnceWith({
      threadId: THREAD_ID,
      modelSelection,
      runtimeMode: "full-access",
      tokenMode: expect.any(String),
    });
  });

  it("prewarms a stopped session with the staged model", () => {
    const { environmentId, prewarmProviderSession } = setup({ sessionStatus: "stopped" });
    const staged = { instanceId: "codex-1", model: "gpt-5" } as never;
    prewarmThreadProviderSession({
      environmentId,
      threadId: THREAD_ID,
      modelSelection: staged,
      mutationReady: true,
    });
    expect(prewarmProviderSession).toHaveBeenCalledOnce();
    expect(prewarmProviderSession.mock.calls[0]![0]).toMatchObject({ modelSelection: staged });
  });

  it("sends nothing while the session is live, offline, or unsupported by the node", () => {
    for (const options of [
      { sessionStatus: "running" as const },
      { connected: false },
      { supported: false },
    ]) {
      const { environmentId, prewarmProviderSession } = setup(options);
      expect(
        prewarmThreadProviderSession({
          environmentId,
          threadId: THREAD_ID,
          modelSelection: null,
          mutationReady: true,
        }),
      ).toBe(false);
      expect(prewarmProviderSession).not.toHaveBeenCalled();
    }
  });

  it("sends nothing when the environment is not mutation-ready (a hosted viewer)", () => {
    const { environmentId, prewarmProviderSession } = setup({});
    expect(
      prewarmThreadProviderSession({
        environmentId,
        threadId: THREAD_ID,
        modelSelection: null,
        mutationReady: false,
      }),
    ).toBe(false);
    expect(prewarmProviderSession).not.toHaveBeenCalled();
  });
});
