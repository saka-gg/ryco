import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";

import type { ObservabilityService, SocketService } from "../platform/index.ts";
import { clearAllTrackedRpcRequests } from "./requestLatencyState.ts";
import {
  createWsRpcProtocolLayer,
  isAwaitingAdmission,
  makeHostedRpcProtocolClient,
  makeDeviceRpcProtocolClient,
  type DeviceRpcProtocolClient,
  type HostedRpcProtocolClient,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol.ts";
import { isTransportConnectionErrorMessage } from "../errors/transportError.ts";

/**
 * Why a subscription stopped for good. Failure messages can carry user data, so
 * an `onError` hook never sees the failure itself, only this classification.
 */
export type SubscriptionFailureKind = "unsupported" | "response-too-large" | "failed";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
  /**
   * The subscription stopped for good: a failure no retry can fix, or a
   * listener that threw. Receives `classifyFailure`'s verdict for a stream
   * failure when one is given, and nothing otherwise.
   */
  readonly onError?: (kind?: SubscriptionFailureKind) => void;
  /** Classifies a stream failure for `onError` so callers can pick a fallback. */
  readonly classifyFailure?: (error: unknown) => SubscriptionFailureKind;
  readonly tag?: string;
}

export interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
  /**
   * Abandons the request: before it is sent it never goes out; once running,
   * its client fiber is interrupted, which tells the server to interrupt the
   * handler. The promise rejects with an `AbortError`.
   */
  readonly signal?: AbortSignal | undefined;
}

/** What an aborted request rejects with (the neutral runtime has no `signal.reason`). */
export class RpcRequestAbortedError extends Error {
  constructor() {
    super("The request was aborted.");
    this.name = "AbortError";
  }
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
/**
 * Ceiling for re-checking a subscription its connection refused only for now
 * (`isAwaitingAdmission`). Nothing is sent while it waits, so the cost is a
 * local check; the cap bounds how late the stream starts after the connection
 * admits it.
 */
export const AWAITING_SESSION_SUBSCRIPTION_MAX_DELAY_MS = 4_000;
/**
 * Ceiling for resubscribing after the server failed the terminal event stream
 * with a resync request (a slow-consumer overflow). An overflow the server
 * reproduces on every bootstrap would otherwise loop at the base retry delay,
 * re-sending the whole bootstrap each time; consecutive resyncs back off
 * exponentially and a quiet period resets the backoff.
 */
export const RESYNC_SUBSCRIPTION_MAX_DELAY_MS = 8_000;
const RESYNC_SUBSCRIPTION_BACKOFF_RESET_MS = 30_000;
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

/** The terminal event stream's server-side overflow, decoded from its tagged error. */
function isTerminalResyncSubscriptionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TerminalSubscriptionResyncError"
  );
}

/** Delay before the next resubscribe after `consecutiveResyncs` back-to-back resync failures. */
export function resyncSubscriptionRetryDelayMs(
  baseDelayMs: number,
  consecutiveResyncs: number,
): number {
  return Math.min(
    Math.max(baseDelayMs, 1) * 2 ** Math.min(Math.max(consecutiveResyncs, 0), 16),
    RESYNC_SUBSCRIPTION_MAX_DELAY_MS,
  );
}

/**
 * The server does not implement the requested RPC: an older server, or a
 * handler that was never wired. A caller may fall back to an older method.
 */
export function isUnsupportedRpcError(error: unknown): boolean {
  return formatErrorMessage(error).includes("Unknown request tag");
}

