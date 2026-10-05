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
import { resolveWebRelayE2eeProvider, watchWebHostedSessionForE2ee } from "./e2eeAttempt";
import { clearWebHostedNodeScopedState } from "./environment";
import { hasHostedRelayPendingRequests, resetHostedRelayAttemptFactory } from "./transport";
import { BrowserHostedRelaySocket, hostedRelayWebSocketUrl } from "./relaySocket";

import {
  createWebHubRelaySocket,
  isWebHubSessionOnline,
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
      resetRelayAttemptFactory: resetHostedRelayAttemptFactory,
      relayUrl: hostedRelayWebSocketUrl,
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
    },
    api,
  );
  watchWebHostedHubSession();
}
