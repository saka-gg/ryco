import type { EnvironmentId } from "@ryco/contracts";
import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts/orchestration";
import type { RelayEffectiveRole } from "@ryco/contracts/relay";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { hostedRoleAllows, rpcDeliveryEffectFor } from "@ryco/shared/rpcAccessPolicy";

import type { HostedEnvironmentSessionRecord } from "./hostedEnvironmentSessions.ts";
import type { HostedHubState } from "./state.ts";
import type {
  HostedBrowserStatus,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
  HostedSelectionStatus,
} from "./types.ts";

// This module is loaded by builds that never run the hosted lifecycle, so it
// imports the session registry and the hosted state as types only.

/**
 * Why an action is or is not available, in terms a surface can act on:
 *
 * - `ready`: the action is allowed.
 * - `establishing`: the connection is deliberately on its way (a node switch, a
 *   budget rotation) and nothing is wrong. Surfaces wait quietly.
 * - `stale`: authorization, the directory or the relay is not current.
 * - `role`: the connection is fine but the role does not cover the action.
 * - `delivery-unknown`: an earlier action could not be confirmed, so the
 *   session refuses this one until the user has seen that.
 */
export type HostedCapabilityKind = "ready" | "establishing" | "stale" | "role" | "delivery-unknown";

export interface HostedRpcCapability {
  readonly hosted: boolean;
  readonly allowed: boolean;
  readonly reason: string | null;
  /** Optional so hand-built capabilities keep compiling; every resolver sets it. */
  readonly kind?: HostedCapabilityKind;
}

export interface HostedSessionAdmissionState {
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly sessionRecoveredAfterUnknown: boolean;
}

/**
 * Whether the hosted Ryco session admits `method` right now.
 *
 * A session that recovered after uncertain delivery keeps refusing mutations
 * until the user has seen the uncertainty, because Ryco cannot tell them whether
 * the earlier action ran. Reads only observe node state, so the replacement
 * session's accepted snapshot is all they need: gating them would freeze every
 * file, diff, and history view over an action they had nothing to do with.
 */
export function hostedSessionAdmits(state: HostedSessionAdmissionState, method: string): boolean {
  if (state.sessionStatus === "ready") return true;
  return (
    state.sessionStatus === "delivery-unknown" &&
    state.sessionRecoveredAfterUnknown &&
    rpcDeliveryEffectFor(method) === "read"
  );
}

/**
 * Observe-only unary reads a channel answers before its session has accepted
 * the shell snapshot: project lists and files, local changes, thread history
 * and diffs, and the node's config and settings. Never derive this from the
 * delivery effect: its reads also cover requests that refresh derived state or
 * reach out — issuing a credential, starting a provider, calling a model,
 * fetching from a remote.
 */
const HOSTED_EARLY_READ_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.projectsList,
  WS_METHODS.projectsListEntries,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.projectsReadIcon,
  WS_METHODS.vcsReadLocalChanges,
  WS_METHODS.vcsReadComparison,
  WS_METHODS.vcsReadLineBlame,
  ORCHESTRATION_WS_METHODS.getThreadWindow,
  ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverGetSettings,
]);

export interface HostedEarlyReadState {
  readonly transportStatus: HostedRelayTransportStatus;
  readonly browserStatus: HostedBrowserStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
}

/**
 * A read on a channel that is up and mode-locked, while its session catches up.
 *
 * A transport turns `online` only once its channel's mode is locked — end-to-end
 * encrypted, or a labeled legacy channel — so nothing admitted here travels on
 * a channel that is still negotiating. The session is then synchronizing (a new
 * channel) or replaying (a reconnect reconciling its subscriptions); a stale,
 * closed, or unconfirmed session admits nothing early, and a ready one needs no
 * exception. Only the observe-only reads listed above qualify. Mutations never
 * take this path: they wait for the session to accept its snapshot.
 */
export function hostedAdmitsReadBeforeSnapshot(
  state: HostedEarlyReadState,
  method: string,
): boolean {
  return (
    HOSTED_EARLY_READ_METHODS.has(method) &&
    state.transportStatus === "online" &&
    browserRevalidated(state.browserStatus) &&
    (state.sessionStatus === "synchronizing" || state.sessionStatus === "replaying")
  );
}

/**
 * What tells a connection that is deliberately on its way (an intentional node
 * switch, a budget rotation) from one that has a problem.
 *
 * Both look the same to a status derivation: a transport that is not online
 * yet. The difference is everything around it — the account and directory are
 * current, the node is reachable, and nothing went wrong that would need
 * showing — which is what this collects.
 */
export interface HostedConnectionPhase {
  readonly accountAuthenticated: boolean;
  readonly directoryReady: boolean;
  readonly browserStatus: HostedBrowserStatus;
  readonly selectionStatus: HostedSelectionStatus;
  readonly transportStatus: HostedRelayTransportStatus;
  readonly sessionStatus: HostedRycoSessionStatus;
  /** There is no error to show, so a transport that is not online is intentional. */
  readonly quiet: boolean;
}

