import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  readMobileHostedConfig: vi.fn(),
  createMobileDpopSigner: vi.fn(),
  nativeAuthorization: {
    callbackUri: () => "ryco-dev://hosted/complete",
    deviceLabel: () => "Ryco mobile",
    randomBytes: async (length: number) => new Uint8Array(length),
    sha256: async () => new Uint8Array(32),
    openSystemBrowser: async () => ({ type: "cancel" as const }),
  },
  hydrate: vi.fn(async () => {}),
  bootstrap: vi.fn(async () => {}),
  calls: [] as string[],
  profileRaw: null as string | null,
  trustRevision: 0,
  trustListeners: new Set<() => void>(),
  prepareCalls: 0,
  disposeCalls: 0,
  resetSessionCalls: 0,
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async () => hoisted.profileRaw,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../platform/config", () => ({
  readMobileHostedConfig: hoisted.readMobileHostedConfig,
  readMobileNativePlatform: () => "ios",
  readMobileAppVersion: () => "1.0.0",
  readMobileDeviceLabel: () => "Test phone",
}));
vi.mock("../platform/dpopSigner", () => ({
  createMobileDpopSigner: hoisted.createMobileDpopSigner,
}));
vi.mock("../platform/nativeAuthorization", () => ({
  mobileNativeAuthorization: hoisted.nativeAuthorization,
}));
vi.mock("../platform/e2eeTrustStore", () => ({
  mobileE2eeTrustStore: {
    hydrate: async () => {
      hoisted.calls.push("trust-hydrate");
    },
    // The §4.4 attempt is re-resolved on every committed trust decision, so the
    // runtime subscribes to the document as well as to the selection.
    revision: () => hoisted.trustRevision,
    subscribe: (listener: () => void) => {
      hoisted.trustListeners.add(listener);
      return () => hoisted.trustListeners.delete(listener);
    },
  },
}));
vi.mock("./e2eeAttempt", () => ({
  disposeMobileRelayE2eeAttempt: () => {
    hoisted.disposeCalls += 1;
  },
  prepareMobileRelayE2eeAttempt: () => {
    hoisted.prepareCalls += 1;
    return Promise.resolve();
  },
  resolveMobileRelayE2eeProvider: () => undefined,
}));
vi.mock("./e2eeSession", () => ({
  resetMobileE2eeSession: () => {
    hoisted.resetSessionCalls += 1;
  },
}));
vi.mock("../platform/sessionCredentials", () => ({
  hydrateMobileHostedSessionToken: async () => {
    hoisted.calls.push("hydrate");
    await hoisted.hydrate();
  },
  mobileSessionCredentials: {
    mode: "bearer",
    readCsrfToken: () => null,
    writeCsrfToken: () => {},
    readBearerToken: () => "token",
    writeBearerToken: () => {},
  },
}));
// The node lifecycle reaches the whole connection registry; the wiring under
// test only needs it to be the right shape.
vi.mock("./nodeLifecycle", () => ({
  mobileHostedNodeLifecycle: {
    activate: async () => undefined,
    suspend: async () => undefined,
    deactivate: async () => undefined,
    clearNodeScopedState: () => undefined,
    writePrimaryEnvironmentDescriptor: () => undefined,
    connectPrimaryEnvironment: () => undefined,
    disconnectPrimaryEnvironment: async () => undefined,
    setActiveEnvironmentId: () => undefined,
  },
}));

import {
  getHostedRuntimeConfiguration,
  hostedHubController,
  hostedHubStore,
} from "@ryco/client-runtime/authorization";

import {
  configureMobileHostedRuntime,
  ensureMobileHostedSession,
  invalidateMobileHostedRuntime,
  isMobileHostedModeAvailable,
  resetMobileHostedRuntimeForTests,
} from "./runtime";
import {
  createHubProfile,
  resetMobileHubProfileCacheForTests,
  serializeHubProfile,
} from "./hubProfile";
import { resetMobileHostedRuntimeConfigForTests } from "./runtimeConfig";
import { getMobileHostedUnavailableReason } from "./runtimeAvailability";

const HOSTED_CONFIG = {
  hubOrigin: "https://hub.example.test",
  appUrl: "https://app.ryco.space/",
  relyingParty: "app.ryco.space",
};

const signer = { sign: async () => "proof" };

beforeEach(() => {
  resetMobileHubProfileCacheForTests();
  resetMobileHostedRuntimeForTests();
  resetMobileHostedRuntimeConfigForTests();
  hoisted.calls.length = 0;
  hoisted.profileRaw = null;
  hoisted.trustRevision = 0;
  hoisted.trustListeners.clear();
  hoisted.prepareCalls = 0;
  hoisted.disposeCalls = 0;
  hoisted.resetSessionCalls = 0;
  vi.clearAllMocks();
  hoisted.hydrate.mockResolvedValue(undefined);
  hoisted.readMobileHostedConfig.mockReturnValue(HOSTED_CONFIG);
  // The signer is resolved inside `configureMobileHostedRuntime`, which is what
  // installs the relay socket factory, so this marker is where a channel first
  // becomes possible.
  hoisted.createMobileDpopSigner.mockImplementation(async () => {
    hoisted.calls.push("configure");
    return signer;
  });
  vi.spyOn(hostedHubController, "bootstrap").mockImplementation(async () => {
    hoisted.calls.push("bootstrap");
  });
});

