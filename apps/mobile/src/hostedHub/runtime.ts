import {
  configureHostedEnvironmentSessions,
  configureHostedRuntime,
  getHostedEnvironmentSessions,
  getHostedHubApi,
  hostedHubController,
  hostedHubStore,
  type HostedEnvironmentSessionRecord,
  type HostedEnvironmentSessions,
} from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";
import {
  createNativeE2eeEnrollmentCoordinator,
  type NativeE2eeEnrollmentCoordinator,
} from "@ryco/client-runtime/authorization/e2ee";
import {
  hasHostedRelayPendingRequests,
  resetHostedRelayAttemptFactory,
} from "@ryco/client-runtime/relay";

import type { DpopSignerService } from "@ryco/client-runtime/platform";

import { mobileAppLifecycle } from "../platform/appLifecycle";
import { createMobileDpopSigner } from "../platform/dpopSigner";
import { isE2eePairingRecord } from "../platform/e2eeTrustModel";
import { mobileE2eeTrustStore } from "../platform/e2eeTrustStore";
import { mobileKV } from "../platform/kv";
import { mobileNativeAuthorization } from "../platform/nativeAuthorization";
import { mobileNativeE2eePlatform } from "../platform/nativeE2ee";
import { mobilePasskeyCeremony } from "../platform/passkeyCeremony";
import { readMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import {
  hydrateMobileHostedSessionToken,
  mobileSessionCredentials,
} from "../platform/sessionCredentials";
import {
  disposeMobileRelayE2eeAttempt,
  disposeMobileRelayE2eeAttemptFor,
  prepareMobileRelayE2eeAttempt,
  type MobileE2eeAttemptTarget,
} from "./e2eeAttempt";
import {
  getMobileE2eeSessionState,
  resetMobileE2eeSession,
  subscribeMobileE2eeSession,
} from "./e2eeSession";
import { setMobileNativeE2eeEnrollmentCoordinator } from "./e2eeEnrollment";
import { hydrateMobileHubProfile } from "./hubProfile";
import { mobileHostedNodeLifecycle } from "./nodeLifecycle";
import {
  disposeMobileRelaySocketContext,
  providerForMobileRelaySocketContext,
} from "./accountE2eeAttempt";
import { createHostedEnvironmentConnection } from "./primaryConnection";
import { installHostedEnvironmentConnectionFactory } from "./primaryConnectionFactory";
import { configureAuthoritativeNodeTrustSource } from "../features/home/authoritativeNodeTrustSource";
import { MobileHostedRelaySocket, mobileHostedRelayUrl } from "./relaySocket";
import {
  getMobileHostedEndpoint,
  getMobileHostedHttpClient,
  invalidateMobileHostedRuntimeConfig,
  isMobileHostedModeConfigured,
} from "./runtimeConfig";
import {
  isMobileHostedModeAvailable,
  setMobileHostedModeAvailable,
  subscribeMobileHostedModeAvailability,
} from "./runtimeAvailability";

configureAuthoritativeNodeTrustSource({
  hubOrigin: () => getMobileHostedEndpoint()?.origin() ?? null,
  classify: (selection) => mobileE2eeTrustStore.classify(selection),
  pairing: (selection) => isE2eePairingRecord(mobileE2eeTrustStore.resolve(selection)),
  identityChanged: (environmentId) =>
    getMobileE2eeSessionState(environmentId).event?.kind === "identity-change",
  subscribe: (listener) => {
    const unsubscribeTrust = mobileE2eeTrustStore.subscribe(listener);
    const unsubscribeSession = subscribeMobileE2eeSession(listener);
    return () => {
      unsubscribeTrust();
      unsubscribeSession();
    };
  },
});

// The connection code on the launch path reaches the relay connection only
// through this seam. It is installed when this module loads, before the Hub API
// is configured, so no session can be restored and no node connected without
// it. Every hosted environment connects through the controller's
// `acquireEnvironment` and the node lifecycle's `connectEnvironment` port; the
// driver's single primary connection is never installed.
installHostedEnvironmentConnectionFactory(createHostedEnvironmentConnection);

/**
 * Hosted runtime wiring.
 *
 * Fails closed at every step: with no hosted config, or with no hardware device
 * key, hosted surfaces report unavailable and no proof is ever minted.
 * Configuring without a DPoP signer would throw inside `HostedHubApi`'s
 * constructor at bootstrap, so a signer is always supplied to
 * `configureHostedRuntime`. When a stored session must be restored, it is the
 * resolved hardware signer, loaded before configuration. With no stored session
 * nothing signs at launch, so the hardware key load (a Secure Enclave/keystore
 * round trip plus two native modules) is deferred to first hosted use: the
 * runtime is configured with {@link deferredDpopSigner}, and the first hosted
 * surface or proof decides availability through {@link ensureMobileHostedDeviceKey}.
 */

let configured = false;
let session: Promise<void> | undefined;
let selectionWatch: (() => void) | undefined;
let enrollmentCoordinator: NativeE2eeEnrollmentCoordinator | null = null;

export { isMobileHostedModeAvailable, subscribeMobileHostedModeAvailability };

/**
 * Bound timer wrappers. Unbound platform methods throw "Illegal invocation"
 * under React Native, and Hermes builds do not all ship `queueMicrotask`.
 */
const timers = {
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
  queueMicrotask: (callback: () => void): void => {
    if (typeof globalThis.queueMicrotask === "function") globalThis.queueMicrotask(callback);
    else void Promise.resolve().then(callback);
  },
};

/**
 * Subscribe to the next foreground transition, once.
 *
 * `mobileAppLifecycle` emits both "foreground" and "resume" per transition, so
 * this de-duplicates; the runtime's `{once: true}` semantics drive resumption
 * of the 20s directory poll.
 */
function subscribeForeground(listener: () => void): () => void {
  let fired = false;
  const unsubscribe = mobileAppLifecycle.subscribe((event) => {
    if (fired || event !== "foreground") return;
    fired = true;
    listener();
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
  };
}

/**
 * Resolve the hardware signer and publish what it proves about availability.
 *
 * Only a configured runtime publishes: a profile change that invalidated the
 * runtime while the key was loading owns availability from then on. A failed
 * load is not memoized (`createMobileDpopSigner`), so the next hosted surface
 * or proof retries it, for example after the user unlocks the device.
 */
async function resolveHostedDpopSigner(): Promise<DpopSignerService> {
  try {
    const signer = await createMobileDpopSigner();
    if (configured) setMobileHostedModeAvailable(true);
    return signer;
  } catch (cause) {
    if (configured) setMobileHostedModeAvailable(false, "device-security");
    throw cause;
  }
}

/**
 * The signer a runtime configured without a stored session holds.
 *
 * It loads the hardware key on its first proof, which is a sign-in ceremony or
 * another explicit hosted action, and never falls back to a software key: a
 * missing key rejects the proof and the request fails closed.
 */
const deferredDpopSigner: DpopSignerService = {
  sign: async (input) => (await resolveHostedDpopSigner()).sign(input),
};

/**
 * First hosted use: settle the session setup, then make sure the hardware key
 * is loaded and availability reflects it. Hosted surfaces call this on mount, so
 * a device without a usable key stops offering hosted affordances before the
 * user starts a ceremony. Resolves false when hosted mode is unavailable; never
 * rejects.
 */
export async function ensureMobileHostedDeviceKey(): Promise<boolean> {
  await ensureMobileHostedSession();
  if (!configured) return false;
  try {
    await resolveHostedDpopSigner();
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent. Returns false when hosted mode cannot be configured, which is the
 * normal state for a direct-only build.
 */
export async function configureMobileHostedRuntime(
  /**
   * A signer creation the caller already started; joined rather than repeated.
   * `"deferred"` configures with {@link deferredDpopSigner} instead, leaving the
   * hardware key unloaded until first hosted use.
   */
  signerAttempt?: Promise<DpopSignerService> | "deferred",
): Promise<boolean> {
  if (configured) return isMobileHostedModeAvailable();
  if (!isMobileHostedModeConfigured()) return false;
  const endpoint = getMobileHostedEndpoint();
  const httpClient = getMobileHostedHttpClient();
  if (!endpoint || !httpClient) return false;

  let dpopSigner: DpopSignerService;
  if (signerAttempt === "deferred") {
    dpopSigner = deferredDpopSigner;
  } else {
    try {
      // Hardware-backed key or no hosted session at all. There is deliberately no
      // software fallback: it would reduce DPoP to bare bearer assurance.
      dpopSigner = await (signerAttempt ?? createMobileDpopSigner());
    } catch {
      setMobileHostedModeAvailable(false, "device-security");
      return false;
    }
    if (configured) return isMobileHostedModeAvailable();
  }

  // The session registry keeps its deadlines on the same bound timers.
  configureHostedEnvironmentSessions({
    now: timers.now,
    setTimeout: (callback, delayMs) => timers.setTimeout(callback, delayMs),
    clearTimeout: (timer) => timers.clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  configureHostedRuntime({
    endpoint,
    httpClient,
    passkeyCeremony: mobilePasskeyCeremony,
    sessionCredentials: mobileSessionCredentials,
    dpopSigner,
    nativeAuthorization: mobileNativeAuthorization,
    // One session per environment: selection is a cursor, and the demand
    // executor connects environments through the controller.
    environmentSessions: "retained",
    nodeLifecycle: mobileHostedNodeLifecycle,
    timers,
    isForeground: () => mobileAppLifecycle.isForeground(),
    subscribeForeground,
    hasPendingRelayRequests: hasHostedRelayPendingRequests,
    // No account subscription here, and every directory read is device-key
    // signed: poll quickly only while a screen shows node presence.
    demandDrivenDirectoryRefresh: true,
    resetRelayAttemptFactory: resetHostedRelayAttemptFactory,
    relayUrl: mobileHostedRelayUrl,
    // Each environment's relay binding prepares its E2EE context and issues its
    // ticket for its own node and record generation
    // (`createHostedEnvironmentConnection`), so the runtime offers no
    // selection-following preparation to fall back on. Every channel's socket
    // is built here.
    //
    // docs/relay-e2ee-protocol.md §4: THIS IS WHERE NATIVE E2EE IS ON.
    //
    // Every relay channel this app opens is built with the §4.4 mode machine,
    // and the guards it consults were resolved before this call — §4.4 requires
    // them "before it has received any payload", and this call is synchronous.
    // A socket whose prepared context carries no provider fails closed here.
    // Issuing, renewing, or replacing an invalid certificate may transiently
    // derive or generate the agreement public key and keeps that existing
    // failure rule. On the common valid-certificate restore path, preparation is
    // public-only; the first scalar access is K1 after validated evidence, where
    // failure is FATAL-PRE and can no longer authorize plaintext.
    createRelaySocket: (input) =>
      new MobileHostedRelaySocket({
        ...input,
        e2ee: providerForMobileRelaySocketContext(input.preparedSocketContext),
        disposePreparedContext: () => disposeMobileRelaySocketContext(input.preparedSocketContext),
      }),
  });
  enrollmentCoordinator = createNativeE2eeEnrollmentCoordinator({
    platform: mobileNativeE2eePlatform,
    api: getHostedHubApi(),
    hubOrigin: endpoint.origin(),
    // The Hub intersects this ceiling with the account's current node role.
    // Owners need settings RPCs; operator/viewer accounts retain their granted limits.
    requestedMaximumRole: "owner",
    requestedCapabilities: ["ryco.rpc"],
    refreshDirectory: () => hostedHubController.refreshDirectory(),
    // The coordinator owns the retry policy; this app supplies only the
    // lifecycle it runs on. Sign-out and account changes cancel it through
    // `invalidate`/`ensure` in the selection watcher below.
    recovery: {
      timers,
      isForeground: () => mobileAppLifecycle.isForeground(),
      subscribeForeground,
    },
    invalidateHostedGeneration: () => {
      disposeMobileRelayE2eeAttempt();
      resetMobileE2eeSession();
      // Every environment session loses its authority before this returns; the
      // connections are torn down after it.
      hostedHubController.invalidateNativeE2eeAuthorization();
      // Runtime bootstrap can invalidate before the connection coordinator exists.
      void readMobileHostedConnectionCoordinator()?.releaseAll();
    },
  });
  setMobileNativeE2eeEnrollmentCoordinator(enrollmentCoordinator);
  configured = true;
  setMobileHostedModeAvailable(true);
  watchSelectionForE2ee();
  return true;
}

/**
 * Keep the §4.4 attempt warm for every environment with a connection requested,
 * and for whatever the owner has since decided about it.
 *
 * The relay transport creates its socket the instant a ticket resolves, and
 * resolving an attempt reads the public certificate, identity, and trust stores.
 * A valid reusable certificate restores without opening the agreement scalar;
 * issuance or renewal may transiently derive or generate its public half. No
 * warm attempt retains the scalar: the handshake still borrows it for one K1
 * operation. Priming on every
 * change of the `(account, node, generation)` triple is what makes the
 * synchronous read at `createRelaySocket` find a complete attempt rather than
 * fail the channel closed — and the failure IS closed, never a silent fallback,
 * so a miss costs one channel rather than the guarantee.
 *
 * THE TRUST DOCUMENT IS THE SECOND INPUT, and it is the one the selection cannot
 * stand in for. §13.2 step 5's promotion, §13.3's re-pair and §12.1.1's consent
 * change the pin, the latch, the class and the marker without touching the
 * account or the node, so the store's own revision is subscribed to as well. The
 * attempt slot is keyed on it too, so a decision that lands between this
 * notification and the re-preparation completing still cannot be used.
 *
 * The selection is only a cursor over retained environment sessions, so the
 * environment records are watched: see {@link watchEnvironmentSessionsForE2ee}.
 */
function watchSelectionForE2ee(): void {
  if (selectionWatch !== undefined) return;
  selectionWatch = watchEnvironmentSessionsForE2ee();
}

/**
 * Retained environment sessions: every environment keeps its own attempt and
 * projection, whatever is selected.
 *
 * Each record that is not suspended and has a connection requested is primed
 * for its own node and record generation, so a warm environment that reconnects
 * while another node is selected — or while none is — finds a complete attempt
 * of its own. A record that disappears or takes a new generation loses exactly
 * its own attempt and projection; clearing the selection resets nothing. Only
 * sign-out and an enrollment that is not ready revoke everything.
 */
function watchEnvironmentSessionsForE2ee(): () => void {
  const sessions = getHostedEnvironmentSessions();
  interface AccountSnapshot {
    readonly accountStatus: ReturnType<typeof hostedHubStore.getState>["accountStatus"];
    readonly accountId: string | null;
    readonly trustRevision: number;
    readonly enrollmentGeneration: number;
    readonly enrollmentStatus: string;
  }
  interface RecordSnapshot {
    readonly nodeId: string;
    readonly generation: number;
    /** Not suspended, and a connection was requested for this generation. */
    readonly warm: boolean;
  }
  const sameAccount = (left: AccountSnapshot, right: AccountSnapshot): boolean =>
    left.accountStatus === right.accountStatus &&
    left.accountId === right.accountId &&
    left.trustRevision === right.trustRevision &&
    left.enrollmentGeneration === right.enrollmentGeneration &&
    left.enrollmentStatus === right.enrollmentStatus;
  const sameRecord = (left: RecordSnapshot, right: RecordSnapshot): boolean =>
    left.nodeId === right.nodeId &&
    left.generation === right.generation &&
    left.warm === right.warm;

  let lastAccount: AccountSnapshot | undefined;
  let lastRecords = new Map<EnvironmentId, RecordSnapshot>();
  const evaluate = () => {
    const state = hostedHubStore.getState();
    const enrollment = enrollmentCoordinator?.getState();
    const account: AccountSnapshot = {
      accountStatus: state.accountStatus,
      accountId: state.account?.id ?? null,
      trustRevision: mobileE2eeTrustStore.revision(),
      enrollmentGeneration: enrollment?.generation ?? 0,
      enrollmentStatus: enrollment?.status ?? "idle",
    };
    const accountChanged = lastAccount === undefined || !sameAccount(account, lastAccount);
    if (accountChanged) {
      lastAccount = account;
      syncNativeEnrollment();
    }
    if (
      state.accountStatus !== "authenticated" ||
      enrollmentCoordinator?.getState().status !== "ready"
    ) {
      if (accountChanged) releaseEveryE2eeAttempt();
      lastRecords = new Map();
      return;
    }

    const records = new Map<EnvironmentId, HostedEnvironmentSessionRecord>();
    for (const record of sessions.list()) records.set(record.environmentId, record);
    for (const [environmentId, previous] of lastRecords) {
      const record = records.get(environmentId);
      if (record !== undefined && record.generation === previous.generation) continue;
      // The attempt and the claim belonged to the generation that just ended.
      disposeMobileRelayE2eeAttemptFor(environmentId);
      resetMobileE2eeSession(environmentId);
    }
    const next = new Map<EnvironmentId, RecordSnapshot>();
    for (const record of records.values()) {
      const snapshot: RecordSnapshot = {
        nodeId: record.nodeId,
        generation: record.generation,
        warm: !record.suspended && record.connectRequested,
      };
      next.set(record.environmentId, snapshot);
      const previous = lastRecords.get(record.environmentId);
      if (!snapshot.warm) continue;
      if (accountChanged || previous === undefined || !sameRecord(previous, snapshot)) {
        void prepareMobileRelayE2eeAttempt(attemptTargetFor(sessions, record));
      }
    }
    lastRecords = next;
  };
  const unsubscribeInputs = subscribeE2eeInputs(evaluate);
  const unsubscribeSessions = sessions.subscribe(evaluate);
  evaluate();
  return () => {
    unsubscribeInputs();
    unsubscribeSessions();
  };
}

/** The channel target of one environment record's current generation. */
function attemptTargetFor(
  sessions: HostedEnvironmentSessions,
  record: HostedEnvironmentSessionRecord,
): MobileE2eeAttemptTarget {
  return {
    nodeId: record.nodeId,
    nodeLabel: record.label,
    environmentId: record.environmentId,
    generation: record.generation,
    isCurrent: () => sessions.isCurrentGeneration(record.environmentId, record.generation),
  };
}

/**
 * Start native enrollment for the signed-in account, or cancel it once nobody
 * is signed in. `unavailable` and `revoked` recover inside the coordinator, on
 * the lifecycle wired at construction.
 */
function syncNativeEnrollment(): void {
  const state = hostedHubStore.getState();
  const enrollment = enrollmentCoordinator?.getState();
  if (state.accountStatus === "authenticated" && state.account !== null) {
    if (
      enrollment?.status === "idle" ||
      (enrollment?.status === "ready" &&
        enrollment.ready !== null &&
        enrollment.ready.namespace.accountId !== state.account.id)
    ) {
      void enrollmentCoordinator?.ensure(state.account.id).catch(() => undefined);
    }
  } else if (enrollment && enrollment.status !== "idle") {
    void enrollmentCoordinator?.invalidate("signed-out");
  }
}

/** Revoke every environment's warm attempt and clear every projection. */
function releaseEveryE2eeAttempt(): void {
  disposeMobileRelayE2eeAttempt();
  resetMobileE2eeSession();
}

/**
 * Re-evaluate on every input an attempt is resolved from: the account and its
 * selection, the trust document, and the enrollment.
 */
function subscribeE2eeInputs(evaluate: () => void): () => void {
  const unsubscribeStore = hostedHubStore.subscribe(evaluate);
  const unsubscribeTrust = mobileE2eeTrustStore.subscribe(evaluate);
  const unsubscribeEnrollment = enrollmentCoordinator?.subscribe(evaluate) ?? (() => undefined);
  return () => {
    unsubscribeStore();
    unsubscribeTrust();
    unsubscribeEnrollment();
  };
}

/**
 * The single entry point screens use.
 *
 * Order matters: the bearer token must be hydrated **before**
 * `hostedHubController.bootstrap()` runs. `readBearerToken()` is synchronous,
 * so a null read would make `restoreSession` fail with a 401 and drop the user
 * to the bootstrap-availability probe even though a valid session exists.
 *
 * The §13 trust store is hydrated before `configureMobileHostedRuntime`, which
 * is what installs the relay socket factory: no channel can exist until the load
 * has completed or failed. `docs/relay-e2ee-protocol.md` §4.4 requires every
 * latch and pin guard to be "evaluated against the pin the client resolves from
 * **its own** channel selection" before any payload arrives, and §13.1.1's
 * partial-loss rule makes an unread store UNEXPECTED rather than legacy-eligible.
 * The load therefore has to precede the first `channel.accept`, and it never
 * rejects: a store that cannot be read leaves the classifier at `unobtainable`,
 * which fails closed, and taking the whole hosted session down for it would put
 * a keychain hiccup between the owner and their nodes.
 */
export function ensureMobileHostedSession(): Promise<void> {
  if (session) return session;
  const attempt = (async () => {
    await hydrateMobileHubProfile(mobileKV);
    // A settings render may have memoized the build default before async
    // profile hydration completed. Re-resolve now so a compatible saved domain
    // becomes authoritative before any secret is read or request is sent.
    invalidateMobileHostedRuntimeConfig();
    if (!isMobileHostedModeConfigured()) return false;
    // The token and trust reads are independent keychain round trips, so they
    // overlap. The hardware key is needed only to restore a stored session:
    // its load starts the moment the token read finds one, still overlapping
    // the trust read, and is joined by `configureMobileHostedRuntime`, which
    // maps its failure to `device-security`. With no stored session nothing
    // signs at launch, so the key is left to first hosted use.
    const hasStoredSession = () => (mobileSessionCredentials.readBearerToken?.() ?? null) !== null;
    const tokenRead = hydrateMobileHostedSessionToken();
    // Boxed so the attempt's own rejection reaches the configuration step
    // instead of rejecting this read.
    const signerLoad = tokenRead.then(
      () => {
        if (configured || !hasStoredSession()) return undefined;
        const attempt = createMobileDpopSigner();
        attempt.catch(() => undefined);
        return { attempt };
      },
      () => undefined,
    );
    const [token, trust] = await Promise.allSettled([tokenRead, mobileE2eeTrustStore.hydrate()]);
    if (token.status === "rejected") {
      setMobileHostedModeAvailable(false, "credential-storage");
      return false;
    }
    if (trust.status === "rejected") throw trust.reason;
    // No stored session means there is nothing to restore: the access check
    // would only fail locally on the missing token, clear material that does
    // not exist, and spend a proof plus a Hub round trip (up to the request
    // deadline) on the bootstrap-availability probe, whose answer no mobile
    // surface reads. The store already reads `signed-out`; a sign-in ceremony
    // adopts its credential and checks access itself.
    if (!hasStoredSession()) return await configureMobileHostedRuntime("deferred");
    if (!(await configureMobileHostedRuntime((await signerLoad)?.attempt))) return false;
    await hostedHubController.bootstrap();
    return true;
  })().then(
    (ready) => {
      if (!ready && session === attempt) session = undefined;
    },
    () => {
      if (session === attempt) session = undefined;
    },
  );
  session = attempt;
  return attempt;
}

/** Invalidate hosted availability after a deliberate Hub profile change. */
export function invalidateMobileHostedRuntime(): void {
  configured = false;
  setMobileHostedModeAvailable(false);
  session = undefined;
  selectionWatch?.();
  selectionWatch = undefined;
  void enrollmentCoordinator?.invalidate("signed-out");
  enrollmentCoordinator = null;
  setMobileNativeE2eeEnrollmentCoordinator(null);
  // Enrollment invalidation synchronously revokes the hosted generation, warm
  // attempt, and session projection through its configured callback above.
  invalidateMobileHostedRuntimeConfig();
  // An account that is not authenticated belongs to the Hub being left, and
  // nothing may keep working on it: an `unavailable` one still has its access
  // retry armed, and that retry (or a foreground) would bootstrap through the
  // previous Hub's API until the runtime is configured again, and a later
  // session setup could join a check still in flight. Resetting it to
  // signed-out aborts the check and cancels the retry. An authenticated
  // account is torn down by the profile-change flow itself.
  if (hostedHubStore.getState().accountStatus !== "authenticated") {
    void hostedHubController.clearAccount("signed-out");
  }
}

/** Test seam: drop the configured/available flags between cases. */
export function resetMobileHostedRuntimeForTests(): void {
  invalidateMobileHostedRuntime();
}
