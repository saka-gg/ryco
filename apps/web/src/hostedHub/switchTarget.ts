import type { HostedHubState } from "@ryco/client-runtime/authorization";
import type {
  HostedCapabilityKind,
  HostedRpcCapability,
} from "@ryco/client-runtime/authorization/capabilities";
import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import { useMemo } from "react";

import { useHostedRpcCapability } from "./capabilities";
import { useHostedWorkspaceState } from "./hostedConnectionCoordinator";
import { useHostedHubStore } from "./state";

/**
 * A read every role may run, used only to ask what phase the connection is in
 * (its kind), never whether a particular action is allowed.
 */
const CONNECTION_PHASE_PROBE_METHOD = WS_METHODS.projectsList;

const UNNAMED_NODE = "this node";

export interface HostedSwitchTarget {
  /** The node's display name, or `null` when the directory does not list it. */
  readonly label: string | null;
  /** The connection phase, or `null` outside a hosted build. */
  readonly kind: HostedCapabilityKind | null;
  /** The node waits for a free connection: every slot is held by an open view. */
  readonly queued: boolean;
}

type HostedSwitchTargetSource = Pick<HostedHubState, "nodes" | "selectedNode">;

/**
 * The display name of the node for `environmentId` (the selected node when none
 * is named), from the directory; `null` when it is not listed.
 */
export function hostedSwitchTargetLabel(
  state: HostedSwitchTargetSource,
  environmentId?: EnvironmentId | null,
): string | null {
  const targetId = environmentId ?? state.selectedNode?.environmentId ?? null;
  if (targetId === null) return null;
  const node = state.nodes.find((candidate) => candidate.environmentId === targetId);
  if (node) return node.label;
  return state.selectedNode?.environmentId === targetId ? state.selectedNode.label : null;
}

/** Whether the environment (the selected one when none is named) waits for a connection slot. */
export function hostedSwitchTargetQueued(
  environmentId: EnvironmentId | null | undefined,
  selectedEnvironmentId: EnvironmentId | null,
  queuedEnvironmentIds: ReadonlyArray<EnvironmentId>,
): boolean {
  const targetId = environmentId ?? selectedEnvironmentId;
  return targetId !== null && queuedEnvironmentIds.includes(targetId);
}

/**
 * Where a node switch is heading, for surfaces that show progress or explain a
 * disabled action: the node's name, whether its connection is merely being
 * established, and whether it is waiting for a free connection slot.
 *
 * `environmentId` names the environment and is always stated; `null` means the
 * selected one.
 */
export function useHostedSwitchTarget(environmentId: EnvironmentId | null): HostedSwitchTarget {
  const label = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const selectedEnvironmentId = useHostedHubStore(
    (state) => state.selectedNode?.environmentId ?? null,
  );
  const capability = useHostedRpcCapability(CONNECTION_PHASE_PROBE_METHOD, environmentId);
  const queuedEnvironmentIds = useHostedWorkspaceState().demand.queuedEnvironmentIds;
  const queued = hostedSwitchTargetQueued(
    environmentId,
    selectedEnvironmentId,
    queuedEnvironmentIds,
  );
  const kind = capability.hosted ? (capability.kind ?? null) : null;
  return useMemo(() => ({ label, kind, queued }), [kind, label, queued]);
}

/**
 * Why an action is unavailable, as one line for a tooltip or caption. A
 * connection that is only being established says when the action will be
 * available instead of calling it unavailable; any other refusal keeps its
 * reason.
 */
export function hostedCapabilityCopy(
  capability: Pick<HostedRpcCapability, "kind" | "reason">,
  label: string | null | undefined,
): string | null {
  if (capability.kind === "establishing") {
    return `Available when ${label || UNNAMED_NODE} is connected`;
  }
  return capability.reason;
}

/** The caption while a node's connection is being established. */
export function hostedSyncingCopy(label: string | null | undefined): string {
  return `Syncing with ${label || UNNAMED_NODE}…`;
}

/** The caption while the routed node waits for one of the limited connection slots. */
export function hostedQueuedCopy(label: string | null | undefined): string {
  return `Waiting for a free connection to ${label || UNNAMED_NODE}…`;
}

/** When a send that waits for a node's connection goes out. */
export function hostedSendsWhenReadyCopy(label: string | null | undefined): string {
  return `Sends when ${label || UNNAMED_NODE} is ready`;
}

/** Why a queued send cannot go out: the user's role on the node does not allow it. */
export function hostedRoleRefusesSendCopy(label: string | null | undefined): string {
  return `Can't send — your role on ${label || UNNAMED_NODE} doesn't allow it`;
}
