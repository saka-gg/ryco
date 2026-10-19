import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopBridge,
  type DesktopWorkspaceConnectionCommand,
  type DesktopWorkspaceStateProjection,
  type DesktopWorkspaceStatePush,
} from "@ryco/contracts";
import {
  MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT,
  MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT,
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataSnapshot,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readDesktopWorkspaceState,
  retainDesktopWorkspaceThreadScope,
  startDesktopWorkspaceBridge,
} from "./desktopWorkspace";
import { selectEnvironmentState, useStore } from "../store";
import * as runtime from "../environments/runtime";
import * as metadata from "../workspaceMetadataProjection";
import * as hydration from "./desktopWorkspaceCacheHydration";

const environmentId = EnvironmentId.make("desktop-workspace-test-environment");

const workspaceState = (
  canConnect: boolean,
  status: DesktopWorkspaceStateProjection["status"] = "ready",
): DesktopWorkspaceStateProjection => ({
  status,
  accountId: status === "ready" ? "account-test" : null,
  localEnvironmentId: null,
  machines:
    status === "ready"
      ? [
          {
            environmentId,
            nodeId: "node-test",
            label: "Test node",
            online: canConnect,
            nativeTrust: canConnect ? "verified" : "unverified",
            connectionState: "disconnected",
            canReadMetadata: canConnect,
            canConnect,
            canMutate: canConnect,
            effectiveRole: "owner",
            threadSettlementSupported: false,
            accessReasons: [],
          },
        ]
      : [],
  snapshots: [],
  queuedEnvironmentIds: [],
  activeConnectionCount: 0,
});

