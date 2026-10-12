import type {
  HostedAccountState,
  HostedHubState,
  HostedRecoveryCodeDisplayState,
} from "./state.ts";

/**
 * The hosted lifecycle's store factory and initial snapshots, without the
 * hosted runtime.
 *
 * `state.ts` builds its stores from these. A client that never runs the hosted
 * lifecycle (the web standard build, through `hostedHub/state.standard.ts`)
 * publishes the same signed-out snapshots from the same definitions without
 * loading the controller, the Hub API client, or the relay stack, so the two
 * can never disagree about what "not hosted" looks like.
 */

export type HostedStoreListener = () => void;

/** Neutral external store; React binding remains in the app adapters. */
export interface HostedStore<T extends object> {
  readonly getState: () => T;
  readonly getInitialState: () => T;
  readonly setState: (patch: Partial<T> | T, replace?: boolean) => void;
  readonly subscribe: (listener: HostedStoreListener) => () => boolean;
}

export function createHostedStore<T extends object>(initial: T): HostedStore<T> {
  let state = initial;
  const listeners = new Set<HostedStoreListener>();
  const publish = () => listeners.forEach((listener) => listener());
  return {
    getState: () => state,
    getInitialState: () => initial,
    setState: (patch, replace = false) => {
      state = replace ? (patch as T) : { ...state, ...patch };
      publish();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const INITIAL_HOSTED_HUB_STATE: HostedHubState = {
  bootstrapAvailable: false,
  accountStatus: "signed-out",
  account: null,
  session: null,
  directoryStatus: "idle",
  nodes: [],
  selectedNode: null,
  selectionStatus: "none",
  effectiveRole: null,
  transportStatus: "idle",
  sessionStatus: "closed",
  sessionEstablished: false,
  sessionRecoveredAfterUnknown: false,
  browserStatus: "current",
  recoveryCodes: [],
  totpEnrollment: null,
  errorMessage: null,
  errorReason: null,
  accessRecoveryPending: false,
  generation: 0,
};

export const INITIAL_HOSTED_ACCOUNT_STATE: HostedAccountState = {
  externalIdentityConfiguration: null,
  externalIdentityConfigurationStatus: "idle",
  passkeys: [],
  passkeysStatus: "idle",
  e2eeDevices: [],
  e2eeDevicesStatus: "idle",
  security: null,
  securityStatus: "idle",
  actionStatus: "idle",
  errorMessage: null,
  errorCode: null,
  errorCodeInferred: false,
};

export const INITIAL_HOSTED_RECOVERY_CODE_DISPLAY_STATE: HostedRecoveryCodeDisplayState = {
  leased: false,
};