/** Transports that are working towards `online` without having failed. */
const ESTABLISHING_TRANSPORT_STATUSES: ReadonlySet<HostedRelayTransportStatus> = new Set([
  "idle",
  "requesting-ticket",
  "connecting",
  "authenticating",
  "opening-channel",
  "reconnecting",
]);

/**
 * The account and directory were checked in this browser lifecycle: `current`,
 * or `synchronizing` while only the selected node is still being established.
 * The same rule as the session registry's, restated here to keep that module
 * out of builds that have no hosted sessions.
 */
function browserRevalidated(status: HostedBrowserStatus): boolean {
  return status === "current" || status === "synchronizing";
}

/**
 * Whether the connection is on its way to usable and nothing is wrong: the
 * account and directory are current, the node is online, no error is waiting to
 * be shown, and either the transport is still being established or it is up and
 * the session is catching up. An unconfirmed delivery is a state of its own and
 * never counts as establishing.
 */
export function isHostedConnectionEstablishing(phase: HostedConnectionPhase): boolean {
  if (!phase.accountAuthenticated || !phase.directoryReady || !phase.quiet) return false;
  if (!browserRevalidated(phase.browserStatus)) return false;
  if (phase.selectionStatus !== "online" || phase.sessionStatus === "delivery-unknown") {
    return false;
  }
  if (phase.transportStatus === "online") {
    return phase.sessionStatus === "synchronizing" || phase.sessionStatus === "replaying";
  }
  return ESTABLISHING_TRANSPORT_STATUSES.has(phase.transportStatus);
}

const STALE_REASON = "This action is unavailable while Hub authorization or the relay is stale.";
const SELECTED_NODE_ROLE_REASON = "This action is unavailable for your role on the selected node.";
const NODE_ROLE_REASON = "This action is unavailable for your role on this node.";

/** Shared results: the same input always yields the identical object. */
function capabilityResult(
  hosted: boolean,
  allowed: boolean,
  reason: string | null,
  kind: HostedCapabilityKind,
): HostedRpcCapability {
  return Object.freeze({ hosted, allowed, reason, kind });
}

const NOT_HOSTED = capabilityResult(false, true, null, "ready");
const ALLOWED = capabilityResult(true, true, null, "ready");
const STALE = capabilityResult(true, false, STALE_REASON, "stale");
const ESTABLISHING = capabilityResult(true, false, STALE_REASON, "establishing");
const DELIVERY_UNKNOWN = capabilityResult(true, false, STALE_REASON, "delivery-unknown");
const SELECTED_NODE_ROLE = capabilityResult(true, false, SELECTED_NODE_ROLE_REASON, "role");
const NODE_ROLE = capabilityResult(true, false, NODE_ROLE_REASON, "role");

export interface HostedRpcCapabilityInput {
  readonly hosted: boolean;
  readonly role: RelayEffectiveRole | null;
  readonly fresh: boolean;
  readonly browserCurrent?: boolean;
  readonly sessionReady?: boolean;
  readonly method: string;
  /**
   * What the connection is doing, to tell a stale-looking capability that is
   * simply being established from one that has a problem. Without it a refusal
   * to run is always `stale`.
   */
  readonly phase?: HostedConnectionPhase;
}

function refusedWhileNotCurrent(phase: HostedConnectionPhase | undefined): HostedRpcCapability {
  if (phase === undefined) return STALE;
  if (phase.sessionStatus === "delivery-unknown") return DELIVERY_UNKNOWN;
  return isHostedConnectionEstablishing(phase) ? ESTABLISHING : STALE;
}

function evaluate(input: HostedRpcCapabilityInput, roleRefusal: HostedRpcCapability) {
  if (!input.hosted) return NOT_HOSTED;
  if (!input.fresh || input.browserCurrent === false || input.sessionReady === false) {
    return refusedWhileNotCurrent(input.phase);
  }
  return hostedRoleAllows(input.role, input.method, true) ? ALLOWED : roleRefusal;
}

export function resolveHostedRpcCapability(input: HostedRpcCapabilityInput): HostedRpcCapability {
  return evaluate(input, SELECTED_NODE_ROLE);
}

/**
 * The hosted state every capability reads, flattened to primitives so a
 * subscription to it compares shallowly and an unrelated store change (a
 * directory refresh, a node list update) changes nothing here.
 */
export interface HostedSharedCapabilityState {
  readonly accountStatus: HostedHubState["accountStatus"];
  readonly directoryStatus: HostedHubState["directoryStatus"];
  readonly browserStatus: HostedHubState["browserStatus"];
  readonly selectionStatus: HostedHubState["selectionStatus"];
  /** The selected environment's own connection, which the shared state mirrors. */
  readonly effectiveRole: RelayEffectiveRole | null;
  readonly transportStatus: HostedHubState["transportStatus"];
  readonly sessionStatus: HostedRycoSessionStatus;
  readonly sessionRecoveredAfterUnknown: boolean;
  readonly errorMessage: string | null;
  readonly selectedEnvironmentId: EnvironmentId | null;
  /**
   * Whether the directory lists the asked-for environment's node as online;
   * `null` when it does not list it, or when no other environment was asked for.
   */
  readonly nodeOnline: boolean | null;
}

