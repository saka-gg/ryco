import { configureHostedRuntime, type HostedHubApi } from "@ryco/client-runtime/authorization";

import { writePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  connectPrimaryEnvironment,
  disconnectPrimaryEnvironment,
} from "../environments/runtime/service";
import { useStore } from "../store";
import { webEndpoint } from "../platform/endpoint";
import { webHttpClient } from "../platform/httpClient";
import { webPasskeyCeremony } from "../platform/passkeyCeremony";
import { webSessionCredentials } from "../platform/sessionCredentials";
import {
  prepareWebRelayE2ee,
  resolveWebRelayE2eeProvider,
  watchWebHostedSessionForE2ee,
} from "./e2eeAttempt";
import { clearWebHostedNodeScopedState } from "./environment";
import { hasHostedRelayPendingRequests, resetHostedRelayAttemptFactory } from "./transport";
import { BrowserHostedRelaySocket, hostedRelayWebSocketUrl } from "./relaySocket";

import {
  createWebHubRelaySocket,
  createWebHubServerAuthenticatedRelaySocket,
  isWebHubServerAuthenticatedRelayAvailable,
  isWebHubSessionOnline,
  probeWebHubSession,
  watchWebHostedHubSession,
} from "./hubSession";
import { subscribeWebForeground } from "./foreground";

let configured = false;

export function configureWebHostedRuntime(api: HostedHubApi): void {
  if (configured) return;
  configured = true;
  // docs/relay-e2ee-protocol.md §12.1: the in-memory latch ends with the
  // application session, and a sign-out is where this tier's session ends.
  watchWebHostedSessionForE2ee();
  configureHostedRuntime(
    {
      endpoint: webEndpoint,
      httpClient: webHttpClient,
      passkeyCeremony: webPasskeyCeremony,
      sessionCredentials: webSessionCredentials,
      nodeLifecycle: {
        activate: async () => undefined,
        suspend: async () => undefined,
        deactivate: async () => undefined,
        clearNodeScopedState: clearWebHostedNodeScopedState,
        writePrimaryEnvironmentDescriptor,
        connectPrimaryEnvironment,
        disconnectPrimaryEnvironment,
        setActiveEnvironmentId: (environmentId) =>
          useStore.getState().setActiveEnvironmentId(environmentId),
      },
      timers: {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
        queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
      },
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
      createRelaySocket: (input) =>
        new BrowserHostedRelaySocket({
          ...input,
          e2ee: resolveWebRelayE2eeProvider(),
          createRelaySocket: createWebHubRelaySocket,
        }),
      // Hub session version 2: the Hub mints and consumes the node ticket for the account
      // session itself, so the channel skips the HTTP ticket round trip and this tier never
      // holds a ticket. The channel is otherwise the one above, E2EE machine included.
      serverAuthenticatedRelayAvailable: isWebHubServerAuthenticatedRelayAvailable,
      createServerAuthenticatedRelaySocket: (input) =>
        new BrowserHostedRelaySocket({
          url: input.url,
          callbacks: input.callbacks,
          relayCompression: input.relayCompression,
          serverAuthenticated: true,
          e2ee: resolveWebRelayE2eeProvider(),
          createRelaySocket: () =>
            createWebHubServerAuthenticatedRelaySocket({
              nodeId: input.nodeId,
              protocolMinor: input.protocolMinor,
            }),
        }),
    },
    api,
  );
  watchWebHostedHubSession();
}
