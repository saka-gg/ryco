import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Scope,
  Stream,
} from "effect";
import { RpcClient } from "effect/unstable/rpc";

import type { ObservabilityService, SocketService } from "../platform/index.ts";
import { clearAllTrackedRpcRequests } from "./requestLatencyState.ts";
import {
  createWsRpcProtocolLayer,
  isAwaitingAdmission,
  makeHostedRpcProtocolClient,
  makeDeviceRpcProtocolClient,
  makeWsRpcProtocolClient,
  type DeviceRpcProtocolClient,
  type HostedRpcProtocolClient,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol.ts";
import { isTransportConnectionErrorMessage } from "../errors/transportError.ts";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
  readonly onError?: () => void;
  readonly tag?: string;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
/**
 * Ceiling for re-checking a subscription its connection refused only for now
 * (`isAwaitingAdmission`). Nothing is sent while it waits, so the cost is a
 * local check; the cap bounds how late the stream starts after the connection
 * admits it.
 */
export const AWAITING_SESSION_SUBSCRIPTION_MAX_DELAY_MS = 4_000;
const NOOP: () => void = () => undefined;
export const THREAD_NOT_FOUND_ERROR_RE = /^Thread\s.+\swas not found$/u;
export const SUBSCRIPTION_STREAM_DONE_SCHEMA_ERROR_FRAGMENT = "SchemaError(Expected array";

interface TransportSession<Client> {
  readonly clientPromise: Promise<Client>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

interface StreamRequestStartInfo {
  readonly id: string;
  readonly tag: string;
  readonly stream: boolean;
}

/** A request made on a transport that was already disposed: it was never sent. */
export class RpcTransportDisposedError extends Error {
  constructor() {
    super("Transport disposed");
    this.name = "RpcTransportDisposedError";
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function isRetryableSubscriptionError(message: string): boolean {
  return (
    isTransportConnectionErrorMessage(message) ||
    THREAD_NOT_FOUND_ERROR_RE.test(message.trim()) ||
    message.includes("reconnect to resynchronize")
  );
}

export function isSubscriptionStreamDoneError(message: string): boolean {
  return (
    message.includes(SUBSCRIPTION_STREAM_DONE_SCHEMA_ERROR_FRAGMENT) &&
    message.includes('"_tag":"Done"') &&
    message.includes("~effect/Cause/Done")
  );
}

class RpcTransport<Client> {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly socket: SocketService;
  private readonly observability: ObservabilityService;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private intentionalCloseDepth = 0;
  private reconnectChain: Promise<void> = Promise.resolve();
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession<Client>;
  private lastHeartbeatPongAt = 0;
  private readonly makeClient: () => Effect.Effect<Client, never, RpcClient.Protocol | Scope.Scope>;
  private readonly streamRequestStartListeners = new Set<(info: StreamRequestStartInfo) => void>();

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    platform: { readonly observability: ObservabilityService; readonly socket: SocketService },
    makeClient: () => Effect.Effect<Client, never, RpcClient.Protocol | Scope.Scope>,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    this.url = url;
    this.socket = platform.socket;
    this.observability = platform.observability;
    this.makeClient = makeClient;
    this.lifecycleHandlers = lifecycleHandlers;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: Client) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new RpcTransportDisposedError();
    }

    const session = this.session;
    const client = await session.clientPromise;
    return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  async requestStream<TValue>(
    connect: (client: Client) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new RpcTransportDisposedError();
    }

    const session = this.session;
    const client = await session.clientPromise;
    await session.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Swallow listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: Client) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let hasReceivedValue = false;
    let awaitingSessionRetries = 0;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    let cancelCurrentStream: () => void = NOOP;

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        const session = this.session;
        try {
          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            {
              ...(options?.tag === undefined ? {} : { tag: options.tag }),
              ...(options?.onError === undefined ? {} : { onError: options.onError }),
              ...(hasReceivedValue
                ? {
                    onStarted: () => {
                      try {
                        options?.onResubscribe?.();
                      } catch {
                        // Swallow reconnect hook errors so the stream can recover.
                      }
                    },
                  }
                : {}),
            },
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
              awaitingSessionRetries = 0;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          if (session !== this.session) {
            continue;
          }

          if (isAwaitingAdmission(error)) {
            // Expected while a rebuilt hosted client's session synchronizes;
            // the stream starts once the connection admits it.
            await sleep(
              Math.min(
                Math.max(retryDelayMs, 1) * 2 ** Math.min(awaitingSessionRetries, 16),
                AWAITING_SESSION_SUBSCRIPTION_MAX_DELAY_MS,
              ),
            );
            awaitingSessionRetries += 1;
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (isSubscriptionStreamDoneError(formattedError)) {
            return;
          }
          if (!isRetryableSubscriptionError(formattedError)) {
            try {
              options?.onError?.();
            } catch {
              // Swallow failure-hook errors so diagnostics cannot mask the subscription failure.
            }
            if (options?.onError) {
              console.warn("WebSocket RPC subscription failed");
            } else {
              console.warn("WebSocket RPC subscription failed", {
                error: formattedError,
              });
            }
            return;
          }

          if (!this.hasReportedTransportDisconnect) {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formattedError,
            });
          }
          this.hasReportedTransportDisconnect = true;
          await sleep(retryDelayMs);
        }
      }
    })();

    return () => {
      active = false;
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new RpcTransportDisposedError();
    }

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new RpcTransportDisposedError();
      }

      clearAllTrackedRpcRequests();
      this.lastHeartbeatPongAt = 0;
      const previousSession = this.session;
      this.session = this.createSession();
      await this.closeSession(previousSession);
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  isHeartbeatFresh(maxAgeMs = 15_000): boolean {
    return this.lastHeartbeatPongAt > 0 && Date.now() - this.lastHeartbeatPongAt <= maxAgeMs;
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.closeSession(this.session);
  }

  private closeSession(session: TransportSession<Client>) {
    this.intentionalCloseDepth += 1;
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      this.intentionalCloseDepth -= 1;
      session.runtime.dispose();
    });
  }

  private createSession(): TransportSession<Client> {
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        createWsRpcProtocolLayer(this.url, this.socket, {
          ...this.lifecycleHandlers,
          isActive: () => !this.disposed && this.activeSessionId === sessionId,
          isCloseIntentional: () =>
            this.disposed ||
            this.intentionalCloseDepth > 0 ||
            this.lifecycleHandlers?.isCloseIntentional?.() === true,
          onHeartbeatPong: () => {
            this.lastHeartbeatPongAt = Date.now();
            this.lifecycleHandlers?.onHeartbeatPong?.();
          },
          onRequestStart: (info) => {
            this.lifecycleHandlers?.onRequestStart?.(info);
            if (!info.stream) {
              return;
            }
            for (const listener of this.streamRequestStartListeners) {
              listener(info);
            }
          },
        }),
        this.observability.tracingLayer,
      ),
    );
    const clientScope = runtime.runSync(Scope.make());
    return {
      runtime,
      clientScope,
      clientPromise: runtime.runPromise(Scope.provide(clientScope)(this.makeClient())),
    };
  }

  private runStreamOnSession<TValue>(
    session: TransportSession<Client>,
    connect: (client: Client) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    requestStart: {
      readonly tag?: string;
      readonly onStarted?: () => void;
      readonly onError?: () => void;
    },
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    let requestStartListener: ((info: StreamRequestStartInfo) => void) | null = null;
    if (requestStart.onStarted) {
      requestStartListener = (info) => {
        if (!isActive() || !info.stream) {
          return;
        }
        if (requestStart.tag !== undefined && info.tag !== requestStart.tag) {
          return;
        }
        requestStart.onStarted?.();
        if (requestStartListener) {
          this.streamRequestStartListeners.delete(requestStartListener);
          requestStartListener = null;
        }
      };
      this.streamRequestStartListeners.add(requestStartListener);
    }
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              if (requestStart.tag) {
                this.observability.recordPerformance(`web.ws.stream.${requestStart.tag}`, value);
              }
              try {
                listener(value);
              } catch {
                try {
                  requestStart.onError?.();
                } catch {
                  // Swallow failure-hook errors so the stream stays live.
                }
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          if (requestStartListener) {
            this.streamRequestStartListeners.delete(requestStartListener);
            requestStartListener = null;
          }
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    return {
      cancel,
      completed,
    };
  }
}

/** The main application RPC transport. */
export class WsTransport extends RpcTransport<WsRpcProtocolClient> {
  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    platform: { readonly observability: ObservabilityService; readonly socket: SocketService },
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    super(url, platform, () => makeWsRpcProtocolClient, lifecycleHandlers);
  }
}

/**
 * Low-priority simulator control transport. It reuses the same lifecycle and
 * retry implementation while keeping its handler group and socket isolated.
 */
export class DeviceWsTransport extends RpcTransport<DeviceRpcProtocolClient> {
  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    platform: { readonly observability: ObservabilityService; readonly socket: SocketService },
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    super(url, platform, () => makeDeviceRpcProtocolClient, {
      ...lifecycleHandlers,
      preserveSocketPath: true,
      recordConnectionState: false,
    });
  }
}

/** The hosted relay's authoritative socket carries application and device control RPC together. */
export class HostedWsTransport extends RpcTransport<HostedRpcProtocolClient> {
  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    platform: { readonly observability: ObservabilityService; readonly socket: SocketService },
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    super(url, platform, () => makeHostedRpcProtocolClient, lifecycleHandlers);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}
