import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AppLifecycleEvent } from "@ryco/client-runtime/platform";

const native = vi.hoisted(() => ({
  appListeners: new Set<(state: string) => void>(),
  networkListeners: new Set<(state: { isConnected?: boolean }) => void>(),
  getNetworkState: vi.fn<() => Promise<{ isConnected?: boolean }>>(),
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.appListeners.add(listener);
      return { remove: () => native.appListeners.delete(listener) };
    },
  },
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: native.getNetworkState,
  addNetworkStateListener: (listener: (state: { isConnected?: boolean }) => void) => {
    native.networkListeners.add(listener);
    return { remove: () => native.networkListeners.delete(listener) };
  },
}));

const network = (isConnected: boolean) => {
  for (const listener of native.networkListeners) listener({ isConnected });
};
const appState = (state: string) => {
  for (const listener of native.appListeners) listener(state);
};
const deferredNetwork = () => {
  let resolve!: (state: { isConnected?: boolean }) => void;
  const promise = new Promise<{ isConnected?: boolean }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetModules();
  native.appListeners.clear();
  native.networkListeners.clear();
  native.getNetworkState.mockReset().mockResolvedValue({ isConnected: true });
});

describe("mobile lifecycle connectivity", () => {
  it("delivers each connectivity transition to every runtime subscriber", async () => {
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const events: AppLifecycleEvent[][] = [[], [], []];
    const unsubscribe = events.map((received) =>
      mobileAppLifecycle.subscribe((event) => received.push(event)),
    );
    await Promise.resolve();
    network(false);
    network(false);
    network(true);
    expect(events).toEqual([
      ["offline", "online"],
      ["offline", "online"],
      ["offline", "online"],
    ]);
    unsubscribe.forEach((stop) => stop());
    expect(native.networkListeners.size).toBe(0);
    expect(native.appListeners.size).toBe(0);
  });

  it("publishes an initial offline probe to all subscribers", async () => {
    const probe = deferredNetwork();
    native.getNetworkState.mockReturnValue(probe.promise);
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const first = vi.fn();
    const second = vi.fn();
    mobileAppLifecycle.subscribe(first);
    mobileAppLifecycle.subscribe(second);
    probe.resolve({ isConnected: false });
    await Promise.resolve();
    expect(mobileAppLifecycle.isOnline()).toBe(false);
    expect(first).toHaveBeenCalledWith("offline");
    expect(second).toHaveBeenCalledWith("offline");
  });

  it("rechecks connectivity on foreground when the OS missed an online event", async () => {
    native.getNetworkState.mockResolvedValueOnce({ isConnected: false });
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const events: AppLifecycleEvent[] = [];
    mobileAppLifecycle.subscribe((event) => events.push(event));
    await Promise.resolve();
    appState("background");
    appState("active");
    await Promise.resolve();
    expect(mobileAppLifecycle.isOnline()).toBe(true);
    expect(events).toEqual(["offline", "background", "foreground", "resume", "online"]);
  });

  it("does not let an old probe overwrite a newer network notification", async () => {
    const probe = deferredNetwork();
    native.getNetworkState.mockReturnValue(probe.promise);
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const listener = vi.fn();
    mobileAppLifecycle.subscribe(listener);
    network(false);
    probe.resolve({ isConnected: true });
    await Promise.resolve();
    expect(mobileAppLifecycle.isOnline()).toBe(false);
    expect(listener.mock.calls).toEqual([["offline"]]);
  });

  it("ignores probes from an unsubscribed lifecycle generation", async () => {
    const oldProbe = deferredNetwork();
    const currentProbe = deferredNetwork();
    native.getNetworkState
      .mockReturnValueOnce(oldProbe.promise)
      .mockReturnValueOnce(currentProbe.promise);
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const oldListener = vi.fn();
    mobileAppLifecycle.subscribe(oldListener)();
    const listener = vi.fn();
    mobileAppLifecycle.subscribe(listener);
    currentProbe.resolve({ isConnected: false });
    await Promise.resolve();
    oldProbe.resolve({ isConnected: true });
    await Promise.resolve();
    expect(mobileAppLifecycle.isOnline()).toBe(false);
    expect(oldListener).not.toHaveBeenCalled();
    expect(listener.mock.calls).toEqual([["offline"]]);
  });

  it("keeps other subscribers active when one unsubscribes", async () => {
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const first = vi.fn();
    const second = vi.fn();
    const stop = mobileAppLifecycle.subscribe(first);
    mobileAppLifecycle.subscribe(second);
    await Promise.resolve();
    stop();
    network(false);
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls).toEqual([["offline"]]);
  });

  it("ignores an initial probe superseded by a foreground refresh", async () => {
    const oldProbe = deferredNetwork();
    native.getNetworkState.mockReturnValueOnce(oldProbe.promise);
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const listener = vi.fn();
    mobileAppLifecycle.subscribe(listener);
    appState("background");
    appState("active");
    await Promise.resolve();
    oldProbe.resolve({ isConnected: false });
    await Promise.resolve();
    expect(mobileAppLifecycle.isOnline()).toBe(true);
    expect(listener).not.toHaveBeenCalledWith("offline");
  });

  it("preserves connectivity on a failed probe and retries on the next foreground", async () => {
    native.getNetworkState
      .mockResolvedValueOnce({ isConnected: false })
      .mockRejectedValueOnce(new Error("network probe unavailable"));
    const { mobileAppLifecycle } = await import("./appLifecycle");
    const listener = vi.fn();
    mobileAppLifecycle.subscribe(listener);
    await Promise.resolve();
    appState("background");
    appState("active");
    await Promise.resolve();
    expect(mobileAppLifecycle.isOnline()).toBe(false);
    appState("background");
    appState("active");
    await Promise.resolve();
    expect(mobileAppLifecycle.isOnline()).toBe(true);
    expect(listener).toHaveBeenCalledWith("online");
  });
});
