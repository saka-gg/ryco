import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppLifecycleEvent } from "@ryco/client-runtime/platform";
import type { HostedHubState } from "@ryco/client-runtime/authorization";

const fixture = vi.hoisted(() => ({
  state: { accountStatus: "authenticated", browserStatus: "current" } as Pick<
    HostedHubState,
    "accountStatus" | "browserStatus"
  >,
  foreground: true,
  online: true,
  lifecycle: new Set<(event: AppLifecycleEvent) => void>(),
  stateListeners: new Set<() => void>(),
  cleanups: [] as Array<(() => void) | undefined>,
  wake: vi.fn(),
  cancel: vi.fn(),
  recover: vi.fn(async () => undefined),
  stayPolicy: undefined as unknown,
  createStayPolicy: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => fixture.cleanups.push(effect()),
}));
vi.mock("../platform/appLifecycle", () => ({
  mobileAppLifecycle: {
    isForeground: () => fixture.foreground,
    isOnline: () => fixture.online,
    subscribe: (listener: (event: AppLifecycleEvent) => void) => {
      fixture.lifecycle.add(listener);
      return () => fixture.lifecycle.delete(listener);
    },
  },
}));
vi.mock("../connection/hostedConnectionCoordinator", () => ({
  getMobileHostedConnectionCoordinator: () => ({
    reconnectRetainedAfterForeground: fixture.wake,
    cancelPendingRecovery: fixture.cancel,
    releaseNonRetainedForBackground: async () => undefined,
  }),
}));
vi.mock("../platform/appRuntimeNative", () => ({ rycoAppRuntimeNative: () => null }));
vi.mock("./backgroundStay", () => ({
  createMobileBackgroundStayPolicy: (native: unknown) => {
    fixture.createStayPolicy(native);
    return fixture.stayPolicy;
  },
}));
vi.mock("./state", () => ({
  useHostedHubStore: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  hostedHubStore: {
    getState: () => fixture.state,
    subscribe: (listener: () => void) => {
      fixture.stateListeners.add(listener);
      return () => fixture.stateListeners.delete(listener);
    },
  },
  hostedHubController: { suspendBrowser: vi.fn(), recoverAfterConnectivity: fixture.recover },
}));

import { useHostedAppLifecycle } from "./useHostedAppLifecycle";

function unmount() {
  for (const cleanup of fixture.cleanups.splice(0)) cleanup?.();
}

beforeEach(() => {
  fixture.state = { accountStatus: "authenticated", browserStatus: "current" };
  fixture.foreground = true;
  fixture.online = true;
  fixture.stayPolicy = undefined;
  vi.clearAllMocks();
});
afterEach(() => {
  unmount();
  fixture.lifecycle.clear();
  fixture.stateListeners.clear();
});

describe("mobile hosted lifecycle binding", () => {
  it("restores planning on a foreground remount without requiring another native event", () => {
    useHostedAppLifecycle();
    expect(fixture.wake).toHaveBeenCalledOnce();
    unmount();
    expect(fixture.cancel).toHaveBeenCalledOnce();
    useHostedAppLifecycle();
    expect(fixture.wake).toHaveBeenCalledTimes(2);
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  it("waits for access revalidation and cancels that wait on unmount", () => {
    fixture.state = { ...fixture.state, browserStatus: "stale" };
    useHostedAppLifecycle();
    expect(fixture.wake).not.toHaveBeenCalled();
    fixture.state = { ...fixture.state, browserStatus: "current" };
    for (const listener of fixture.stateListeners) listener();
    expect(fixture.wake).toHaveBeenCalledOnce();
    unmount();
    expect(fixture.stateListeners.size).toBe(0);
  });

  it.each(["foreground", "online"] as const)("does not wake while %s is false", (field) => {
    fixture[field] = false;
    useHostedAppLifecycle();
    expect(fixture.wake).not.toHaveBeenCalled();
  });

  it("keeps the connections through a short app switch when the binary can", async () => {
    const stay = {
      eligible: () => true,
      begin: vi.fn(() => ({ remainingMs: Number.POSITIVE_INFINITY, end: vi.fn() })),
      confirmKept: vi.fn(async () => true),
      resumeKept: vi.fn(),
    };
    fixture.stayPolicy = stay;
    useHostedAppLifecycle();
    expect(fixture.createStayPolicy).toHaveBeenCalledWith(null);
    fixture.foreground = false;
    for (const listener of fixture.lifecycle) listener("background");
    expect(stay.begin).toHaveBeenCalledOnce();
    expect(fixture.cancel).not.toHaveBeenCalled();
    fixture.foreground = true;
    for (const listener of fixture.lifecycle) listener("foreground");
    await Promise.resolve();
    await Promise.resolve();
    expect(stay.confirmKept).toHaveBeenCalledOnce();
    expect(stay.resumeKept).toHaveBeenCalledOnce();
    expect(fixture.recover).not.toHaveBeenCalled();
  });
});