type HostedCapabilitySource = Pick<
  HostedHubState,
  | "accountStatus"
  | "directoryStatus"
  | "browserStatus"
  | "selectionStatus"
  | "effectiveRole"
  | "transportStatus"
  | "sessionStatus"
  | "sessionRecoveredAfterUnknown"
  | "errorMessage"
  | "selectedNode"
  | "nodes"
>;

/** The flat capability inputs of `state`, for the environment asked about. */
export function selectHostedSharedCapabilityState(
  state: HostedCapabilitySource,
  environmentId?: EnvironmentId | null,
): HostedSharedCapabilityState {
  const selectedEnvironmentId = state.selectedNode?.environmentId ?? null;
  const other = environmentId != null && environmentId !== selectedEnvironmentId;
  const node = other
    ? state.nodes.find((candidate) => candidate.environmentId === environmentId)
    : undefined;
  return {
    accountStatus: state.accountStatus,
    directoryStatus: state.directoryStatus,
    browserStatus: state.browserStatus,
    selectionStatus: state.selectionStatus,
    effectiveRole: state.effectiveRole,
    transportStatus: state.transportStatus,
    sessionStatus: state.sessionStatus,
    sessionRecoveredAfterUnknown: state.sessionRecoveredAfterUnknown,
    errorMessage: state.errorMessage,
    selectedEnvironmentId,
    nodeOnline: node ? node.presence.online : null,
  };
}

/**
 * The capability of `method` on one environment.
 *
 * The selected environment (and an unspecified one) is answered from the shared
 * state, which mirrors the selected node's own connection. Any other environment
 * is answered from its own session record — its role, transport and session —
 * together with the shared account and directory: those were revalidated once
 * for everything, so a browser that is still synchronizing the selection counts
 * as current for an environment whose own session already established. An
 * environment without a record has no connection yet and is never allowed.
 *
 * An observe-only read is answered as the transport admits it: allowed once
 * the environment's channel is online, before its session has accepted the
 * snapshot.
 */
export function resolveHostedEnvironmentRpcCapability(input: {
  readonly hosted: boolean;
  readonly method: string;
  readonly shared: HostedSharedCapabilityState;
  readonly record: HostedEnvironmentSessionRecord | null | undefined;
  readonly environmentId?: EnvironmentId | null | undefined;
  /**
   * Answer as if reads still waited for the accepted snapshot — for callers
   * that must not change before it, such as a connection-phase probe.
   */
  readonly requireSnapshot?: boolean;
}): HostedRpcCapability {
  const { hosted, method, shared, record, environmentId } = input;
  if (!hosted) return NOT_HOSTED;
  const accountAuthenticated = shared.accountStatus === "authenticated";
  const directoryReady = shared.directoryStatus === "ready";
  const readsEarly = input.requireSnapshot !== true;
  if (environmentId == null || environmentId === shared.selectedEnvironmentId) {
    const early = readsEarly && hostedAdmitsReadBeforeSnapshot(shared, method);
    return evaluate(
      {
        hosted,
        role: shared.effectiveRole,
        fresh: directoryReady && shared.transportStatus === "online",
        browserCurrent: early || shared.browserStatus === "current",
        sessionReady: early || hostedSessionAdmits(shared, method),
        method,
        phase: {
          accountAuthenticated,
          directoryReady,
          browserStatus: shared.browserStatus,
          selectionStatus: shared.selectionStatus,
          transportStatus: shared.transportStatus,
          sessionStatus: shared.sessionStatus,
          quiet: shared.errorMessage === null,
        },
      },
      SELECTED_NODE_ROLE,
    );
  }
  if (record == null) {
    // No connection to judge yet: one is on its way when the directory lists
    // the node as online.
    return isHostedConnectionEstablishing({
      accountAuthenticated,
      directoryReady,
      browserStatus: shared.browserStatus,
      selectionStatus: shared.nodeOnline === true ? "online" : "none",
      transportStatus: "idle",
      sessionStatus: "synchronizing",
      quiet: true,
    })
      ? ESTABLISHING
      : STALE;
  }
  const early =
    readsEarly &&
    hostedAdmitsReadBeforeSnapshot(
      {
        transportStatus: record.transportStatus,
        browserStatus: shared.browserStatus,
        sessionStatus: record.sessionStatus,
      },
      method,
    );
  return evaluate(
    {
      hosted,
      role: record.effectiveRole,
      fresh: directoryReady && record.transportStatus === "online",
      browserCurrent: browserRevalidated(shared.browserStatus),
      sessionReady: early || hostedSessionAdmits(record, method),
      method,
      phase: {
        accountAuthenticated,
        directoryReady,
        browserStatus: shared.browserStatus,
        // The record was opened for a listed node: only the directory saying the
        // node went offline turns its connecting into a problem.
        selectionStatus: shared.nodeOnline === false ? "offline" : "online",
        transportStatus: record.transportStatus,
        sessionStatus: record.sessionStatus,
        quiet: record.failure === null,
      },
    },
    NODE_ROLE,
  );
}
