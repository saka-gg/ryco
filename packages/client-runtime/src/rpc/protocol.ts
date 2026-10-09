import { WsDeviceRpcGroup, WsHostedRpcGroup, WsRpcGroup } from "@ryco/contracts";
import type { EnvironmentId } from "@ryco/contracts";
import { Data, Duration, Effect, Layer, Schedule } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import type { SocketService } from "../platform/index.ts";
import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState.ts";
import {
  getPersistentWsReconnectDelayMs,
  getWsReconnectDelayMsForRetry,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  type WsConnectionMetadata,
  WS_RECONNECT_MAX_RETRIES,
} from "./wsConnectionState.ts";

export interface WsProtocolCloseContext {
  readonly intentional: boolean;
}

export interface WsProtocolLifecycleHandlers {
  readonly getConnectionLabel?: () => string | null;
  /** The environment this socket serves; records status into its keyed slot too. */
  readonly getEnvironmentId?: () => EnvironmentId | null;
  readonly getVersionMismatchHint?: () => string | null;
  readonly isCloseIntentional?: () => boolean;
  readonly isActive?: () => boolean;
  /** Reject lifecycle events emitted late by a superseded socket in the same transport session. */
  readonly isSocketCurrent?: (socket: globalThis.WebSocket) => boolean;
  /** Reset attempt-scoped policy when an explicit transport session is created. */
  readonly onSessionStart?: () => void;
  readonly onDispose?: () => void;
  readonly onAttempt?: (socketUrl: string) => void;
  readonly onOpen?: () => void;
  readonly onHeartbeatPing?: () => void;
  readonly onHeartbeatPong?: () => void;
  readonly onHeartbeatTimeout?: () => void;
  readonly onRequestStart?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestChunk?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly chunkCount: number;
  }) => void;
  readonly onRequestExit?: (info: {
    readonly id: string;
    readonly tag: string;
    readonly stream: boolean;
  }) => void;
  readonly onRequestInterrupt?: (info: { readonly id: string; readonly tag?: string }) => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: (
    details: { readonly code: number; readonly reason: string },
    context: WsProtocolCloseContext,
  ) => void;
  readonly webSocketConstructor?: (
    url: string,
    protocols?: string | ReadonlyArray<string>,
  ) => globalThis.WebSocket;
  readonly retryTransientErrors?: boolean;
  readonly reconnectMaxRetries?: number;
  readonly getReconnectDelayMs?: (retryCount: number) => number;
  readonly preserveSocketPath?: boolean;
  readonly shouldReconnect?: () => boolean;
  /**
   * Retry forever with a capped backoff rather than giving up after
   * `WS_RECONNECT_MAX_RETRIES`. For a saved remote environment, which nothing
   * else would ever reconnect once its schedule ran out.
   */
  readonly persistentReconnect?: boolean;
  /**
   * Marks a URL provider failure that no retry can fix, such as a saved
   * credential the server rejected. The socket then stops reconnecting and every
   * pending request fails, instead of waiting on a schedule that never succeeds.
   */
  readonly isTerminalUrlError?: (error: unknown) => boolean;
  /** Runs once when a terminal URL provider failure stopped this socket. */
  readonly onTerminalUrlError?: (error: unknown) => void;
  /**
   * `false` keeps this socket's status out of the global status, which the app
   * reads as its primary connection's. Its environment slot is still written.
   */
  readonly recordGlobalConnectionState?: boolean;
  readonly authorizeRequest?: (info: {
    readonly tag: string;
    readonly stream: boolean;
  }) => RpcRequestAdmission;
  /** Wake subscriptions when the authoritative connection admission state changes. */
  readonly subscribeAdmissionChanges?: (listener: () => void) => () => void;
  /** Secondary feature channels must not replace the app's primary status. */
  readonly recordConnectionState?: boolean;
}

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
export type WsRpcProtocolSocketUrlProvider = string | (() => Promise<string>);

