import {
  configureHostedEnvironmentSessions,
  configureHostedRuntime,
  hostedHubStore,
  type HostedHubApi,
  type HostedNodeLifecycle,
  type HostedRuntimeTimers,
} from "@ryco/client-runtime/authorization";

import { writePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  connectHostedEnvironment,
  removeHostedEnvironment,
  suspendHostedEnvironment,
} from "../environments/runtime/service";
import { useStore } from "../store";
import { webEndpoint } from "../platform/endpoint";
import { webHttpClient } from "../platform/httpClient";
import { webPasskeyCeremony } from "../platform/passkeyCeremony";
import { webSessionCredentials } from "../platform/sessionCredentials";
import {
  prepareWebRelayE2ee,
  watchWebHostedSessionForE2ee,
  type WebRelayE2eeTarget,
} from "./e2eeAttempt";
import { setDisplayedWebE2eeEnvironment } from "./e2eeSession";
import { clearWebHostedNodeScopedState } from "./environment";
import { requestHostedWorkspaceReconcile } from "./hostedConnectionCoordinator";
import {
  createWebHostedRelaySocket,
  createWebHostedServerAuthenticatedRelaySocket,
  hasHostedRelayPendingRequests,
  resetHostedRelayAttemptFactory,
} from "./transport";
import { hostedRelayWebSocketUrl } from "./relaySocket";

import {
  isWebHubServerAuthenticatedRelayAvailable,
  isWebHubSessionOnline,
  probeWebHubSession,
  watchWebHostedHubSession,
} from "./hubSession";
import { subscribeWebForeground } from "./foreground";

let configured = false;

/**
 * The node and environment a relay channel's E2EE attempt is resolved for:
 * the channel's own node, as the transport names it, and that node's
 * environment from the directory. `null` when the node is not in the
 * directory, which closes the channel retryably rather than resolving it
 * against another node.
 */
function relayE2eeTarget(nodeId: string | undefined): WebRelayE2eeTarget | null {
  if (nodeId === undefined) return null;
  const node = hostedHubStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  return node === undefined ? null : { nodeId, environmentId: node.environmentId };
}

/** The session-wide E2EE surfaces show the selected node's channel and no other. */
function displayWebE2eeForSelectedNode(): void {
  const selectedEnvironment = () => hostedHubStore.getState().selectedNode?.environmentId ?? null;
  setDisplayedWebE2eeEnvironment(selectedEnvironment());
  hostedHubStore.subscribe(() => setDisplayedWebE2eeEnvironment(selectedEnvironment()));
}

const webHostedTimers: HostedRuntimeTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
};

/**
 * Hosted Web keeps one session, and one connection, per environment: a warm
 * set of up to MAX_HOSTED_WEB_CONNECTIONS environments, each with its own
 * relay attempt and accepted snapshot. There is no other mode to select;
 * `environmentSessions` only lets a caller name this one.
 */
export function configureWebHostedRuntime(
  api: HostedHubApi,
  options?: { readonly environmentSessions?: "retained" },
): void {
  if (configured) return;
  configured = true;
  const environmentSessions = options?.environmentSessions ?? "retained";
  // docs/relay-e2ee-protocol.md §12.1: the in-memory latch ends with the
  // application session, and a sign-out is where this tier's session ends.
  watchWebHostedSessionForE2ee();
  displayWebE2eeForSelectedNode();
  // Every environment's connection belongs to the lifecycle owner's ports for
  // one record generation (`connectEnvironment`, `releaseEnvironment`,
  // `suspendEnvironment`), and the workspace coordinator alone decides when to
  // acquire and release. Nothing connects on the primary path: it would be a
  // second hosted connection constructor outside the cap and those fences.
  const nodeLifecycle: HostedNodeLifecycle = {
    activate: async () => undefined,
    suspend: async () => undefined,
    deactivate: async () => undefined,
    clearNodeScopedState: clearWebHostedNodeScopedState,
    writePrimaryEnvironmentDescriptor,
    connectPrimaryEnvironment: () => undefined,
    disconnectPrimaryEnvironment: async () => undefined,
    setActiveEnvironmentId: (environmentId) =>
      useStore.getState().setActiveEnvironmentId(environmentId),
    connectEnvironment: connectHostedEnvironment,
    releaseEnvironment: removeHostedEnvironment,
    suspendEnvironment: suspendHostedEnvironment,
    requestEnvironmentReconcile: requestHostedWorkspaceReconcile,
  };
  configureHostedEnvironmentSessions({
    now: webHostedTimers.now,
    setTimeout: webHostedTimers.setTimeout,
    clearTimeout: (timer) => webHostedTimers.clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  configureHostedRuntime(
    {
      endpoint: webEndpoint,
      httpClient: webHttpClient,
      passkeyCeremony: webPasskeyCeremony,
      sessionCredentials: webSessionCredentials,
      nodeLifecycle,
      environmentSessions,
      timers: webHostedTimers,
      isForeground: () => globalThis.document?.visibilityState !== "hidden",
      subscribeForeground: subscribeWebForeground,
      hasPendingRelayRequests: hasHostedRelayPendingRequests,
      hasLiveHubSubscription: isWebHubSessionOnline,
      probeHubSubscription: probeWebHubSession,
      resetRelayAttemptFactory: resetHostedRelayAttemptFactory,
      relayUrl: hostedRelayWebSocketUrl,
      // The handshake code is loaded off the boot path (see `loadWebRelayE2ee`);
      // the transport awaits this before buying a ticket, so the synchronous
      // provider below always finds it.
      prepareRelaySocketContext: prepareWebRelayE2ee,
      // docs/relay-e2ee-protocol.md §4: THIS IS WHERE THE WEB TIER'S NX CHANNEL
      // IS ON — and it is on with a bounded claim, not the native one.
      //
      // Every relay channel this app opens is built with the §4.4 mode machine,
      // and the guards it consults are resolved inside this synchronous call, as
      // §4.4 requires ("before it has received any payload").
      // `resolveWebRelayE2eeProvider` returns `undefined` in exactly one case,
      // §14.5's absent CSPRNG or non-secure context, which simply has no E2EE;
      // everything else is either the machine or a channel that fails closed.
      //
      // WHAT IT DOES NOT BUY IS THE POINT. §2.2 and §2.3: the Hub serves every
      // byte of the JavaScript that implements this, so a malicious Hub can
      // exfiltrate plaintext while completing a genuine handshake and drawing a
      // genuine §13.5 code. This line raises the bar against accidental
      // wrong-node routing and some non-Hub network interposition, and against
      // nothing else.
      //
      // Each channel's attempt is resolved for the node it is opened to, and
      // publishes into that node's environment — never the selected one's.
      createRelaySocket: (input) =>
        createWebHostedRelaySocket(input, relayE2eeTarget(input.nodeId)),
      // Hub session version 2: the Hub mints and consumes the node ticket for the account
      // session itself, so the channel skips the HTTP ticket round trip and this tier never
      // holds a ticket. The channel is otherwise the one above, E2EE machine included.
      serverAuthenticatedRelayAvailable: isWebHubServerAuthenticatedRelayAvailable,
      createServerAuthenticatedRelaySocket: (input) =>
        createWebHostedServerAuthenticatedRelaySocket(input, relayE2eeTarget(input.nodeId)),
    },
    api,
  );
  watchWebHostedHubSession();
}
