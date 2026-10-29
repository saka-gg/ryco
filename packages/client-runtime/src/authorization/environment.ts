import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@ryco/contracts";

import { getHostedDispatchReplay } from "../relay/dispatchReplay.ts";
import {
  getHostedRuntimeConfiguration,
  type HostedEnvironmentReconcileRequest,
  type HostedNodeLifecycle,
} from "./runtime.ts";
import type { HostedHubNode } from "./types.ts";

/**
 * A placeholder for the selected node, built from its directory entry until
 * the node's own config arrives. Its thread settlement flag is only what the
 * directory states; the inbox never reads it, since each environment's thread
 * capabilities come from `resolveEnvironmentThreadCapabilities`, which treats
 * an environment the node has not answered for as unknown.
 */
function descriptorForNode(node: HostedHubNode): ExecutionEnvironmentDescriptor {
  return {
    environmentId: node.environmentId,
    label: node.label,
    platform: { os: node.platformOs, arch: node.platformArch },
    serverVersion: node.clientVersion,
    capabilities: {
      repositoryIdentity: false,
      threadSettlement: node.capabilities?.threadSettlement === true,
      threadPriorityRanking: false,
    },
  };
}

export function clearHostedNodeScopedState(environmentId: EnvironmentId): void {
  getHostedRuntimeConfiguration().nodeLifecycle.clearNodeScopedState(environmentId);
}

let activeHostedEnvironmentId: EnvironmentId | null = null;
let hostedTransportSuspended = false;
let transition: Promise<void> = Promise.resolve();

function enqueueTransition(work: () => Promise<void>): Promise<void> {
  const next = transition.catch(() => undefined).then(work);
  transition = next.catch(() => undefined);
  return next;
}

async function deactivateCurrentHostedNode(environmentId: EnvironmentId): Promise<void> {
  const lifecycle = getHostedRuntimeConfiguration().nodeLifecycle;
  // The core transition queue is the one owner of reset: clearAccount only asks
  // this queue to deactivate and must not reset the attempt factory independently.
  getHostedRuntimeConfiguration().resetRelayAttemptFactory();
  // Leaving the node — a switch, the directory, or sign-out — ends any command
  // waiting to replay there, and any still in flight that the disconnect below
  // cuts off, even if the node is selected again. A reconnect to it does not.
  getHostedDispatchReplay().end(environmentId);
  await lifecycle.disconnectPrimaryEnvironment();
  clearHostedNodeScopedState(environmentId);
  lifecycle.writePrimaryEnvironmentDescriptor(null);
  if (activeHostedEnvironmentId === environmentId) activeHostedEnvironmentId = null;
  hostedTransportSuspended = false;
}

export async function deactivateHostedNode(environmentId: EnvironmentId): Promise<void> {
  await enqueueTransition(async () => {
    await deactivateCurrentHostedNode(activeHostedEnvironmentId ?? environmentId);
  });
}

export async function suspendHostedNode(environmentId: EnvironmentId): Promise<void> {
  await enqueueTransition(async () => {
    const activeEnvironmentId = activeHostedEnvironmentId ?? environmentId;
    if (activeEnvironmentId !== environmentId || hostedTransportSuspended) return;
    hostedTransportSuspended = true;
    getHostedRuntimeConfiguration().resetRelayAttemptFactory();
    await getHostedRuntimeConfiguration().nodeLifecycle.disconnectPrimaryEnvironment();
  });
}

export async function activateHostedNode(
  node: HostedHubNode,
  previousEnvironmentId: EnvironmentId | null,
  signal?: AbortSignal,
): Promise<void> {
  await enqueueTransition(async () => {
    if (signal?.aborted) return;
    const previous = activeHostedEnvironmentId ?? previousEnvironmentId;
    if (previous === node.environmentId) {
      if (!hostedTransportSuspended) {
        getHostedRuntimeConfiguration().resetRelayAttemptFactory();
        await getHostedRuntimeConfiguration().nodeLifecycle.disconnectPrimaryEnvironment();
      }
      if (signal?.aborted) return;
    } else if (previous) {
      await deactivateCurrentHostedNode(previous);
      if (signal?.aborted) return;
    }
    const lifecycle = getHostedRuntimeConfiguration().nodeLifecycle;
    lifecycle.writePrimaryEnvironmentDescriptor(descriptorForNode(node));
    lifecycle.setActiveEnvironmentId(node.environmentId);
    activeHostedEnvironmentId = node.environmentId;
    hostedTransportSuspended = false;
    lifecycle.connectPrimaryEnvironment();
  });
}

// Retained environment sessions. The selection only moves which environment
// the shell shows; every environment keeps its own connection, created,
// suspended and released through the lifecycle ports below on its own
// transition queue. Work for one environment waits only for that
// environment's earlier work, never for another environment's.