export const makeDeviceRpcProtocolClient = RpcClient.make(WsDeviceRpcGroup);
type DeviceRpcClientFactory = typeof makeDeviceRpcProtocolClient;
export type DeviceRpcProtocolClient =
  DeviceRpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

export const makeHostedRpcProtocolClient = RpcClient.make(WsHostedRpcGroup);
type HostedRpcClientFactory = typeof makeHostedRpcProtocolClient;
export type HostedRpcProtocolClient =
  HostedRpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

const WS_URL_PROVIDER_ERROR_MESSAGE = "Unable to prepare the Ryco server WebSocket connection.";
export const WS_CONNECTION_ERROR_MESSAGE = "Unable to connect to the Ryco server WebSocket.";

class WsUrlProviderError extends Data.TaggedError("WsUrlProviderError")<{
  readonly cause: unknown;
}> {}

class WsUrlProviderInactiveError extends Data.TaggedError("WsUrlProviderInactiveError") {}

/**
 * Whether a connection admits a request right now. Both `awaiting-` answers
 * mean only "not yet", and the same request will be admitted on this
 * connection later: `awaiting-session` while its session is still being
 * established or recovered, `awaiting-acknowledgement` while a current session
 * holds mutations until the user has seen that an earlier action could not be
 * confirmed. A `forbidden` request will not be admitted on this connection at
 * all.
 */
export type RpcRequestAdmission =
  | "allowed"
  | "awaiting-session"
  | "awaiting-acknowledgement"
  | "forbidden";

const REFUSAL_MESSAGES: Record<Exclude<RpcRequestAdmission, "allowed">, string> = {
  "awaiting-session": "Ryco is still synchronizing with this machine. Try again in a moment.",
  "awaiting-acknowledgement":
    "Ryco couldn't confirm an earlier action on this machine. Check its result, then choose Continue in the thread's notice.",
  forbidden: "This action is unavailable for the current hosted role.",
};

/**
 * A request this client refused before sending it (`authorizeRequest`).
 * Nothing reached the server, so the request certainly did not run there.
 */
export class RpcRequestRefusedError extends Error {
  readonly admission: Exclude<RpcRequestAdmission, "allowed">;

  constructor(admission: Exclude<RpcRequestAdmission, "allowed">) {
    super(REFUSAL_MESSAGES[admission]);
    this.name = "RpcRequestRefusedError";
    this.admission = admission;
  }
}

/** A refusal only for now: the same request will be admitted on its connection later. */
export function isAwaitingAdmission(error: unknown): error is RpcRequestRefusedError {
  return error instanceof RpcRequestRefusedError && error.admission !== "forbidden";
}

function resolveWsRpcSocketUrl(rawUrl: string, preservePath = false): string {
  const resolved = new URL(rawUrl);
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error(`Unsupported websocket transport URL protocol: ${resolved.protocol}`);
  }

  if (!preservePath) resolved.pathname = "/ws";
  return resolved.toString();
}

function resolveConnectionMetadata(handlers?: WsProtocolLifecycleHandlers): WsConnectionMetadata {
  return {
    connectionLabel: handlers?.getConnectionLabel?.() ?? null,
    environmentId: handlers?.getEnvironmentId?.() ?? null,
    versionMismatchHint: handlers?.getVersionMismatchHint?.() ?? null,
    ...(handlers?.recordGlobalConnectionState === false ? { recordGlobal: false } : {}),
    ...(handlers?.persistentReconnect === true ? { persistentReconnect: true } : {}),
  };
}

type ComposedWsProtocolLifecycleHandlers = Required<
  Pick<WsProtocolLifecycleHandlers, "isActive" | "onAttempt" | "onOpen" | "onError" | "onClose">
>;

function defaultLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): ComposedWsProtocolLifecycleHandlers {
  return {
    isActive: () => true,
    onAttempt: (socketUrl) => {
      if (handlers?.recordConnectionState !== false) {
        recordWsConnectionAttempt(socketUrl, resolveConnectionMetadata(handlers));
      }
    },
    onOpen: () => {
      if (handlers?.recordConnectionState !== false) {
        recordWsConnectionOpened(resolveConnectionMetadata(handlers));
      }
    },
    onError: (message) => {
      if (handlers?.recordConnectionState !== false) {
        clearAllTrackedRpcRequests();
        recordWsConnectionErrored(message, resolveConnectionMetadata(handlers));
      }
    },
    onClose: (details, context) => {
      if (handlers?.recordConnectionState !== false) clearAllTrackedRpcRequests();
      if (context.intentional) {
        return;
      }
      if (handlers?.recordConnectionState !== false) {
        recordWsConnectionClosed(details, resolveConnectionMetadata(handlers));
      }
    },
  };
}

function composeLifecycleHandlers(
  handlers?: WsProtocolLifecycleHandlers,
): ComposedWsProtocolLifecycleHandlers {
  const defaults = defaultLifecycleHandlers(handlers);
  const isActive = handlers?.isActive ?? defaults.isActive;

  return {
    isActive,
    onAttempt: (socketUrl) => {
      if (!isActive()) {
        return;
      }
      defaults.onAttempt(socketUrl);
      handlers?.onAttempt?.(socketUrl);
    },
    onOpen: () => {
      if (!isActive()) {
        return;
      }
      defaults.onOpen();
      handlers?.onOpen?.();
    },
    onError: (message) => {
      if (!isActive()) {
        return;
      }
      defaults.onError(message);
      handlers?.onError?.(message);
    },
    onClose: (details, context) => {
      if (!isActive()) {
        return;
      }
      defaults.onClose(details, context);
      handlers?.onClose?.(details, context);
    },
  };
}

