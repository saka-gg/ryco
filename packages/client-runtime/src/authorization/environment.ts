import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@ryco/contracts";

import { getHostedDispatchReplay } from "../relay/dispatchReplay.ts";
import { getHostedRuntimeConfiguration } from "./runtime.ts";
import type { HostedHubNode } from "./types.ts";

function descriptorForNode(node: HostedHubNode): ExecutionEnvironmentDescriptor {
  return {
    environmentId: node.environmentId,
    label: node.label,
    platform: { os: node.platformOs, arch: node.platformArch },
    serverVersion: node.clientVersion,
    capabilities: {
      repositoryIdentity: false,
      threadSettlement: false,
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
