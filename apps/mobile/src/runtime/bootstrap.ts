import type { KVService, SecretKVService } from "@ryco/client-runtime/platform";

// Importing the threads-runtime module registers its lazy configurator (a stored
// callback — no timers/sockets), the sanctioned registration pattern.
import "../state/threadsRuntime";
import { createMobileSavedEnvironmentCatalog } from "../connection/catalog";
import {
  createMobileEnvironmentDriver,
  type MobileEnvironmentDriver,
} from "../connection/environmentDriver";
import { createMobileRemoteEnvironmentApi } from "../connection/remoteApi";
import { initializeWsConnectionState } from "../rpc/wsConnectionState";
import {
  configureMobileHostedConnectionCoordinator,
  resetMobileHostedConnectionCoordinatorForTests,
} from "../connection/hostedConnectionCoordinator";
import {
  mobileHostedConnectionScopes,
  recordMobileHostedScopeLeaseReport,
} from "../connection/hostedConnectionScopes";
import { hostedHubController, hostedHubStore } from "@ryco/client-runtime/authorization";
import { demoteMobileHostedEnvironmentState } from "../hostedHub/nodeStateCleanup";
import { useStore } from "../state/threadsRuntime";
import { mobileRuntimeStartupBarrier } from "./startupBarrier";

type Catalog = ReturnType<typeof createMobileSavedEnvironmentCatalog>;
type RemoteApi = ReturnType<typeof createMobileRemoteEnvironmentApi>;

export interface MobileConnectionRegistry {
  readonly catalog: Catalog;
  readonly remoteApi: RemoteApi;
  readonly driver: MobileEnvironmentDriver;
}

// Single-homed app singletons: the PairingScreen (which persists the paired
// environment) and the supervisor (which reads it and connects) share ONE
// catalog/remoteApi/driver. Built lazily — no import-time side effects.
let appCatalog: Catalog | null = null;
let appRemoteApi: RemoteApi | null = null;
let appDriver: MobileEnvironmentDriver | null = null;

function getAppCatalog(): Catalog {
  return (appCatalog ??= createMobileSavedEnvironmentCatalog());
}
function getAppRemoteApi(): RemoteApi {
  return (appRemoteApi ??= createMobileRemoteEnvironmentApi());
}
function getAppDriver(): MobileEnvironmentDriver {
  return (appDriver ??= createMobileEnvironmentDriver({
    catalog: getAppCatalog(),
    remoteApi: getAppRemoteApi(),
  }));
}

/**
 * The connection registry: the saved-environment catalog (env registry + bearer
 * tokens in SecretKV), the direct-node bearer API (the pairing engine), and the
 * environment-connection driver (the supervisor that opens the live socket and
 * syncs the node stream into state/threads). The app uses the single-homed
 * singletons; a headless test passes `overrides` to build an isolated registry
 * with fake adapters.
 */
export function createMobileConnectionRegistry(overrides?: {
  readonly kv?: Pick<KVService, "getItem" | "setItem">;
  readonly secretKV?: SecretKVService;
  readonly remoteApi?: RemoteApi;
  readonly subscribeResume?: (listener: (reason: string) => void) => () => void;
}): MobileConnectionRegistry {
  if (!overrides) {
    return { catalog: getAppCatalog(), remoteApi: getAppRemoteApi(), driver: getAppDriver() };
  }
  const catalog = createMobileSavedEnvironmentCatalog({
    ...(overrides.kv ? { kv: overrides.kv } : {}),
    ...(overrides.secretKV ? { secretKV: overrides.secretKV } : {}),
  });
  const remoteApi = overrides.remoteApi ?? createMobileRemoteEnvironmentApi();
  const driver = createMobileEnvironmentDriver({
    catalog,
    remoteApi,
    ...(overrides.subscribeResume ? { subscribeResume: overrides.subscribeResume } : {}),
  });
  return { catalog, remoteApi, driver };
}

let initialized = false;
let stopEnvironmentDriver: (() => void) | null = null;
let stopHostedScopeReporter: (() => void) | null = null;
let stopHostedAccountWatch: (() => void) | null = null;