export function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  socketService: SocketService,
  handlers?: WsProtocolLifecycleHandlers,
) {
  const lifecycle = composeLifecycleHandlers(handlers);
  const persistent = handlers?.persistentReconnect === true;
  const retryPolicy = Schedule.addDelay(
    Schedule.recurs(
      handlers?.reconnectMaxRetries ??
        (persistent ? Number.MAX_SAFE_INTEGER : WS_RECONNECT_MAX_RETRIES),
    ),
    ({ output: retryCount }) =>
      Effect.succeed(
        Duration.millis(
          handlers?.getReconnectDelayMs?.(retryCount) ??
            (persistent
              ? getPersistentWsReconnectDelayMs(retryCount)
              : getWsReconnectDelayMsForRetry(retryCount)) ??
            getPersistentWsReconnectDelayMs(retryCount),
        ),
      ),
  ).pipe(Schedule.while(() => lifecycle.isActive() && (handlers?.shouldReconnect?.() ?? true)));
  const isTerminalUrlError = (error: WsUrlProviderError) =>
    handlers?.isTerminalUrlError?.(error.cause) === true;
  const resolvedUrl =
    typeof url === "function"
      ? Effect.tryPromise({
          try: () => {
            if (!lifecycle.isActive()) throw new WsUrlProviderInactiveError();
            return url();
          },
          catch: (cause) => new WsUrlProviderError({ cause }),
        }).pipe(
          Effect.map((rawUrl) => resolveWsRpcSocketUrl(rawUrl, handlers?.preserveSocketPath)),
          Effect.tapError(() =>
            Effect.sync(() => {
              lifecycle.onError(WS_URL_PROVIDER_ERROR_MESSAGE);
            }),
          ),
          Effect.retry({ schedule: retryPolicy, while: (error) => !isTerminalUrlError(error) }),
          // Dying fails every pending request through the protocol's error
          // broadcast and ends the socket's reconnect loop.
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (isTerminalUrlError(error) && lifecycle.isActive()) {
                handlers?.onTerminalUrlError?.(error.cause);
              }
            }),
          ),
          Effect.orDie,
        )
      : resolveWsRpcSocketUrl(url, handlers?.preserveSocketPath);

  const trackingWebSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      lifecycle.onAttempt(socketUrl);
      const socket = handlers?.webSocketConstructor
        ? handlers.webSocketConstructor(socketUrl, protocols)
        : // SocketService is intentionally platform-neutral; Effect's browser seam requires this bridge.
          (socketService.webSocketConstructor(socketUrl, protocols) as globalThis.WebSocket);

      socket.addEventListener(
        "open",
        () => {
          if (handlers?.isSocketCurrent?.(socket) === false) return;
          lifecycle.onOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          if (handlers?.isSocketCurrent?.(socket) === false) return;
          lifecycle.onError(WS_CONNECTION_ERROR_MESSAGE);
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          if (handlers?.isSocketCurrent?.(socket) === false) return;
          lifecycle.onClose(
            {
              code: event.code,
              reason: event.reason,
            },
            {
              intentional: handlers?.isCloseIntentional?.() ?? false,
            },
          );
        },
        { once: true },
      );

      return socket;
    },
  );
  const socketLayer = Socket.layerWebSocket(resolvedUrl).pipe(
    Layer.provide(trackingWebSocketConstructorLayer),
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    Effect.map(
      RpcClient.makeProtocolSocket({
        retryPolicy,
        retryTransientErrors: handlers?.retryTransientErrors ?? true,
      }),
      (protocol) => ({
        ...protocol,
        run: (clientId, writeResponse) =>
          protocol.run(clientId, (response) => {
            if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
              clearAllTrackedRpcRequests();
            }
            return writeResponse(response);
          }),
      }),
    ),
  );
  const requestHooksLayer = Layer.succeed(
    RpcClient.RequestHooks,
    RpcClient.RequestHooks.of({
      onRequestStart: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          const admission = handlers?.authorizeRequest?.(info) ?? "allowed";
          if (admission !== "allowed") throw new RpcRequestRefusedError(admission);
          handlers?.onRequestStart?.({
            id: String(info.id),
            tag: info.tag,
            stream: info.stream,
          });
          trackRpcRequestSent(String(info.id), info.tag);
        }),
      onRequestChunk: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestChunk?.({
            id: String(info.id),
            tag: info.tag,
            chunkCount: info.chunkCount,
          });
          acknowledgeRpcRequest(String(info.id));
        }),
      onRequestExit: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestExit?.({
            id: String(info.id),
            tag: info.tag,
            stream: info.stream,
          });
          acknowledgeRpcRequest(String(info.id));
        }),
      onRequestInterrupt: (info) =>
        Effect.sync(() => {
          if (!lifecycle.isActive()) {
            return;
          }
          handlers?.onRequestInterrupt?.({
            id: String(info.id),
            ...(info.tag === undefined ? {} : { tag: info.tag }),
          });
          acknowledgeRpcRequest(String(info.id));
        }),
    }),
  );
  const connectionHooksLayer = Layer.succeed(
    RpcClient.ConnectionHooks,
    RpcClient.ConnectionHooks.of({
      onConnect: Effect.void,
      onDisconnect: Effect.void,
      onPing: Effect.sync(() => {
        if (lifecycle.isActive()) {
          handlers?.onHeartbeatPing?.();
        }
      }),
      onPong: Effect.sync(() => {
        if (lifecycle.isActive()) {
          handlers?.onHeartbeatPong?.();
        }
      }),
      onPingTimeout: Effect.sync(() => {
        if (lifecycle.isActive()) {
          clearAllTrackedRpcRequests();
          recordWsConnectionErrored(
            "WebSocket heartbeat timed out.",
            resolveConnectionMetadata(handlers),
          );
          handlers?.onHeartbeatTimeout?.();
        }
      }),
    }),
  );

  return Layer.mergeAll(
    protocolLayer.pipe(
      Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson, connectionHooksLayer)),
    ),
    requestHooksLayer,
    connectionHooksLayer,
  );
}