function metadataSnapshot(
  snapshotEnvironmentId: EnvironmentId,
  capturedAt: number,
  options: { readonly threads?: number; readonly titleLength?: number } = {},
): WorkspaceMetadataSnapshot {
  const projectId = ProjectId.make("project-1");
  return {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId: snapshotEnvironmentId,
    capturedAt,
    projects: [
      {
        environmentId: snapshotEnvironmentId,
        id: projectId,
        name: "Project",
        cwd: "/project",
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [],
    threads: Array.from({ length: options.threads ?? 1 }, (_, index) => ({
      environmentId: snapshotEnvironmentId,
      id: ThreadId.make(`thread-${index}`),
      projectId,
      worktreeId: null,
      title: `Thread ${index} ${"x".repeat(options.titleLength ?? 0)}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      // Later threads are newer, so bounding drops the earliest ones first.
      updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      archivedAt: null,
      modelSelection: null,
      providerDriver: null,
      branch: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      deliveryUnknown: false,
    })),
  };
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("desktop workspace metadata publication", () => {
  it("settles after a main-process echo, publishes real changes, and resets on access loss", async () => {
    vi.useFakeTimers();
    const originalState = useStore.getState();
    const environment = {
      ...selectEnvironmentState(originalState, environmentId),
      bootstrapComplete: true,
    };
    useStore.setState({ environmentStateById: { [environmentId]: environment } });
    let stateListener: ((state: DesktopWorkspaceStateProjection) => void) | undefined;
    const publish = vi.fn(async (snapshot: WorkspaceMetadataSnapshot) => {
      const state = { ...workspaceState(true), snapshots: [snapshot] };
      stateListener?.(state);
      return state;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getDesktopWorkspaceState: async () => workspaceState(true),
          publishDesktopWorkspaceSnapshot: publish,
          onDesktopWorkspaceState: (listener: typeof stateListener) => {
            stateListener = listener;
            return () => undefined;
          },
        },
      },
    });
    const stop = startDesktopWorkspaceBridge();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(publish).toHaveBeenCalledTimes(1);
      // Unrelated store updates and catalog refreshes must not renew capturedAt.
      useStore.setState({});
      stateListener?.(workspaceState(true));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(publish).toHaveBeenCalledTimes(1);

      const read = vi.spyOn(metadata, "readWorkspaceMetadataSnapshot");
      const snapshot = read(environmentId, 0)!;
      read.mockReturnValue({
        ...snapshot,
        projects: [
          {
            environmentId,
            id: ProjectId.make("new-project"),
            name: "New project",
            cwd: "/code/new",
            repositoryIdentity: null,
            createdAt: null,
            updatedAt: null,
          },
        ],
      });
      useStore.setState({});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(publish).toHaveBeenCalledTimes(2);
      stateListener?.(workspaceState(false));
      stateListener?.(workspaceState(true));
      await vi.advanceTimersByTimeAsync(500);
      expect(publish).toHaveBeenCalledTimes(3);
    } finally {
      stop();
      useStore.setState(originalState, true);
    }
  });

  it("never republishes hydrated offline metadata as fresh live data", async () => {
    vi.useFakeTimers();
    const originalState = useStore.getState();
    useStore.setState({
      environmentStateById: {
        [environmentId]: {
          ...selectEnvironmentState(originalState, environmentId),
          bootstrapComplete: true,
          hydratedFromCacheAt: 1,
        },
      },
    });
    const cachedSnapshot = metadata.readWorkspaceMetadataSnapshot(environmentId, 1)!;
    const publish = vi.fn(async () => workspaceState(true));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getDesktopWorkspaceState: async () => ({
            ...workspaceState(true),
            snapshots: [cachedSnapshot],
          }),
          publishDesktopWorkspaceSnapshot: publish,
        },
      },
    });
    const stop = startDesktopWorkspaceBridge();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(metadata.readWorkspaceMetadataSnapshot(environmentId, 1)).not.toBeNull();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      stop();
      useStore.setState(originalState, true);
    }
  });
});

describe("desktop workspace metadata publication cost", () => {
  function startPublishing() {
    vi.useFakeTimers();
    const publish = vi.fn(async (_snapshot: WorkspaceMetadataSnapshot) => workspaceState(true));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getDesktopWorkspaceState: async () => workspaceState(true),
          publishDesktopWorkspaceSnapshot: publish,
        },
      },
    });
    const originalState = useStore.getState();
    const stop = startDesktopWorkspaceBridge();
    return {
      publish,
      tick: async () => {
        useStore.setState({});
        await vi.advanceTimersByTimeAsync(200);
      },
      stop: () => {
        stop();
        useStore.setState(originalState, true);
      },
    };
  }

  it("bounds a snapshot to the thread cap before handing it to main", async () => {
    const oversized = metadataSnapshot(environmentId, 0, {
      threads: MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT + 50,
    });
    vi.spyOn(metadata, "readWorkspaceMetadataSnapshot").mockReturnValue(oversized);
    const f = startPublishing();
    try {
      await f.tick();
      expect(f.publish).toHaveBeenCalledTimes(1);
      const published = f.publish.mock.calls[0]![0];
      expect(published.threads).toHaveLength(MAX_WORKSPACE_SNAPSHOT_THREADS_PER_ENVIRONMENT);
      // The newest threads stay; the oldest are dropped.
      expect(published.threads.at(-1)?.id).toBe(oversized.threads.at(-1)?.id);
      expect(published.threads.some((thread) => thread.id === oversized.threads[0]?.id)).toBe(
        false,
      );
      expect(published.projects).toEqual(oversized.projects);
    } finally {
      f.stop();
    }
  });

  it("bounds a snapshot to the byte cap before handing it to main", async () => {
    const heavy = metadataSnapshot(environmentId, 0, { threads: 100, titleLength: 30_000 });
    expect(workspaceMetadataPayloadBytes(heavy)).toBeGreaterThan(
      MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT,
    );
    vi.spyOn(metadata, "readWorkspaceMetadataSnapshot").mockReturnValue(heavy);
    const f = startPublishing();
    try {
      await f.tick();
      const published = f.publish.mock.calls[0]![0];
      expect(workspaceMetadataPayloadBytes(published)).toBeLessThanOrEqual(
        MAX_WORKSPACE_SNAPSHOT_BYTES_PER_ENVIRONMENT,
      );
      expect(published.threads.length).toBeGreaterThan(0);
      expect(published.threads.length).toBeLessThan(heavy.threads.length);
    } finally {
      f.stop();
    }
  });

  it("publishes only when the content changes, whether or not the arrays are rebuilt", async () => {
    const base = metadataSnapshot(environmentId, 0, { threads: 3 });
    const read = vi
      .spyOn(metadata, "readWorkspaceMetadataSnapshot")
      .mockImplementation(() => structuredClone(base));
    const f = startPublishing();
    try {
      await f.tick();
      expect(f.publish).toHaveBeenCalledTimes(1);

      // Equal content in fresh arrays is not a change, and costs no serialization.
      const stringify = vi.spyOn(JSON, "stringify");
      await f.tick();
      await f.tick();
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect(stringify).not.toHaveBeenCalled();
      stringify.mockRestore();

      // The same arrays again are not a change either.
      const unchanged = structuredClone(base);
      read.mockImplementation(() => unchanged);
      await f.tick();
      await f.tick();
      expect(f.publish).toHaveBeenCalledTimes(1);

      const [first, second, third] = structuredClone(base).threads;
      const retitled: WorkspaceMetadataSnapshot = {
        ...structuredClone(base),
        threads: [first!, { ...second!, title: "Renamed" }, third!],
      };
      read.mockImplementation(() => retitled);
      await f.tick();
      expect(f.publish).toHaveBeenCalledTimes(2);
      expect(f.publish.mock.calls[1]![0].threads[1]?.title).toBe("Renamed");
    } finally {
      f.stop();
    }
  });
});

describe("desktop workspace pushed state", () => {
  const cachedEnvironmentId = EnvironmentId.make("desktop-workspace-cached-environment");

  async function startAdopting() {
    let stateListener: ((state: Partial<DesktopWorkspaceStateProjection>) => void) | undefined;
    const getState = vi.fn(async () => workspaceState(true));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getDesktopWorkspaceState: getState,
          onDesktopWorkspaceState: (listener: typeof stateListener) => {
            stateListener = listener;
            return () => undefined;
          },
        },
      },
    });
    const originalState = useStore.getState();
    const stop = startDesktopWorkspaceBridge();
    // The bridge adopts the first state in a callback registered before this await.
    await getState.mock.results[0]!.value;
    const push = (snapshots?: ReadonlyArray<WorkspaceMetadataSnapshot>) => {
      const { snapshots: _held, ...state } = workspaceState(true);
      stateListener?.(snapshots === undefined ? state : { ...state, snapshots });
    };
    // Start from no held snapshots, whatever an earlier test left behind.
    push([]);
    return {
      push,
      stop: () => {
        stop();
        useStore.setState(originalState, true);
      },
    };
  }

  it("keeps a held snapshot when a push repeats it or leaves snapshots out", async () => {
    const convert = vi.spyOn(metadata, "workspaceMetadataToCachedShellSnapshot");
    const reconcile = vi.spyOn(hydration, "reconcileDesktopWorkspaceCacheHydration");
    const f = await startAdopting();
    try {
      const first = metadataSnapshot(cachedEnvironmentId, 100);
      f.push([first]);
      const held = readDesktopWorkspaceState().snapshots;
      expect(held[0]).toBe(first);
      expect(
        useStore.getState().environmentStateById[cachedEnvironmentId]?.hydratedFromCacheAt,
      ).toBe(100);
      expect(convert).toHaveBeenCalledTimes(1);

      // The same snapshot in a new object, as delivered by another push.
      f.push([structuredClone(first)]);
      expect(readDesktopWorkspaceState().snapshots).toBe(held);
      expect(readDesktopWorkspaceState().snapshots[0]).toBe(first);
      // A held snapshot whose environment is in the store is not validated or hydrated again.
      expect(reconcile.mock.lastCall![0].snapshots).toEqual([]);

      f.push();
      expect(readDesktopWorkspaceState().snapshots).toBe(held);
      expect(convert).toHaveBeenCalledTimes(1);
    } finally {
      f.stop();
    }
  });

  it("replaces a snapshot only when it was captured again, and hydrates what the store lost", async () => {
    const convert = vi.spyOn(metadata, "workspaceMetadataToCachedShellSnapshot");
    const reconcile = vi.spyOn(hydration, "reconcileDesktopWorkspaceCacheHydration");
    const f = await startAdopting();
    try {
      f.push([metadataSnapshot(cachedEnvironmentId, 100)]);
      expect(convert).toHaveBeenCalledTimes(1);

      const newer = metadataSnapshot(cachedEnvironmentId, 200, { threads: 2 });
      f.push([newer]);
      expect(readDesktopWorkspaceState().snapshots[0]).toBe(newer);
      // The store already has the environment, so there is nothing to hydrate.
      expect(convert).toHaveBeenCalledTimes(1);

      useStore.getState().removeEnvironmentState(cachedEnvironmentId);
      f.push([structuredClone(newer)]);
      expect(readDesktopWorkspaceState().snapshots[0]).toBe(newer);
      expect(reconcile.mock.lastCall![0].snapshots).toEqual([newer]);
      expect(convert).toHaveBeenCalledTimes(2);
      expect(
        useStore.getState().environmentStateById[cachedEnvironmentId]?.hydratedFromCacheAt,
      ).toBe(200);

      // A snapshot that is no longer pushed takes its cache-hydrated environment with it.
      f.push([]);
      expect(readDesktopWorkspaceState().snapshots).toEqual([]);
      expect(useStore.getState().environmentStateById[cachedEnvironmentId]).toBeUndefined();
    } finally {
      f.stop();
    }
  });
});

describe("desktop workspace initial state read", () => {
  const readEnvironmentId = EnvironmentId.make("desktop-workspace-read-environment");

  /** The bridge started with its initial state read still unanswered. */
  function startReading() {
    let stateListener: ((state: DesktopWorkspaceStatePush) => void) | undefined;
    let answer!: (state: DesktopWorkspaceStateProjection) => void;
    const read = new Promise<DesktopWorkspaceStateProjection>((resolve) => {
      answer = resolve;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getDesktopWorkspaceState: () => read,
          onDesktopWorkspaceState: (listener: typeof stateListener) => {
            stateListener = listener;
            return () => undefined;
          },
        },
      },
    });
    const originalState = useStore.getState();
    const stop = startDesktopWorkspaceBridge();
    const push = (snapshots?: ReadonlyArray<WorkspaceMetadataSnapshot>) => {
      const { snapshots: _held, ...state } = workspaceState(true);
      stateListener?.(snapshots === undefined ? state : { ...state, snapshots });
    };
    return {
      push,
      // The read answers with an older state: the account is not signed in.
      answerWith: async (snapshots: ReadonlyArray<WorkspaceMetadataSnapshot>) => {
        answer({ ...workspaceState(true, "unavailable"), snapshots });
        // The bridge handles the answer in a callback registered before this await.
        await read;
      },
      stop: () => {
        push([]);
        stop();
        useStore.setState(originalState, true);
      },
    };
  }

  it("adopts the state it reads when nothing was pushed meanwhile", async () => {
    const f = startReading();
    try {
      const held = metadataSnapshot(readEnvironmentId, 100);
      await f.answerWith([held]);
      expect(readDesktopWorkspaceState().status).toBe("unavailable");
      expect(readDesktopWorkspaceState().snapshots[0]).toBe(held);
    } finally {
      f.stop();
    }
  });

  it("keeps a state pushed with snapshots over the older state read after it", async () => {
    const f = startReading();
    try {
      const newer = metadataSnapshot(readEnvironmentId, 200);
      f.push([newer]);
      await f.answerWith([metadataSnapshot(readEnvironmentId, 100)]);

      expect(readDesktopWorkspaceState().status).toBe("ready");
      expect(readDesktopWorkspaceState().machines).toHaveLength(1);
      expect(readDesktopWorkspaceState().snapshots[0]).toBe(newer);
    } finally {
      f.stop();
    }
  });

  it("keeps the pushed state but takes the snapshots of the read when the push left them out", async () => {
    const f = startReading();
    try {
      f.push();
      expect(readDesktopWorkspaceState().snapshots).toEqual([]);

      const held = metadataSnapshot(readEnvironmentId, 100);
      await f.answerWith([held]);

      expect(readDesktopWorkspaceState().status).toBe("ready");
      expect(readDesktopWorkspaceState().machines).toHaveLength(1);
      expect(readDesktopWorkspaceState().snapshots[0]).toBe(held);
    } finally {
      f.stop();
    }
  });
});

describe("desktop workspace scope leases", () => {
  it("waits for an exact connectable catalog machine and releases it when eligibility is lost", async () => {
    let stateListener: ((state: DesktopWorkspaceStateProjection) => void) | undefined;
    const retain = vi.fn(async () => ({ leaseId: "lease-test", state: workspaceState(true) }));
    const release = vi.fn(async () => workspaceState(false));
    const bridge = {
      getDesktopWorkspaceState: vi.fn(async () => workspaceState(false, "signed-out")),
      onDesktopWorkspaceState: vi.fn((listener) => {
        stateListener = listener;
        return () => {
          stateListener = undefined;
        };
      }),
      onDesktopWorkspaceConnectionCommand: vi.fn(() => () => undefined),
      retainDesktopWorkspaceScope: retain,
      releaseDesktopWorkspaceScope: release,
      renewDesktopWorkspaceScope: vi.fn(async () => workspaceState(true)),
    } satisfies Partial<DesktopBridge>;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge: bridge },
    });

    const stopBridge = startDesktopWorkspaceBridge();
    await Promise.resolve();
    const releaseMountedScope = retainDesktopWorkspaceThreadScope(
      environmentId,
      ThreadId.make("thread-test"),
    );

    expect(retain).not.toHaveBeenCalled();
    stateListener?.(workspaceState(false));
    expect(retain).not.toHaveBeenCalled();

    stateListener?.(workspaceState(true));
    await Promise.resolve();
    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledWith({
      environmentId,
      scope: { type: "thread-detail", threadId: ThreadId.make("thread-test") },
    });

    stateListener?.(workspaceState(false));
    await Promise.resolve();
    expect(release).toHaveBeenCalledWith("lease-test");

    releaseMountedScope();
    stopBridge();
  });
});

describe("desktop workspace connection demand", () => {
  function commandBridge() {
    let listener: ((command: DesktopWorkspaceConnectionCommand) => void) | undefined;
    const report = vi.fn(async () => workspaceState(true));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getDesktopWorkspaceState: async () => workspaceState(true),
          onDesktopWorkspaceConnectionCommand: (next: typeof listener) => {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          reportDesktopWorkspaceConnection: report,
        },
      },
    });
    const stop = startDesktopWorkspaceBridge();
    const send = (action: "connect" | "release", delayMs = 0) =>
      listener?.({ environmentId, action, delayMs });
    return { stop, send, report };
  }

  it("coalesces simultaneous demands without reconnecting an existing workspace", async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    const bootstrapped = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const reconnect = vi.fn();
    const ensureBootstrapped = vi.fn(() => bootstrapped);
    vi.spyOn(runtime, "readEnvironmentConnection").mockReturnValue({
      reconnect,
      ensureBootstrapped,
      shellSnapshotReadiness: { read: () => ({ attempt: 1 }) },
    } as never);
    const f = commandBridge();
    await vi.advanceTimersByTimeAsync(0);
    f.send("connect");
    f.send("connect");
    expect(ensureBootstrapped).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.report).toHaveBeenCalledExactlyOnceWith({ environmentId, connected: true });
    f.stop();
  });

  it("does not report an old bootstrap as current connection readiness", async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    vi.spyOn(runtime, "readEnvironmentConnection").mockReturnValue({
      reconnect,
      ensureBootstrapped: async () => undefined,
      shellSnapshotReadiness: { read: () => null },
    } as never);
    const f = commandBridge();
    await vi.advanceTimersByTimeAsync(0);
    f.send("connect");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.report).toHaveBeenCalledExactlyOnceWith({ environmentId, connected: false });
    expect(reconnect).not.toHaveBeenCalled();
    f.stop();
  });

  it("cancels a delayed connect when release supersedes it", async () => {
    vi.useFakeTimers();
    vi.spyOn(runtime, "readEnvironmentConnection").mockReturnValue(null);
    const connect = vi.spyOn(runtime, "connectDesktopWorkspaceEnvironment");
    const f = commandBridge();
    await vi.advanceTimersByTimeAsync(0);
    f.send("connect", 250);
    f.send("release");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalledWith({ environmentId, connected: true });
    f.stop();
  });

  it("does not publish readiness after release during bootstrap", async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    const ensureBootstrapped = () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      });
    vi.spyOn(runtime, "readEnvironmentConnection").mockReturnValue({
      kind: "saved",
      ensureBootstrapped,
    } as never);
    const disconnect = vi.spyOn(runtime, "disconnectSavedEnvironment").mockResolvedValue(undefined);
    const f = commandBridge();
    await vi.advanceTimersByTimeAsync(0);
    f.send("connect");
    f.send("release");
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(environmentId);
    expect(f.report).not.toHaveBeenCalledWith({ environmentId, connected: true });
    f.stop();
  });

  it("reacquires an expired demand lease after renderer sleep", async () => {
    vi.useFakeTimers();
    let sequence = 0;
    const retain = vi.fn(async () => ({ leaseId: `lease-${++sequence}` }));
    const renew = vi
      .fn(async () => workspaceState(true))
      .mockRejectedValueOnce(new Error("expired"));
    const release = vi.fn(async () => workspaceState(true));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getDesktopWorkspaceState: async () => workspaceState(true),
          retainDesktopWorkspaceScope: retain,
          renewDesktopWorkspaceScope: renew,
          releaseDesktopWorkspaceScope: release,
        },
      },
    });
    const stop = startDesktopWorkspaceBridge();
    await vi.advanceTimersByTimeAsync(0);
    const releaseScope = retainDesktopWorkspaceThreadScope(
      environmentId,
      ThreadId.make("awake-thread"),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(retain).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith("lease-1");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(renew).toHaveBeenLastCalledWith("lease-2");
    expect(retain).toHaveBeenCalledTimes(2);
    releaseScope();
    stop();
  });
});
