import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopBridge,
  type DesktopWorkspaceStateProjection,
} from "@ryco/contracts";
import type { WorkspaceMetadataSnapshot } from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { retainDesktopWorkspaceThreadScope, startDesktopWorkspaceBridge } from "./desktopWorkspace";
import { selectEnvironmentState, useStore } from "../store";
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
