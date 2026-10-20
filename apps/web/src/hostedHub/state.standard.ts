import type {
  HostedAccountRefused,
  HostedAccountState,
  HostedEnvironmentSessionsMode,
  HostedHubState,
  HostedRecoveryCodeDisplayState,
} from "@ryco/client-runtime/authorization";
import {
  createHostedStore,
  INITIAL_HOSTED_ACCOUNT_STATE,
  INITIAL_HOSTED_HUB_STATE,
  INITIAL_HOSTED_RECOVERY_CODE_DISPLAY_STATE,
} from "@ryco/client-runtime/authorization/hostedStores";
import type {
  HostedEnvironmentSessionRecord,
  HostedEnvironmentSessions,
  HostedEnvironmentSessionsSnapshot,
} from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import type { EnvironmentId } from "@ryco/contracts";
import { useStore } from "zustand";

import { hostedOnly } from "./hostedOnly";

/**
 * Standard-build stand-in for `./state` (wired by `src/clientModeSeams.ts`).
 *
 * A standard (local / desktop) build never runs the hosted lifecycle: nothing
 * bootstraps the controller, so the real stores stay at their initial,
 * signed-out snapshot for the life of the page. This module publishes that same
 * snapshot without loading the hosted runtime, its Hub API client, or the relay
 * E2EE stack. Read paths answer exactly what the real module answers in a
 * standard build; the controller accepts every call and changes nothing, and
 * account actions refuse as signed out. The stores come from the same light
 * factory and initial snapshots as the real ones
 * (`@ryco/client-runtime/authorization/hostedStores`); `clientModeSeams.test.ts`
 * pins the export list and the snapshots to the real module.
 */

type HostedHubController =
  (typeof import("@ryco/client-runtime/authorization"))["hostedHubController"];

export const HOSTED_SESSION_SYNC_FAILURE_MESSAGE = "Ryco state could not be synchronized.";

export const hostedHubStore = createHostedStore(INITIAL_HOSTED_HUB_STATE);

export const hostedAccountStore = createHostedStore(INITIAL_HOSTED_ACCOUNT_STATE);

export const hostedRecoveryCodeDisplayStore = createHostedStore(
  INITIAL_HOSTED_RECOVERY_CODE_DISPLAY_STATE,
);

const settled = (): Promise<void> => Promise.resolve();
const ignore = (): void => undefined;
const release = (): (() => void) => ignore;
const SIGNED_OUT: HostedAccountRefused = {
  status: "refused",
  reason: "signed-out",
  errorCode: null,
  wireErrorCode: null,
  inferredErrorCode: false,
  errorMessage: null,
};
const refuseSignedOut = (): Promise<HostedAccountRefused> => Promise.resolve(SIGNED_OUT);

/**
 * Every public member of the hosted controller: a member added there fails the
 * typecheck here instead of resolving to `undefined` in standard builds.
 */
const standardHostedHubController: {
  readonly [K in keyof HostedHubController]: HostedHubController[K];
} = {
  bootstrap: settled,
  accessCheckPending: () => false,
  bootstrapAccess: settled,
  adoptSessionCredential: () => Promise.resolve(false),
  signInWithRecoveryCode: settled,
  recoverAfterConnectivity: settled,
  signIn: settled,
  signInWithExternalProvider: settled,
  redeemInvitation: settled,
  bootstrapOwner: settled,
  adoptPublicBrowserIdentity: settled,
  cancelAuthentication: ignore,
  leaseRecoveryCodeDisplay: release,
  dismissRecoveryCodes: ignore,
  dismissTotpEnrollment: ignore,
  invalidateNativeE2eeAuthorization: ignore,
  refreshPasskeys: settled,
  refreshE2eeDevices: settled,
  refreshExternalIdentityConfiguration: settled,
  refreshAccountSecurity: settled,
  addPasskey: refuseSignedOut,
  regenerateRecoveryCodes: refuseSignedOut,
  revokePasskey: refuseSignedOut,
  renameE2eeDevice: refuseSignedOut,
  revokeE2eeDevice: refuseSignedOut,
  setPassword: refuseSignedOut,
  removePassword: refuseSignedOut,
  beginTotpEnrollment: refuseSignedOut,
  confirmTotpEnrollment: refuseSignedOut,
  revokeTotp: refuseSignedOut,
  requestEmailVerification: refuseSignedOut,
  connectExternalIdentity: refuseSignedOut,
  cancelExternalIdentityConnection: ignore,
  finishBrowserExternalIdentityConnection: refuseSignedOut,
  disconnectExternalIdentity: refuseSignedOut,
  cancelAccountAction: ignore,
  resetForTests: ignore,
  signOut: settled,
  expireSession: settled,
  suspendBrowser: ignore,
  resumeBrowser: settled,
  revalidateSession: settled,
  clearAccount: settled,
  refreshDirectory: settled,
  notifyDirectoryInvalidated: ignore,
  watchDirectoryPresence: release,
  selectNode: settled,
  acquireEnvironment: () => Promise.resolve("refused"),
  releaseEnvironment: settled,
  returnToDirectory: settled,
  retrySelectedNode: settled,
  transportStatus: ignore,
  sessionStatus: ignore,
  role: ignore,
  failure: ignore,
  markDeliveryUnknown: ignore,
  markEnvironmentDeliveryUnknown: ignore,
  connectionClosed: ignore,
  connectionRecovered: ignore,
  markSessionReady: ignore,
  markSessionReplaying: ignore,
  reportShellSnapshotFailure: ignore,
  reportHubSessionFailure: ignore,
  acknowledgeDeliveryUnknown: ignore,
};