describe("hosted runtime configuration", () => {
  it("supplies every field the runtime contract requires", async () => {
    await expect(configureMobileHostedRuntime()).resolves.toBe(true);

    const configuration = getHostedRuntimeConfiguration();
    expect(typeof configuration.endpoint.origin).toBe("function");
    expect(typeof configuration.httpClient.fetch).toBe("function");
    expect(typeof configuration.passkeyCeremony.authenticate).toBe("function");
    expect(typeof configuration.passkeyCeremony.register).toBe("function");
    expect(configuration.sessionCredentials.mode).toBe("bearer");
    expect(configuration.dpopSigner).toBe(signer);
    expect(configuration.nativeAuthorization).toBe(hoisted.nativeAuthorization);
    expect(typeof configuration.nodeLifecycle.connectPrimaryEnvironment).toBe("function");
    expect(typeof configuration.isForeground).toBe("function");
    expect(typeof configuration.subscribeForeground).toBe("function");
    expect(typeof configuration.hasPendingRelayRequests).toBe("function");
    expect(typeof configuration.resetRelayAttemptFactory).toBe("function");
    expect(typeof configuration.relayUrl).toBe("function");
    expect(typeof configuration.createRelaySocket).toBe("function");
  });

  it("targets the Hub public origin, which is what the proof signs into htu", async () => {
    await configureMobileHostedRuntime();
    expect(getHostedRuntimeConfiguration().endpoint.origin()).toBe(HOSTED_CONFIG.hubOrigin);
  });

  it("passes bound timer wrappers, never raw platform methods", async () => {
    await configureMobileHostedRuntime();
    const { timers } = getHostedRuntimeConfiguration();

    // Unbound platform methods throw "Illegal invocation" under React Native.
    expect(timers.setTimeout).not.toBe(globalThis.setTimeout);
    expect(timers.clearTimeout).not.toBe(globalThis.clearTimeout);
    expect(timers.queueMicrotask).not.toBe(globalThis.queueMicrotask);
    expect(timers.now).not.toBe(Date.now);

    expect(typeof timers.now()).toBe("number");
    const handle = timers.setTimeout(() => {}, 0);
    timers.clearTimeout(handle);
    await new Promise<void>((resolve) => timers.queueMicrotask(resolve));
  });

  it("is idempotent across repeated calls", async () => {
    await configureMobileHostedRuntime();
    const first = getHostedRuntimeConfiguration();
    await configureMobileHostedRuntime();
    await configureMobileHostedRuntime();

    expect(getHostedRuntimeConfiguration()).toBe(first);
    expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(1);
  });

  it.each(["invalidate", "test-reset"] as const)(
    "revokes the warm attempt on hosted runtime %s",
    async (terminal) => {
      await configureMobileHostedRuntime();
      const disposals = hoisted.disposeCalls;

      if (terminal === "invalidate") invalidateMobileHostedRuntime();
      else resetMobileHostedRuntimeForTests();

      // Production disposal revokes a pending borrow's lifetime; the attempt
      // suite holds an actual read open across both disposal and test reset.
      expect(hoisted.disposeCalls).toBe(disposals + 1);
      expect(hoisted.resetSessionCalls).toBeGreaterThan(0);
    },
  );

  it("does not prepare an application channel before native enrollment is ready", async () => {
    hostedHubStore.setState({
      accountStatus: "signed-out",
      account: null,
      selectedNode: null,
      generation: 0,
    } as never);
    await configureMobileHostedRuntime();
    const prepareAtStart = hoisted.prepareCalls;

    const account = (id: string) => ({ id }) as never;
    const node = (id: string) => ({ id }) as never;
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: account("a\u0000b"),
      selectedNode: node("c"),
      generation: 1,
    } as never);
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: account("a"),
      selectedNode: node("b\u0000c"),
      generation: 1,
    } as never);
    expect(hoisted.prepareCalls).toBe(prepareAtStart);

    // A repeated notification for the same primitive snapshot is deduplicated.
    hostedHubStore.setState({ accountStatus: "authenticated" } as never);
    expect(hoisted.prepareCalls).toBe(prepareAtStart);

    hostedHubStore.setState({ generation: 2 } as never);
    expect(hoisted.prepareCalls).toBe(prepareAtStart);

    hoisted.trustRevision += 1;
    for (const listener of hoisted.trustListeners) listener();
    expect(hoisted.prepareCalls).toBe(prepareAtStart);

    hostedHubStore.setState({
      accountStatus: "signed-out",
      account: null,
      selectedNode: null,
    } as never);
    const disposals = hoisted.disposeCalls;
    hostedHubStore.setState({ account: account("") } as never);
    expect(hoisted.disposeCalls).toBe(disposals + 1);
  });
});

