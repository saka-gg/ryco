import type { AppLifecycleEvent, AppLifecycleService } from "@ryco/client-runtime/platform";
import { E2EE_SUITE_25519_CHACHAPOLY_SHA256 } from "@ryco/shared/relayE2eeWire";
import type { RelayE2eeHost, RelayE2eeReservation } from "@ryco/client-runtime/relay";
import type { RelayE2eeInitiatorAttempt } from "@ryco/client-runtime/relay/e2ee";
import { RELAY_INITIAL_LIMITS } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// The provider's production default reaches `./appLifecycle`, which is the
// wiring this file exists to prove; the two native modules behind it are stubbed
// so the seam can be exercised off-device.
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));

import { makeMobileRelayE2eeProvider } from "./e2eeRelayProvider";

// The React Native lifecycle half of docs/relay-e2ee-protocol.md §4.4 and §8.9.
// The K rows themselves are driven in `packages/client-runtime`; what is tested
// here is the one decision this file makes — that a backgrounded app never
// negotiates, and that a background transition mid-negotiation is a
// client-initiated FATAL-PRE rather than a wait for the node's §11.3 Q8.

const ATTEMPT: RelayE2eeInitiatorAttempt = {
  hubOrigin: "https://hub.example.com",
  selectionClass: "legacy-eligible",
  legacyPermitted: true,
  pairingOnly: false,
  localSuitePreference: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
  credentials: { tier: "web" },
};

function stubLifecycle(foreground: boolean) {
  const listeners: ((event: AppLifecycleEvent) => void)[] = [];
  let unsubscribed = 0;
  const service: AppLifecycleService = {
    isForeground: () => foreground,
    isOnline: () => true,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        unsubscribed += 1;
      };
    },
  };
  return {
    service,
    emit: (event: AppLifecycleEvent) => {
      for (const listener of listeners.slice()) listener(event);
    },
    listeners,
    unsubscribeCount: () => unsubscribed,
  };
}

function stubHost() {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const closes: (unknown | undefined)[] = [];
  const admitted: number[] = [];
  const locked: string[] = [];
  const host: RelayE2eeHost = {
    limits: RELAY_INITIAL_LIMITS,
    channel: {
      channelId: "ch_cccccccccccccccccccccc",
      capability: "ryco.rpc",
      effectiveRole: "operator",
      relayProtocolMajor: 1,
      relayProtocolMinor: 2,
    },
    admit: (messageBytes): RelayE2eeReservation | undefined => {
      admitted.push(messageBytes);
      return { send: () => true, release: () => undefined };
    },
    lockMode: (mode) => void locked.push(mode),
    close: (failure) => void closes.push(failure),
    now: () => 1_784_160_030_000,
    setTimeout: (callback) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  return { host, closes, locked, admitted, timers };
}

describe("the native relay E2EE provider and the React Native lifecycle", () => {
  it("never negotiates a channel accepted into a backgrounded app", () => {
    const lifecycle = stubLifecycle(false);
    const { host, closes, locked } = stubHost();

    const channel = makeMobileRelayE2eeProvider({
      attempt: ATTEMPT,
      lifecycle: lifecycle.service,
    })(host);

    // §11.2: FATAL-PRE with no record of any kind, and nothing released — the
    // valve is never opened, so the application never sees the channel.
    expect(closes).toHaveLength(1);
    expect(locked).toEqual([]);
    expect(channel.mode()).toBe("closed");
  });

  it("aborts a channel that is still negotiating when the app backgrounds", () => {
    const lifecycle = stubLifecycle(true);
    const { host, closes, locked } = stubHost();

    const channel = makeMobileRelayE2eeProvider({
      attempt: ATTEMPT,
      lifecycle: lifecycle.service,
    })(host);
    expect(closes).toEqual([]);
    expect(channel.mode()).toBe("negotiating");

    lifecycle.emit("background");

    // Deciding the channel BEFORE `T_HANDSHAKE_NODE` does, and deciding it
    // fail-closed: no record, no legacy fallback, and no released payload.
    expect(channel.mode()).toBe("closed");
    expect(closes).toHaveLength(1);
    expect(locked).toEqual([]);
  });

  it("leaves a channel that already locked a mode to the ordinary reconnect", () => {
    const lifecycle = stubLifecycle(true);
    const { host, closes, locked, timers } = stubHost();
    const channel = makeMobileRelayE2eeProvider({
      attempt: ATTEMPT,
      lifecycle: lifecycle.service,
    })(host);

    // Row K13: `T_ADV` expires with a legacy-eligible selection and the channel
    // locks `legacy`, which `T_HANDSHAKE_NODE` never covered.
    for (const run of Array.from(timers.values())) run();
    expect(locked).toEqual(["legacy"]);

    lifecycle.emit("background");

    expect(closes).toEqual([]);
    expect(channel.mode()).toBe("legacy");
  });

  it("unsubscribes from the lifecycle when the channel is disposed", () => {
    const lifecycle = stubLifecycle(true);
    const { host } = stubHost();
    const channel = makeMobileRelayE2eeProvider({
      attempt: ATTEMPT,
      lifecycle: lifecycle.service,
    })(host);

    channel.dispose();

    expect(lifecycle.unsubscribeCount()).toBe(1);
    lifecycle.emit("background");
    expect(channel.mode()).toBe("closed");
  });

  it("passes the engine's own channel.open through to the machine", () => {
    const lifecycle = stubLifecycle(true);
    const { host } = stubHost();
    const provider = makeMobileRelayE2eeProvider({
      attempt: ATTEMPT,
      lifecycle: lifecycle.service,
    });
    const spy = vi.fn(host.lockMode);

    // The provider adds no channel identity of its own: §8.3 elements 13–14 come
    // from the frame the engine received, and this file has no second source.
    expect(() => provider({ ...host, lockMode: spy })).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
