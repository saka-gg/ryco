import {
  EnvironmentId,
  ThreadId,
  type DesktopBridge,
  type DesktopWorkspaceStateProjection,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { retainDesktopWorkspaceThreadScope, startDesktopWorkspaceBridge } from "./desktopWorkspace";

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
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
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