describe("fail-closed configuration", () => {
  it("does not configure when hosted mode is unconfigured", async () => {
    hoisted.readMobileHostedConfig.mockReturnValue(null);

    await expect(configureMobileHostedRuntime()).resolves.toBe(false);
    expect(isMobileHostedModeAvailable()).toBe(false);
    expect(hoisted.createMobileDpopSigner).not.toHaveBeenCalled();
  });

  it("does not configure when no hardware device key is available", async () => {
    // Hardware-backed key or no hosted session at all: there is no software
    // fallback, because that would reduce DPoP to bare bearer assurance.
    hoisted.createMobileDpopSigner.mockRejectedValue(new Error("no enclave"));

    await expect(configureMobileHostedRuntime()).resolves.toBe(false);
    expect(isMobileHostedModeAvailable()).toBe(false);
  });

  it("resolves ensureMobileHostedSession without bootstrapping when unavailable", async () => {
    hoisted.readMobileHostedConfig.mockReturnValue(null);

    await expect(ensureMobileHostedSession()).resolves.toBeUndefined();
    expect(hoisted.calls).not.toContain("bootstrap");
  });

  it("retries hardware key access after an unavailable session setup", async () => {
    hoisted.createMobileDpopSigner.mockRejectedValueOnce(new Error("locked"));
    await ensureMobileHostedSession();
    expect(isMobileHostedModeAvailable()).toBe(false);
    expect(hoisted.calls).not.toContain("bootstrap");

    await ensureMobileHostedSession();
    expect(isMobileHostedModeAvailable()).toBe(true);
    expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(2);
    expect(hoisted.calls.filter((entry) => entry === "bootstrap")).toHaveLength(1);
  });

  it("keeps a locked saved session retryable without bootstrapping as signed out", async () => {
    hoisted.hydrate.mockRejectedValueOnce(new Error("locked"));
    await ensureMobileHostedSession();
    expect(getMobileHostedUnavailableReason()).toBe("credential-storage");
    expect(hoisted.calls).not.toContain("bootstrap");

    await ensureMobileHostedSession();
    expect(getMobileHostedUnavailableReason()).toBeNull();
    expect(isMobileHostedModeAvailable()).toBe(true);
  });

  it("makes a compatible saved Hub profile authoritative", async () => {
    hoisted.profileRaw = serializeHubProfile(
      createHubProfile({
        origin: "https://self-hosted.ryco.dev",
        compatibility: {
          status: "compatible",
          checkedAt: 1234,
          protocolVersion: 1,
          handoffVersion: 1,
          relyingPartyId: "self-hosted.ryco.dev",
        },
      })!,
    );

    await ensureMobileHostedSession();

    expect(isMobileHostedModeAvailable()).toBe(true);
    expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(1);
    expect(hoisted.calls).toEqual(["hydrate", "trust-hydrate", "configure", "bootstrap"]);
    expect(getHostedRuntimeConfiguration().endpoint.origin()).toBe("https://self-hosted.ryco.dev");
  });

  it("does not send a credential to an unchecked saved Hub", async () => {
    hoisted.profileRaw = serializeHubProfile(
      createHubProfile({ origin: "https://unchecked.ryco.dev" })!,
    );

    await ensureMobileHostedSession();

    expect(isMobileHostedModeAvailable()).toBe(false);
    expect(hoisted.createMobileDpopSigner).not.toHaveBeenCalled();
    expect(hoisted.calls).not.toContain("hydrate");
    expect(hoisted.calls).not.toContain("bootstrap");
  });
});

describe("session bootstrap ordering", () => {
  it("hydrates the bearer token before bootstrap runs", async () => {
    // `readBearerToken()` is synchronous, so a bootstrap that ran first would
    // read null, fail `restoreSession` with a 401, and drop an authenticated
    // user to the bootstrap-availability probe.
    await ensureMobileHostedSession();

    expect(hoisted.calls).toEqual(["hydrate", "trust-hydrate", "configure", "bootstrap"]);
  });

  it("hydrates the §13 trust store before any channel can exist", async () => {
    // docs/relay-e2ee-protocol.md §4.4 requires every latch and pin guard to be
    // evaluable at `channel.accept` from client-anchored state alone, and §13.1.1
    // makes an unread store UNEXPECTED rather than legacy-eligible. The load must
    // therefore precede `configureMobileHostedRuntime`, which is what installs
    // the relay socket factory.
    await ensureMobileHostedSession();

    expect(hoisted.calls.indexOf("trust-hydrate")).toBeGreaterThanOrEqual(0);
    expect(hoisted.calls.indexOf("trust-hydrate")).toBeLessThan(hoisted.calls.indexOf("configure"));
    expect(hoisted.calls.indexOf("trust-hydrate")).toBeLessThan(hoisted.calls.indexOf("bootstrap"));
  });

  it("runs the session bootstrap once across repeated calls", async () => {
    await Promise.all([ensureMobileHostedSession(), ensureMobileHostedSession()]);
    await ensureMobileHostedSession();

    expect(hoisted.calls.filter((entry) => entry === "bootstrap")).toHaveLength(1);
  });
});