export const hostedHubController = standardHostedHubController as HostedHubController;

const EMPTY_ENVIRONMENT_SESSIONS: HostedEnvironmentSessionsSnapshot = Object.freeze({
  revision: 0,
  records: new Map<EnvironmentId, HostedEnvironmentSessionRecord>(),
  deliveryUnknown: new Set<EnvironmentId>(),
});
const NO_ENVIRONMENT_SESSION_RECORDS: ReadonlyArray<never> = [];

/**
 * The per-environment session registry of a build that never connects to a
 * hosted node: always empty, and nothing in it ever changes. Creating a record
 * is a hosted-only act.
 */
const standardHostedEnvironmentSessions: {
  readonly [K in keyof HostedEnvironmentSessions]: HostedEnvironmentSessions[K];
} = {
  read: () => undefined,
  list: () => NO_ENVIRONMENT_SESSION_RECORDS,
  getSnapshot: () => EMPTY_ENVIRONMENT_SESSIONS,
  subscribe: release,
  isCurrentGeneration: () => false,
  presenceOnlineEdges: () => 0,
  ensureRecord: () => hostedOnly("ensureRecord"),
  markConnectRequested: ignore,
  renew: () => undefined,
  release: ignore,
  suspendAll: () => [],
  withdrawAll: () => [],
  clear: ignore,
  transportStatus: ignore,
  sessionStatus: ignore,
  role: ignore,
  failure: ignore,
  markDeliveryUnknown: ignore,
  connectionClosed: ignore,
  connectionRecovered: ignore,
  markSessionReady: ignore,
  markSessionReplaying: ignore,
  reportShellSnapshotFailure: ignore,
  registerPendingRequestReader: ignore,
  markEnvironmentDeliveryUnknown: ignore,
  acknowledgeDeliveryUnknown: ignore,
};

export const getHostedEnvironmentSessions: () => HostedEnvironmentSessions = () =>
  standardHostedEnvironmentSessions;

/** A standard build keeps no hosted environment sessions at all. */
export const hostedEnvironmentSessionsMode: () => HostedEnvironmentSessionsMode = () => "single";

/** A build without hosted sessions has none that selecting a node could adopt. */
export const isHostedEnvironmentSessionAdoptable: (environmentId: EnvironmentId) => boolean = () =>
  false;

/** Standard builds have no hosted runtime to configure. */
export const ensureWebHostedRuntimeConfigured: () => void = ignore;

export const markHostedSessionReady: (environmentId: EnvironmentId, generation: number) => void =
  ignore;

export const markHostedSessionReplaying: (
  environmentId: EnvironmentId,
  generation: number,
) => void = ignore;

export const reportHostedShellSnapshotFailure: (
  environmentId: EnvironmentId,
  generation: number,
) => void = ignore;

type HostedHubSelector<T> = (state: HostedHubState) => T;

/** React binding for the (static) standard-build hosted lifecycle state. */
export const useHostedHubStore = Object.assign(
  <T>(selector: HostedHubSelector<T>): T =>
    useStore(hostedHubStore as never, selector as never) as T,
  hostedHubStore,
);

type HostedAccountSelector<T> = (state: HostedAccountState) => T;

/** React binding for the (static) standard-build hosted account state. */
export const useHostedAccountStore = Object.assign(
  <T>(selector: HostedAccountSelector<T>): T =>
    useStore(hostedAccountStore as never, selector as never) as T,
  hostedAccountStore,
);

type HostedRecoveryCodeDisplaySelector<T> = (state: HostedRecoveryCodeDisplayState) => T;

/** React binding for the (static) standard-build recovery-code display lease. */
export const useHostedRecoveryCodeDisplayStore = Object.assign(
  <T>(selector: HostedRecoveryCodeDisplaySelector<T>): T =>
    useStore(hostedRecoveryCodeDisplayStore as never, selector as never) as T,
  hostedRecoveryCodeDisplayStore,
);
