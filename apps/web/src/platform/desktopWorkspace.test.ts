import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopBridge,
  type DesktopWorkspaceConnectionCommand,
  type DesktopWorkspaceStateProjection,
} from "@ryco/contracts";
import type { WorkspaceMetadataSnapshot } from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { retainDesktopWorkspaceThreadScope, startDesktopWorkspaceBridge } from "./desktopWorkspace";
import { selectEnvironmentState, useStore } from "../store";
import * as runtime from "../environments/runtime";
import * as metadata from "../workspaceMetadataProjection";

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
