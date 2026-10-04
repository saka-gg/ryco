import type { HostedHubState } from "@ryco/client-runtime/authorization";
import { describe, expect, it, vi } from "vite-plus/test";

import { createRetainedWake } from "./retainedWake";

type WakeState = Pick<HostedHubState, "accountStatus" | "browserStatus">;

function harness(initial: WakeState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const wake = vi.fn();
  const retainedWake = createRetainedWake({
    read: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    wake,
  });
  return {
    retainedWake,
    wake,
    listeners,
    set(patch: Partial<WakeState>) {
      state = { ...state, ...patch };
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

describe("retained node wake after a foreground recovery", () => {
  it("wakes retained nodes as soon as the recovery has revalidated access", () => {
    const { retainedWake, wake, listeners } = harness({
      accountStatus: "authenticated",
      browserStatus: "current",
    });

    retainedWake.begin()();

    expect(wake).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it("holds the wake until the access retry has made a stale browser current", () => {
    const { retainedWake, wake, listeners, set } = harness({
      accountStatus: "authenticated",
      browserStatus: "stale",
    });

    retainedWake.begin()();
    expect(wake).not.toHaveBeenCalled();

    set({ browserStatus: "checking-access" });
    set({ browserStatus: "synchronizing" });
    expect(wake).not.toHaveBeenCalled();

    set({ browserStatus: "current" });
    expect(wake).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);

    set({ browserStatus: "current" });
    expect(wake).toHaveBeenCalledOnce();
  });

  it("holds the wake until an unreachable account's access check succeeds", () => {
    const { retainedWake, wake, set } = harness({
      accountStatus: "unavailable",
      browserStatus: "current",
    });

    retainedWake.begin()();
    expect(wake).not.toHaveBeenCalled();

    set({ accountStatus: "authenticated" });
    expect(wake).toHaveBeenCalledOnce();
  });

  it("owes nothing once the app leaves the foreground", () => {
    const { retainedWake, wake, listeners, set } = harness({
      accountStatus: "authenticated",
      browserStatus: "stale",
    });

    retainedWake.begin()();
    retainedWake.cancel();
    expect(listeners.size).toBe(0);

    set({ browserStatus: "current" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("ignores a recovery that settles after the app left the foreground", () => {
    const { retainedWake, wake } = harness({
      accountStatus: "authenticated",
      browserStatus: "current",
    });

    const settled = retainedWake.begin();
    retainedWake.cancel();
    settled();

    expect(wake).not.toHaveBeenCalled();
  });

  it("stops waiting when the account is signed out", () => {
    const { retainedWake, wake, listeners, set } = harness({
      accountStatus: "authenticated",
      browserStatus: "stale",
    });

    retainedWake.begin()();
    // The teardown publishes the initial state, whose browser is `current`.
    set({ accountStatus: "signed-out", browserStatus: "current" });

    expect(wake).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
