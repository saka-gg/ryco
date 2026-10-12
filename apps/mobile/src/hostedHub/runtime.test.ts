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
  bearerToken: "token" as string | null,
  profileRaw: null as string | null,
  trustRevision: 0,
  trustListeners: new Set<() => void>(),
  prepareCalls: 0,
  disposeCalls: 0,
  resetSessionCalls: 0,
  primaryConnection: { kind: "primary" },
  createHostedPrimaryConnection: vi.fn(),
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
// The relay connection itself is covered in primaryConnection.test.ts; here only
// its installation on the driver's seam matters.
vi.mock("./primaryConnection", () => ({
  createHostedPrimaryConnection: hoisted.createHostedPrimaryConnection,
}));
vi.mock("./e2eeSession", () => ({
  getMobileE2eeSessionState: () => ({ event: null }),
  resetMobileE2eeSession: () => {
    hoisted.resetSessionCalls += 1;
  },
  subscribeMobileE2eeSession: () => () => undefined,
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
    readBearerToken: () => hoisted.bearerToken,
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

vi.mock("@ryco/client-runtime/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/authorization")>();
  return {
    ...actual,
    // Installing the runtime (and with it the relay socket factory) is where a
    // channel first becomes possible, so that is what the ordering marker records.
    configureHostedRuntime: vi.fn((...args: Parameters<typeof actual.configureHostedRuntime>) => {
      hoisted.calls.push("configure");
      return actual.configureHostedRuntime(...args);
    }),
  };
});
vi.mock("@ryco/client-runtime/authorization/e2ee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/authorization/e2ee")>();
  return {
    ...actual,
    createNativeE2eeEnrollmentCoordinator: vi.fn(actual.createNativeE2eeEnrollmentCoordinator),
  };
});

import {
  getHostedRuntimeConfiguration,
  hostedHubController,
  hostedHubStore,
} from "@ryco/client-runtime/authorization";
import { createNativeE2eeEnrollmentCoordinator } from "@ryco/client-runtime/authorization/e2ee";