/** A lifecycle that implements every port retained environment sessions use. */
export type RetainedHostedNodeLifecycle = HostedNodeLifecycle &
  Required<
    Pick<
      HostedNodeLifecycle,
      | "connectEnvironment"
      | "releaseEnvironment"
      | "suspendEnvironment"
      | "requestEnvironmentReconcile"
    >
  >;

function implementsRetainedPorts(
  lifecycle: HostedNodeLifecycle,
): lifecycle is RetainedHostedNodeLifecycle {
  return (
    lifecycle.connectEnvironment !== undefined &&
    lifecycle.releaseEnvironment !== undefined &&
    lifecycle.suspendEnvironment !== undefined &&
    lifecycle.requestEnvironmentReconcile !== undefined
  );
}

/** The configured lifecycle; throws when it lacks a port retained sessions use. */
export function retainedHostedNodeLifecycle(): RetainedHostedNodeLifecycle {
  const lifecycle = getHostedRuntimeConfiguration().nodeLifecycle;
  if (!implementsRetainedPorts(lifecycle)) {
    throw new Error(
      "Retained hosted sessions require the connectEnvironment, releaseEnvironment, suspendEnvironment and requestEnvironmentReconcile lifecycle ports.",
    );
  }
  return lifecycle;
}

const environmentTransitions = new Map<EnvironmentId, Promise<void>>();

/**
 * Run `work` once the environment's earlier transitions have settled — at once
 * when it has none pending, so an idle environment never waits a turn.
 *
 * The entry is registered before `work` starts: a transition that `work`
 * enqueues for the same environment synchronously (a port publishing a change
 * whose listener releases the environment) runs after it, and every later one
 * waits for both.
 */
function enqueueEnvironmentTransition(
  environmentId: EnvironmentId,
  work: () => void | Promise<void>,
): Promise<void> {
  const pending = environmentTransitions.get(environmentId);
  let markSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  environmentTransitions.set(environmentId, settled);
  void settled.then(() => {
    if (environmentTransitions.get(environmentId) === settled) {
      environmentTransitions.delete(environmentId);
    }
  });
  const next =
    pending === undefined ? new Promise<void>((resolve) => resolve(work())) : pending.then(work);
  void next.then(markSettled, markSettled);
  return next;
}

/**
 * Show this environment — or none — as the active one. Synchronous and
 * unqueued: moving the selection never waits for, starts or stops a
 * connection.
 */
export function setActiveHostedEnvironment(node: HostedHubNode | null): void {
  const lifecycle = getHostedRuntimeConfiguration().nodeLifecycle;
  lifecycle.writePrimaryEnvironmentDescriptor(node ? descriptorForNode(node) : null);
  if (node) lifecycle.setActiveEnvironmentId(node.environmentId);
}

/**
 * Open the environment's connection for this session generation, after its
 * earlier transitions. When its turn comes the connection opens only while
 * `isCurrent` still holds: a generation replaced while it waited behind a
 * release or suspension has nothing left to connect.
 */
export function connectHostedEnvironment(
  node: HostedHubNode,
  generation: number,
  isCurrent: () => boolean,
): Promise<void> {
  const lifecycle = retainedHostedNodeLifecycle();
  return enqueueEnvironmentTransition(node.environmentId, () => {
    if (!isCurrent()) return;
    return lifecycle.connectEnvironment(node, generation);
  });
}

/**
 * Remove the environment's connection of this generation or older, ending the
 * commands still waiting to replay there. Its node-scoped state is cleared only
 * when no newer session of the environment exists by then: a quick re-acquire
 * keeps what it has already cached, and its connection opens only after this
 * release anyway.
 */
export function releaseHostedEnvironment(
  environmentId: EnvironmentId,
  generation: number,
  hasNewerRecord: () => boolean,
): Promise<void> {
  const lifecycle = retainedHostedNodeLifecycle();
  return enqueueEnvironmentTransition(environmentId, async () => {
    getHostedDispatchReplay().end(environmentId);
    try {
      await lifecycle.releaseEnvironment(environmentId, generation);
    } finally {
      if (!hasNewerRecord()) clearHostedNodeScopedState(environmentId);
    }
  });
}

/** Dispose the transport of the environment's connection of this generation or older. */
export function suspendHostedEnvironment(
  environmentId: EnvironmentId,
  generation: number,
): Promise<void> {
  const lifecycle = retainedHostedNodeLifecycle();
  return enqueueEnvironmentTransition(environmentId, () =>
    lifecycle.suspendEnvironment(environmentId, generation),
  );
}

/** Ask the platform to re-plan which environments are connected. */
export function requestHostedEnvironmentReconcile(
  request: HostedEnvironmentReconcileRequest,
): void {
  retainedHostedNodeLifecycle().requestEnvironmentReconcile(request);
}
