import { describe, expect, it, vi } from "vite-plus/test";

import {
  createHostedStore,
  INITIAL_HOSTED_ACCOUNT_STATE,
  INITIAL_HOSTED_HUB_STATE,
  INITIAL_HOSTED_RECOVERY_CODE_DISPLAY_STATE,
} from "./hostedStores.ts";
import { hostedAccountStore, hostedHubStore, hostedRecoveryCodeDisplayStore } from "./state.ts";

describe("hosted stores", () => {
  it("merges patches, replaces on request, and keeps the initial snapshot", () => {
    const store = createHostedStore({ count: 0, label: "a" });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setState({ count: 1 });
    expect(store.getState()).toEqual({ count: 1, label: "a" });
    store.setState({ count: 2, label: "b" }, true);
    expect(store.getState()).toEqual({ count: 2, label: "b" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getInitialState()).toEqual({ count: 0, label: "a" });

    expect(unsubscribe()).toBe(true);
    store.setState({ count: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes nothing for a patch that changes nothing", () => {
    const store = createHostedStore({ count: 0, label: "a", items: [] as string[] });
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getState();

    store.setState({});
    store.setState({ count: 0 });
    store.setState({ count: 0, label: "a", items: before.items });
    expect(store.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    store.setState({ count: 1, label: "a" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).not.toBe(before);
    expect(store.getState()).toEqual({ count: 1, label: "a", items: [] });

    // A new array with the same contents is a change: values compare by identity.
    store.setState({ items: [] });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("treats a missing key and an undefined patch value as the same", () => {
    const store = createHostedStore<{ count: number; note?: string | undefined }>({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ note: undefined });
    expect(listener).not.toHaveBeenCalled();
    store.setState({ note: "x" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("always publishes a replacement, even with an equal state", () => {
    const store = createHostedStore({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    const same = store.getState();
    store.setState(same, true);
    store.setState({ count: 0 }, true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState()).toEqual({ count: 0 });
  });

  it("still wakes the hosted store's subscribers for a real change after a skipped one", () => {
    // The relay transport's admission waiters subscribe to this store, so a
    // skipped no-op must never swallow the change that follows it.
    const initial = hostedHubStore.getState();
    const listener = vi.fn();
    const unsubscribe = hostedHubStore.subscribe(listener);
    try {
      hostedHubStore.setState({ browserStatus: initial.browserStatus });
      expect(listener).not.toHaveBeenCalled();
      hostedHubStore.setState({ browserStatus: "offline" });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(hostedHubStore.getState().browserStatus).toBe("offline");
    } finally {
      unsubscribe();
      hostedHubStore.setState(initial, true);
    }
  });

  it("is where the hosted runtime's stores take their initial snapshots from", () => {
    // A client without the hosted runtime publishes these same objects, so
    // "not hosted" cannot drift between the two.
    expect(hostedHubStore.getInitialState()).toBe(INITIAL_HOSTED_HUB_STATE);
    expect(hostedAccountStore.getInitialState()).toBe(INITIAL_HOSTED_ACCOUNT_STATE);
    expect(hostedRecoveryCodeDisplayStore.getInitialState()).toBe(
      INITIAL_HOSTED_RECOVERY_CODE_DISPLAY_STATE,
    );
  });
});