import {
  configureMobileHostedRuntime,
  ensureMobileHostedDeviceKey,
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
import { createHostedPrimaryConnectionIfLoaded } from "./primaryConnectionFactory";

const HOSTED_CONFIG = {
  hubOrigin: "https://hub.example.test",
  appUrl: "https://app.ryco.space/",
  relyingParty: "app.ryco.space",
};

const signer = { sign: async () => "proof" };

/** The ordering markers, without the signer creation that overlaps them. */
function orderedCalls(): string[] {
  return hoisted.calls.filter((entry) => entry !== "signer");
}

beforeEach(() => {
  resetMobileHubProfileCacheForTests();
  resetMobileHostedRuntimeForTests();
  resetMobileHostedRuntimeConfigForTests();
  hoisted.calls.length = 0;
  hoisted.bearerToken = "token";
  hoisted.profileRaw = null;
  hoisted.trustRevision = 0;
  hoisted.trustListeners.clear();
  hoisted.prepareCalls = 0;
  hoisted.disposeCalls = 0;
  hoisted.resetSessionCalls = 0;
  vi.clearAllMocks();
  hoisted.hydrate.mockResolvedValue(undefined);
  hoisted.readMobileHostedConfig.mockReturnValue(HOSTED_CONFIG);
  // Signer creation overlaps the keychain reads, so it is recorded separately
  // and left out of the ordering assertions below.
  hoisted.createMobileDpopSigner.mockImplementation(async () => {
    hoisted.calls.push("signer");
    return signer;
  });
  vi.spyOn(hostedHubController, "bootstrap").mockImplementation(async () => {
    hoisted.calls.push("bootstrap");
  });
});

describe("hosted runtime configuration", () => {
  it("supplies every field the runtime contract requires", async () => {
    await expect(configureMobileHostedRuntime()).resolves.toBe(true);

    expect(createNativeE2eeEnrollmentCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedMaximumRole: "owner",
        requestedCapabilities: ["ryco.rpc"],
      }),
    );
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

  it("hands enrollment recovery to the shared coordinator on the runtime's own lifecycle", async () => {
    await configureMobileHostedRuntime();
    const { timers, subscribeForeground } = getHostedRuntimeConfiguration();

    // One retry policy, in client-runtime: this app supplies the same bound
    // timers and once-per-transition foreground signal the runtime uses.
    expect(createNativeE2eeEnrollmentCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({ timers, subscribeForeground }),
      }),
    );
  });

  it("installs the relay connection on the driver's seam as soon as it loads", () => {
    // The driver is on the launch path and never imports the relay connection;
    // this lazily loaded module installs it before any session can exist.
    hoisted.createHostedPrimaryConnection.mockReturnValue(hoisted.primaryConnection);
    const deps = {} as Parameters<typeof createHostedPrimaryConnectionIfLoaded>[0];

    expect(createHostedPrimaryConnectionIfLoaded(deps)).toBe(hoisted.primaryConnection);
    expect(hoisted.createHostedPrimaryConnection).toHaveBeenCalledWith(deps);
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

  it("drops an account left waiting on the previous Hub when the profile changes", async () => {
    await configureMobileHostedRuntime();
    const clearAccount = vi.spyOn(hostedHubController, "clearAccount");
    hostedHubStore.setState({ accountStatus: "unavailable", account: null } as never);

    invalidateMobileHostedRuntime();

    // Its access retry would otherwise bootstrap through the previous Hub's API.
    expect(clearAccount).toHaveBeenCalledWith("signed-out");
    expect(hostedHubStore.getState().accountStatus).toBe("signed-out");
  });

  it("leaves an authenticated account to the profile-change flow", async () => {
    await configureMobileHostedRuntime();
    const clearAccount = vi.spyOn(hostedHubController, "clearAccount").mockResolvedValue();
    hostedHubStore.setState({ accountStatus: "authenticated" } as never);

    invalidateMobileHostedRuntime();

    expect(clearAccount).not.toHaveBeenCalled();
  });

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
    expect(orderedCalls()).toEqual(["hydrate", "trust-hydrate", "configure", "bootstrap"]);
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

    expect(orderedCalls()).toEqual(["hydrate", "trust-hydrate", "configure", "bootstrap"]);
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

  it("loads the hardware key for a stored session before configuration completes", async () => {
    let releaseSigner: () => void = () => undefined;
    hoisted.createMobileDpopSigner.mockImplementationOnce(async () => {
      hoisted.calls.push("signer");
      await new Promise<void>((resolve) => (releaseSigner = resolve));
      return signer;
    });
    const session = ensureMobileHostedSession();
    await vi.waitFor(() => expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(1));

    // The stored token was found, so the key load started; configuration and
    // the access check wait for it, because restoring the session signs.
    expect(hoisted.calls).not.toContain("configure");

    releaseSigner();
    await session;
    expect(orderedCalls()).toEqual(["hydrate", "trust-hydrate", "configure", "bootstrap"]);
    expect(getHostedRuntimeConfiguration().dpopSigner).toBe(signer);
    expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(1);
  });

  it("overlaps the stored session's key load with the trust read", async () => {
    let trustHydrated = false;
    let signerStartedBeforeTrust = false;
    const { mobileE2eeTrustStore } = await import("../platform/e2eeTrustStore");
    const hydrateTrust = vi
      .spyOn(mobileE2eeTrustStore, "hydrate")
      .mockImplementationOnce(async () => {
        await vi.waitFor(() => expect(hoisted.createMobileDpopSigner).toHaveBeenCalled());
        signerStartedBeforeTrust = !trustHydrated;
        trustHydrated = true;
      });

    await ensureMobileHostedSession();

    expect(hydrateTrust).toHaveBeenCalledTimes(1);
    expect(signerStartedBeforeTrust).toBe(true);
    expect(isMobileHostedModeAvailable()).toBe(true);
  });

  it("does not run the Hub access check when no session is stored", async () => {
    // Nothing to restore: the check would fail locally on the missing token and
    // then spend a proof and a Hub round trip on the availability probe.
    hoisted.bearerToken = null;
    const bootstrap = vi.spyOn(hostedHubController, "bootstrap");

    await ensureMobileHostedSession();

    expect(isMobileHostedModeAvailable()).toBe(true);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(orderedCalls()).toEqual(["hydrate", "trust-hydrate", "configure"]);
    expect(hostedHubStore.getState().accountStatus).toBe("signed-out");
  });
  it("runs the session bootstrap once across repeated calls", async () => {
    await Promise.all([ensureMobileHostedSession(), ensureMobileHostedSession()]);
    await ensureMobileHostedSession();

    expect(hoisted.calls.filter((entry) => entry === "bootstrap")).toHaveLength(1);
  });
});

describe("deferred hardware key", () => {
  beforeEach(() => {
    hoisted.bearerToken = null;
  });

  it("does not load the hardware key at launch when no session is stored", async () => {
    await ensureMobileHostedSession();

    // Nothing signs without a stored session, so the Secure Enclave round trip
    // is left to first hosted use.
    expect(hoisted.createMobileDpopSigner).not.toHaveBeenCalled();
    expect(hoisted.calls).toContain("configure");
    expect(isMobileHostedModeAvailable()).toBe(true);
  });

  it("loads the key on the first proof and signs with the hardware signer", async () => {
    await ensureMobileHostedSession();
    const dpopSigner = getHostedRuntimeConfiguration().dpopSigner!;

    await expect(
      dpopSigner.sign({ method: "GET", url: "https://hub.example.test/x" } as never),
    ).resolves.toBe("proof");
    await dpopSigner.sign({ method: "GET", url: "https://hub.example.test/y" } as never);

    expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(2);
    expect(isMobileHostedModeAvailable()).toBe(true);
  });

  it("fails the proof closed and reports device security when no hardware key exists", async () => {
    await ensureMobileHostedSession();
    hoisted.createMobileDpopSigner.mockRejectedValueOnce(new Error("no enclave"));

    await expect(
      getHostedRuntimeConfiguration().dpopSigner!.sign({
        method: "POST",
        url: "https://hub.example.test/x",
      } as never),
    ).rejects.toThrow("no enclave");

    expect(isMobileHostedModeAvailable()).toBe(false);
    expect(getMobileHostedUnavailableReason()).toBe("device-security");
  });

  it("settles availability when a hosted surface asks for the key", async () => {
    hoisted.createMobileDpopSigner.mockRejectedValueOnce(new Error("locked"));

    await expect(ensureMobileHostedDeviceKey()).resolves.toBe(false);
    expect(getMobileHostedUnavailableReason()).toBe("device-security");
    expect(hoisted.calls).not.toContain("bootstrap");

    // A failed load is not memoized: the next surface retries it.
    await expect(ensureMobileHostedDeviceKey()).resolves.toBe(true);
    expect(isMobileHostedModeAvailable()).toBe(true);
    expect(getMobileHostedUnavailableReason()).toBeNull();
    expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable without loading a key when hosted mode is unconfigured", async () => {
    hoisted.readMobileHostedConfig.mockReturnValue(null);

    await expect(ensureMobileHostedDeviceKey()).resolves.toBe(false);
    expect(hoisted.createMobileDpopSigner).not.toHaveBeenCalled();
  });

  it("does not publish availability for a runtime invalidated while the key loads", async () => {
    await ensureMobileHostedSession();
    let releaseSigner: () => void = () => undefined;
    hoisted.createMobileDpopSigner.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (releaseSigner = resolve));
      return signer;
    });
    const probe = ensureMobileHostedDeviceKey();
    await vi.waitFor(() => expect(hoisted.createMobileDpopSigner).toHaveBeenCalledTimes(1));

    invalidateMobileHostedRuntime();
    releaseSigner();
    await probe;

    expect(isMobileHostedModeAvailable()).toBe(false);
  });
});
