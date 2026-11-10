/**
 * desktopHubSession - the Mac app's account session socket (docs/hub-session-protocol.md,
 * "Native sessions"): one DPoP-authenticated WebSocket from the main process to the Hub that
 * carries a logical stream per machine instead of a TLS socket of its own per machine, and pushes
 * `invalidate` when the machine list changes, so the catalog is re-read on change.
 *
 * Open while the workspace is signed in, the Hub announced the native session in its last
 * directory answer and the workspace is not backgrounded; kept in the background only while a
 * machine channel still rides it. An older Hub announces nothing and this never opens: machine
 * channels then keep their own sockets exactly as before. The rules are shared with the phone
 * (`@ryco/client-runtime/relay/nativeHubSessionManager`); each machine's channel still
 * authenticates with its own ticket and runs its own E2EE.
 *
 * @module desktopHubSession
 */
import { HUB_NATIVE_SESSION_FEATURE } from "@ryco/client-runtime/authorization";
import { HostedHubSession } from "@ryco/client-runtime/relay";
import {
  createDeferredHubSessionSocket,
  type EventWebSocketLike,
} from "@ryco/client-runtime/relay/deferredHubSessionSocket";
import {
  createHubSessionManager,
  type HubSessionManager,
} from "@ryco/client-runtime/relay/nativeHubSessionManager";
import WebSocket from "ws";

/** What the session needs of the hosted identity coordinator. */
export interface DesktopHubSessionIdentity {
  hubFeatures(): ReadonlyArray<string>;
  subscribeHubFeatures(listener: () => void): () => void;
  hubSessionUrl(): string;
  authorizeRelayUpgrade(url: string): Promise<Readonly<Record<string, string>>>;
}

export interface DesktopHubSession {
  readonly manager: HubSessionManager;
  /** Re-check whether the session is wanted (sign-in state, backgrounding). */
  readonly sync: () => void;
  readonly stop: () => void;
}

function openSessionSocket(
  url: string,
  protocols: readonly string[],
  headers: Readonly<Record<string, string>>,
): EventWebSocketLike {
  return new WebSocket(url, [...protocols], { headers }) as unknown as EventWebSocketLike;
}

export function startDesktopHubSession(input: {
  readonly identity: DesktopHubSessionIdentity;
  /** The signed-in account, or null. */
  readonly authority: () => string | null;
  readonly isForeground: () => boolean;
  readonly onDirectoryInvalidated: () => void;
  readonly revalidateSession: () => Promise<unknown> | void;
  /** Test seam: the platform socket. */
  readonly openSocket?: typeof openSessionSocket;
}): DesktopHubSession {
  const openSocket = input.openSocket ?? openSessionSocket;
  const manager = createHubSessionManager({
    authority: input.authority,
    announced: () => input.identity.hubFeatures().includes(HUB_NATIVE_SESSION_FEATURE),
    isForeground: input.isForeground,
    create: (events) => {
      const url = input.identity.hubSessionUrl();
      return new HostedHubSession({
        createSocket: (protocols) =>
          createDeferredHubSessionSocket(async () =>
            openSocket(url, protocols, await input.identity.authorizeRelayUpgrade(url)),
          ),
        timers: {
          now: Date.now,
          setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
          clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
          queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
        },
        onStatus: events.onStatus,
        onInvalidate: (event) => {
          if (event.directory) events.onDirectoryInvalidated();
        },
        onFailure: events.onFailure,
      });
    },
    onDirectoryInvalidated: input.onDirectoryInvalidated,
    revalidateSession: input.revalidateSession,
    now: Date.now,
  });
  const unsubscribe = input.identity.subscribeHubFeatures(manager.sync);
  manager.sync();
  return {
    manager,
    sync: manager.sync,
    stop: () => {
      unsubscribe();
      manager.dispose();
    },
  };
}
