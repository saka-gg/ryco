import {
  configureHostedEnvironmentSessions,
  configureHostedRuntime,
  hostedHubStore,
  type HostedEnvironmentSessionsMode,
  type HostedHubApi,
  type HostedNodeLifecycle,
  type HostedRuntimeTimers,
} from "@ryco/client-runtime/authorization";

import { writePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  connectHostedEnvironment,
  connectPrimaryEnvironment,
  disconnectPrimaryEnvironment,
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

/**
 * Whether hosted Web keeps one session, and one connection, per environment.
 * Turns on together with MAX_HOSTED_WEB_CONNECTIONS > 1, in the change that
 * records the warm-set qualification.
 */
export const HOSTED_WEB_RETAINED_ENVIRONMENT_SESSIONS = false;

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
 * `environmentSessions` is a test seam; production follows
 * {@link HOSTED_WEB_RETAINED_ENVIRONMENT_SESSIONS}.
 */
export function configureWebHostedRuntime(
  api: HostedHubApi,
  options?: { readonly environmentSessions?: HostedEnvironmentSessionsMode },
): void {
  if (configured) return;
  configured = true;
  const environmentSessions =
    options?.environmentSessions ??
    (HOSTED_WEB_RETAINED_ENVIRONMENT_SESSIONS ? "retained" : "single");
  // docs/relay-e2ee-protocol.md §12.1: the in-memory latch ends with the
  // application session, and a sign-out is where this tier's session ends.
  watchWebHostedSessionForE2ee();
  displayWebE2eeForSelectedNode();
  const nodeLifecycle: HostedNodeLifecycle = {
    activate: async () => undefined,
    suspend: async () => undefined,
    deactivate: async () => undefined,
    clearNodeScopedState: clearWebHostedNodeScopedState,
    writePrimaryEnvironmentDescriptor,
    connectPrimaryEnvironment,
    disconnectPrimaryEnvironment,
    setActiveEnvironmentId: (environmentId) =>
      useStore.getState().setActiveEnvironmentId(environmentId),
  };
  if (environmentSessions === "retained") {
    configureHostedEnvironmentSessions({
      now: webHostedTimers.now,
      setTimeout: webHostedTimers.setTimeout,
      clearTimeout: (timer) => webHostedTimers.clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
  }
  configureHostedRuntime(
    {
      endpoint: webEndpoint,
      httpClient: webHttpClient,
      passkeyCeremony: webPasskeyCeremony,
      sessionCredentials: webSessionCredentials,
      // With retained sessions every environment's connection belongs to the
      // lifecycle owner's ports below, each for one record generation, and the
      // workspace coordinator alone decides when to acquire and release.
      nodeLifecycle:
        environmentSessions === "retained"
          ? {
              ...nodeLifecycle,
              disconnectPrimaryEnvironment: async () => undefined,
              connectEnvironment: connectHostedEnvironment,
              releaseEnvironment: removeHostedEnvironment,
              suspendEnvironment: suspendHostedEnvironment,
              requestEnvironmentReconcile: requestHostedWorkspaceReconcile,
            }
          : nodeLifecycle,
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
