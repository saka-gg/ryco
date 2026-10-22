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
import { createSavedSessionHints } from "../connection/savedSessionHints";
import { mobileKV } from "../platform/kv";
import { initializeWsConnectionState } from "../rpc/wsConnectionState";
import {
  configureMobileHostedConnectionCoordinator,
  resetMobileHostedConnectionCoordinatorForTests,
} from "../connection/hostedConnectionCoordinator";
import { mobileHostedConnectionScopes } from "../connection/hostedConnectionScopes";
import { hostedHubStore, type HostedAccountStatus } from "@ryco/client-runtime/authorization";
import { clearAllProjectIconCaches } from "@ryco/client-runtime/connection";
import { forgetEnvironmentsServerState } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";
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

/** The account session ended; `unavailable` (the Hub could not be reached) is not an ending. */
function isHostedAccountTeardown(status: HostedAccountStatus): boolean {
  return status === "signed-out" || status === "signing-out" || status === "session-expired";
}

/**
 * Hosted sessions may still belong to the account: it is signed in, or its
 * sign-out has not reached the controller's release of every session yet.
 *
 * While the Hub answers a sign-out, the account's relay channels stay open and
 * keep admitting what their sessions admit: the account is still signed in
 * until then, and a sign-out that another sign-in replaced never ends it. The
 * controller releases every session in the same update that ends the account,
 * whether the Hub's answer succeeded or failed, so no channel outlives it.
 */
function holdsHostedSessions(status: HostedAccountStatus): boolean {
  return status === "authenticated" || status === "signing-out";
}

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
    sessionHints: createSavedSessionHints(mobileKV),
    // The driver starts at the direct stage; the hosted primary waits for the
    // cached roster and projections, as it did before the stages were split.
    admitPrimaryConnection: () => mobileRuntimeStartupBarrier.isHydrated(),
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
    // projections) before the hosted lifecycle can attempt a connection.
    // Catalog hydration must land first or the orphan check would misread
    // direct environments; it is also all the direct supervisor needs, so its
    // network pre-flight overlaps the SQLite open and decode (live data wins
    // the race in the threads store; see `startupBarrier`).
    void mobileRuntimeStartupBarrier.beginHydration(
      async ({ markDirectReady }) => {
        const modules = Promise.all([
          import("../platform/kv"),
          import("../platform/appLifecycle"),
          import("../persistence/environmentSnapshotPersistence"),
        ]);
        // Awaited below; a catalog failure first must not leave it unhandled.
        modules.catch(() => undefined);
        await registry.catalog.waitForHydration();
        markDirectReady();
        const [{ mobileKV }, { mobileAppLifecycle }, { initializeMobileSnapshotPersistence }] =
          await modules;
        await initializeMobileSnapshotPersistence({
          kv: mobileKV,
          hasDirectEnvironment: (environmentId) => registry.catalog.get(environmentId) !== null,
          // Debounced snapshot captures are flushed before iOS may suspend us.
          subscribeBackground: (listener) =>
            mobileAppLifecycle.subscribe((event) => {
              if (event === "background") listener();
            }),
        });
      },
      (error: unknown) => {
        console.warn("[snapshot-cache] cold-start hydration failed", error);
      },
    );
    // Mobile's hosted connections run on the shared session registry and demand
    // executor; the hosted controller connects and releases every environment.
    const hostedCoordinator = configureMobileHostedConnectionCoordinator({
      scopes: mobileHostedConnectionScopes,
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      nodeForId: (nodeId) =>
        hostedHubStore.getState().nodes.find((node) => node.id === nodeId) ?? null,
      isDirectEnvironment: (environmentId) => registry.catalog.get(environmentId) !== null,
    });
    let previousHostedState = hostedHubStore.getState();
    let artworkAccountId = previousHostedState.account?.id ?? null;
    // Every Hub node the account listed, so what they reported (capabilities,
    // auto-settle rules) leaves memory with the account. Direct environments stay.
    const accountEnvironmentIds = new Set<EnvironmentId>(
      previousHostedState.nodes.map((node) => node.environmentId),
    );
    stopHostedAccountWatch = hostedHubStore.subscribe(() => {
      const currentHostedState = hostedHubStore.getState();
      if (
        holdsHostedSessions(previousHostedState.accountStatus) &&
        !holdsHostedSessions(currentHostedState.accountStatus)
      ) {
        // The controller's own sign-out and expiry release every session in
        // the update that ends the account, without handing one account's node
        // state to the next. Whatever outlived the account any other way is
        // released after that.
        void Promise.resolve().then(() => hostedCoordinator.releaseAll());
      }
      // Project artwork and what each Hub node reported are keyed by node and
      // outlive a connection, not an account: they are dropped when the account
      // session ends (sign-out, expiry, a Hub domain change) or another account
      // signs in, never on an access check that only could not reach the Hub.
      const currentAccountId = currentHostedState.account?.id ?? null;
      if (
        (isHostedAccountTeardown(currentHostedState.accountStatus) &&
          !isHostedAccountTeardown(previousHostedState.accountStatus)) ||
        (currentAccountId !== null &&
          artworkAccountId !== null &&
          currentAccountId !== artworkAccountId)
      ) {
        clearAllProjectIconCaches();
        forgetEnvironmentsServerState(
          [...accountEnvironmentIds].filter(
            (environmentId) => registry.catalog.get(environmentId) === null,
          ),
        );
        accountEnvironmentIds.clear();
      }
      for (const node of currentHostedState.nodes) accountEnvironmentIds.add(node.environmentId);
      if (currentAccountId !== null) artworkAccountId = currentAccountId;
      previousHostedState = currentHostedState;
    });
    mobileRuntimeStartupBarrier.runAfterDirectReady(
      () => {
        stopEnvironmentDriver = registry.driver.start();
      },
      (error: unknown) => {
        console.warn("[connection] mobile runtime startup failed", error);
      },
    );
    mobileRuntimeStartupBarrier.runAfterHydration(
      () => registry.driver.releaseDeferredPrimaryConnection(),
      (error: unknown) => {
        console.warn("[connection] hosted primary startup failed", error);
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
  stopHostedAccountWatch?.();
  stopHostedAccountWatch = null;
  mobileHostedConnectionScopes.reset();
  resetMobileHostedConnectionCoordinatorForTests();
}