/** The response did not fit the largest message the connection carries (relay cap). */
export function isResponseTooLargeError(error: unknown): boolean {
  return formatErrorMessage(error).includes(
    "The response exceeded the largest message this connection can carry",
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
  private reconnectOperation: Promise<void> | null = null;
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession<Client>;
  private lastHeartbeatPongAt = 0;
  private readonly makeClient: () => Effect.Effect<Client, never, RpcClient.Protocol | Scope.Scope>;
  private readonly subscriptionRetryWakeups = new Set<() => void>();
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
    options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new RpcTransportDisposedError();
    }

    const signal = options?.signal;
    if (signal?.aborted) throw new RpcRequestAbortedError();
    const session = this.session;
    const client = await session.clientPromise;
    if (signal === undefined) {
      return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
    }
    if (signal.aborted) throw new RpcRequestAbortedError();
    try {
      return await session.runtime.runPromise(
        Effect.suspend(() => execute(client)),
        { signal },
      );
    } catch (error) {
      // The interruption's own failure says less than why the caller aborted.
      if (signal.aborted) throw new RpcRequestAbortedError();
      throw error;
    }
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
      Stream.runForEachArray(connect(client), (values) =>
        Effect.sync(() => {
          for (const value of values) {
            try {
              listener(value);
            } catch {
              // Swallow listener errors so the stream can finish cleanly.
            }
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
    let consecutiveResyncs = 0;
    let lastResyncAt = Number.NEGATIVE_INFINITY;
    let resyncReportedSession: TransportSession<Client> | null = null;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    let cancelCurrentStream: () => void = NOOP;
    let admissionRevision = 0;
    let wakeRetry: () => void = NOOP;
    const admissionChanged = () => {
      admissionRevision += 1;
      wakeRetry();
    };
    const unsubscribeAdmission =
      this.lifecycleHandlers?.subscribeAdmissionChanges?.(admissionChanged) ?? NOOP;
    this.subscriptionRetryWakeups.add(admissionChanged);
    const waitForRetry = (delayMs: number, observedRevision: number) => {
      // Register before the stream starts and compare revisions afterwards:
      // readiness can change between refusal and the rejection reaching us.
      if (!active || this.disposed || admissionRevision !== observedRevision) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wakeRetry = NOOP;
          resolve();
        };
        const timer = setTimeout(finish, delayMs);
        wakeRetry = finish;
      });
    };

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        const session = this.session;
        const observedAdmissionRevision = admissionRevision;
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
            await waitForRetry(
              Math.min(
                Math.max(retryDelayMs, 1) * 2 ** Math.min(awaitingSessionRetries, 16),
                AWAITING_SESSION_SUBSCRIPTION_MAX_DELAY_MS,
              ),
              observedAdmissionRevision,
            );
            awaitingSessionRetries += 1;
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (isSubscriptionStreamDoneError(formattedError)) {
            return;
          }
          if (isTerminalResyncSubscriptionError(error)) {
            // The stream delivered values before failing, so readiness alone cannot
            // reset this backoff; only a quiet period between resyncs does.
            const now = Date.now();
            consecutiveResyncs =
              now - lastResyncAt > RESYNC_SUBSCRIPTION_BACKOFF_RESET_MS
                ? 0
                : consecutiveResyncs + 1;
            lastResyncAt = now;
            if (resyncReportedSession !== session) {
              resyncReportedSession = session;
              console.warn("WebSocket RPC subscription resynchronizing", {
                ...(options?.tag === undefined ? {} : { tag: options.tag }),
                error: formattedError,
              });
            }
            await waitForRetry(
              resyncSubscriptionRetryDelayMs(retryDelayMs, consecutiveResyncs),
              observedAdmissionRevision,
            );
            continue;
          }
          if (!isRetryableSubscriptionError(formattedError)) {
            try {
              if (options?.classifyFailure) options.onError?.(options.classifyFailure(error));
              else options?.onError?.();
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
          await waitForRetry(retryDelayMs, observedAdmissionRevision);
        }
      }
    })().finally(() => {
      unsubscribeAdmission();
      this.subscriptionRetryWakeups.delete(admissionChanged);
    });

    return () => {
      active = false;
      wakeRetry();
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new RpcTransportDisposedError();
    }

    if (this.reconnectOperation) return this.reconnectOperation;
    const reconnectOperation = Promise.resolve().then(async () => {
      if (this.disposed) {
        throw new RpcTransportDisposedError();
      }

      clearAllTrackedRpcRequests();
      this.lastHeartbeatPongAt = 0;
      const previousSession = this.session;
      this.session = this.createSession();
      for (const wake of this.subscriptionRetryWakeups) wake();
      await this.closeSession(previousSession);
    });

    this.reconnectOperation = reconnectOperation;
    try {
      await reconnectOperation;
    } finally {
      this.reconnectOperation = null;
    }
  }

  isHeartbeatFresh(maxAgeMs = 15_000): boolean {
    return this.lastHeartbeatPongAt > 0 && Date.now() - this.lastHeartbeatPongAt <= maxAgeMs;
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleHandlers?.onDispose?.();
    for (const wake of this.subscriptionRetryWakeups) wake();
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
    this.lifecycleHandlers?.onSessionStart?.();
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
      readonly onError?: (kind?: SubscriptionFailureKind) => void;
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
    // One chunk from the server arrives as one array: deliver all of it in a
    // single synchronous pass, so whatever the listener batches (a store
    // commit per frame) sees the whole chunk, and only one effect runs per
    // chunk rather than per value.
    const deliver = (value: TValue) => {
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
    };
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEachArray(connect(client), (values) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              for (const value of values) {
                if (!isActive()) return;
                deliver(value);
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

/**
 * The main application RPC transport. Its client also names the simulator
 * control RPCs: current servers serve them on this socket, and an older one
 * answers them with "Unknown request tag" without running anything, which
 * `createDirectDeviceRpcTransport` takes as its cue to use `/ws/device`.
 */
export class WsTransport extends RpcTransport<HostedRpcProtocolClient> {
  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    platform: { readonly observability: ObservabilityService; readonly socket: SocketService },
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    super(url, platform, () => makeHostedRpcProtocolClient, lifecycleHandlers);
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