/**
 * One-time runtime initialization run from the app root. Seeds the ws
 * online-status atom from AppLifecycle and starts the environment-connection
 * driver (which subscribes the saved-environment registry, so a newly paired
 * environment auto-connects, and wires AppState resume/reconnect). Idempotent.
 */
export function initializeMobileRuntime(): MobileConnectionRegistry {
  const registry = createMobileConnectionRegistry();
  if (!initialized) {
    initialized = true;
    initializeWsConnectionState();
    // Wave 2: hydrate the snapshot cache (cached node roster + per-environment
    // projections) before either the direct supervisor or hosted lifecycle can
    // attempt a connection. Catalog hydration must land first or the orphan
    // check would misread direct environments.
    void mobileRuntimeStartupBarrier.beginHydration(
      async () => {
        const { mobileKV } = await import("../platform/kv");
        const { initializeMobileSnapshotPersistence } =
          await import("../persistence/environmentSnapshotPersistence");
        await registry.catalog.waitForHydration();
        await initializeMobileSnapshotPersistence({
          kv: mobileKV,
          hasDirectEnvironment: (environmentId) => registry.catalog.get(environmentId) !== null,
        });
      },
      (error: unknown) => {
        console.warn("[snapshot-cache] cold-start hydration failed", error);
      },
    );
    const hostedCoordinator = configureMobileHostedConnectionCoordinator({
      scopes: mobileHostedConnectionScopes,
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      nodeForId: (nodeId) =>
        hostedHubStore.getState().nodes.find((node) => node.id === nodeId) ?? null,
      selectedEnvironmentId: () => hostedHubStore.getState().selectedNode?.environmentId ?? null,
      selectNode: (nodeId) => hostedHubController.selectNode(nodeId),
      connectSelectedEnvironment: () => {
        registry.driver.supervisor.connectPrimary();
      },
      markSelectedDeliveryUnknown: () =>
        hostedHubController.markDeliveryUnknown(hostedHubStore.getState().generation),
      listConnections: () => registry.driver.supervisor.list(),
      readConnection: (environmentId) => registry.driver.supervisor.read(environmentId),
      removeConnection: (environmentId) => registry.driver.supervisor.remove(environmentId),
      demoteEnvironment: demoteMobileHostedEnvironmentState,
      restoreActiveEnvironment: (environmentId) =>
        useStore.getState().setActiveEnvironmentId(environmentId),
    });
    // A local lease report uses the same 25s/45s cadence as the reference
    // design. Connection ownership consumes the live refcounts immediately;
    // the periodic report is the bounded observability/TTL contract and never
    // carries payload content or high-cardinality logs.
    stopHostedScopeReporter = mobileHostedConnectionScopes.startReporter({
      report: recordMobileHostedScopeLeaseReport,
    });
    let previousHostedState = hostedHubStore.getState();
    stopHostedAccountWatch = hostedHubStore.subscribe(() => {
      const currentHostedState = hostedHubStore.getState();
      if (
        previousHostedState.accountStatus === "authenticated" &&
        currentHostedState.accountStatus !== "authenticated"
      ) {
        void hostedCoordinator.releaseAll();
      }
      if (
        previousHostedState.sessionStatus === "delivery-unknown" &&
        currentHostedState.sessionStatus === "ready" &&
        currentHostedState.selectedNode !== null
      ) {
        hostedCoordinator.acknowledgeDeliveryUnknown(currentHostedState.selectedNode.environmentId);
      }
      previousHostedState = currentHostedState;
    });
    mobileRuntimeStartupBarrier.runAfterHydration(
      () => {
        stopEnvironmentDriver = registry.driver.start();
      },
      (error: unknown) => {
        console.warn("[connection] mobile runtime startup failed", error);
      },
    );
  }
  return registry;
}

/** Test seam: drop the app singletons and init flag. */
export function resetMobileRuntimeInitForTests(): void {
  initialized = false;
  mobileRuntimeStartupBarrier.reset();
  stopEnvironmentDriver?.();
  stopEnvironmentDriver = null;
  appCatalog = null;
  appRemoteApi = null;
  appDriver = null;
  stopHostedScopeReporter?.();
  stopHostedScopeReporter = null;
  stopHostedAccountWatch?.();
  stopHostedAccountWatch = null;
  mobileHostedConnectionScopes.reset();
  resetMobileHostedConnectionCoordinatorForTests();
}
