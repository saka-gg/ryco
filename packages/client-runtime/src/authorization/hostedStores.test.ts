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
