import {
  hostedHubController,
  type HostedRuntimeConfiguration,
  type HostedServerAuthenticatedRelayInput,
} from "@ryco/client-runtime/authorization";
import type { HostedEnvironmentAttemptPorts } from "@ryco/client-runtime/relay";

import {
  prepareWebRelayE2ee,
  resolveWebRelayE2eeProvider,
  type WebRelayE2eeTarget,
} from "./e2eeAttempt";
import {
  createWebHubRelaySocket,
  createWebHubServerAuthenticatedRelaySocket,
  isWebHubServerAuthenticatedRelayAvailable,
  probeWebHubSession,
} from "./hubSession";
import { BrowserHostedRelaySocket, hostedRelayWebSocketUrl } from "./relaySocket";

export {
  bindHostedDispatchReplay,
  createHostedEnvironmentAttemptFactory,
  getHostedRelayAttemptFactory,
  hasHostedRelayPendingRequests,
  hostedDispatchLineage,
  HostedRelayAttemptFactory,
  resetHostedRelayAttemptFactory,
  ticketFailure,
} from "@ryco/client-runtime/relay";

type HostedRelaySocketInput = Parameters<HostedRuntimeConfiguration["createRelaySocket"]>[0];

/**
 * A ticketed relay channel on the account session, its E2EE attempt resolved
 * for `target`: the channel's own node and the environment it publishes into.
 * `null` closes the channel retryably rather than resolving it against another
 * node (see `resolveWebRelayE2eeProvider`).
 */
export function createWebHostedRelaySocket(
  input: HostedRelaySocketInput,
  target: WebRelayE2eeTarget | null,
): BrowserHostedRelaySocket {
  return new BrowserHostedRelaySocket({
    ...input,
    e2ee: resolveWebRelayE2eeProvider(target),
    createRelaySocket: createWebHubRelaySocket,
  });
}

/**
 * A relay channel the Hub authenticates itself (Hub session version 2), so
 * this tier never holds a ticket. It is otherwise the channel above, E2EE
 * machine included.
 */
export function createWebHostedServerAuthenticatedRelaySocket(
  input: HostedServerAuthenticatedRelayInput,
  target: WebRelayE2eeTarget | null,
): BrowserHostedRelaySocket {
  return new BrowserHostedRelaySocket({
    url: input.url,
    callbacks: input.callbacks,
    relayCompression: input.relayCompression,
    serverAuthenticated: true,
    e2ee: resolveWebRelayE2eeProvider(target),
    createRelaySocket: () =>
      createWebHubServerAuthenticatedRelaySocket({
        nodeId: input.nodeId,
        protocolMinor: input.protocolMinor,
      }),
  });
}

/**
 * How one environment's relay channels are prepared and opened on this tier.
 * Every channel is resolved for the environment it belongs to, never for the
 * selected one, so a channel keeps its own E2EE projection and reconnects
 * whichever node is selected — or none.
 */
export function webHostedEnvironmentAttemptPorts(
  target: WebRelayE2eeTarget,
): HostedEnvironmentAttemptPorts {
  return {
    prepareSocketContext: prepareWebRelayE2ee,
    relayUrl: hostedRelayWebSocketUrl,
    createRelaySocket: (input) => createWebHostedRelaySocket(input, target),
    serverAuthenticatedRelayAvailable: isWebHubServerAuthenticatedRelayAvailable,
    createServerAuthenticatedRelaySocket: (input) =>
      createWebHostedServerAuthenticatedRelaySocket(input, target),
    revalidateSession: () => void hostedHubController.revalidateSession(),
    connectionSuspect: probeWebHubSession,
  };
}
