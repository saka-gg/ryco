import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void, never>;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  /**
   * Runs the request and enqueue deadlines. Defaults to `Effect.timeoutOrElse`;
   * pass a stall-aware one of the same shape so a host stall or machine sleep
   * does not expire them.
   */
  readonly timeoutOrElse?: typeof Effect.timeoutOrElse;
}

export interface CodexAppServerPatchedProtocol {
  readonly incomingNotifications: Stream.Stream<CodexAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<CodexAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

const PROTOCOL_QUEUE_CAPACITY = 256;
const PROTOCOL_ENQUEUE_DEADLINE_MS = 2_000;
// Resume/read responses contain history in one JSONL frame. Keep a hard safety
// bound, but allow normal large histories and tool results past the old 8 MiB cap.
const PROTOCOL_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PROTOCOL_REQUEST_TIMEOUT_MS = 120_000;
const MAX_ACTIVE_REQUEST_HANDLERS = 32;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return Schema.is(JsonRpcId)(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return Schema.is(JsonRpcResponseEnvelope)(value);
}

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  Effect.try({
    try: () => `${JSON.stringify(message)}\n`,
    catch: (cause) =>
      new CodexError.CodexAppServerProtocolParseError({
        detail: "Failed to encode Codex App Server message",
        cause,
      }),
  });

const normalizeProtocolError = (error: unknown, detail: string): CodexError.CodexAppServerError =>
  Schema.is(CodexError.CodexAppServerError)(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        detail,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const protocolScope = yield* Scope.Scope;
    const requestHandlerScope = yield* Scope.fork(protocolScope, "parallel");
    const activeRequestHandlers = yield* Ref.make(0);
    const terminationFailure = yield* Ref.make(Option.none<CodexError.CodexAppServerError>());
    const terminationSignal = yield* Deferred.make<void>();
    const maxFrameBytes = options.maxFrameBytes ?? PROTOCOL_MAX_FRAME_BYTES;
    const requestTimeoutMs = options.requestTimeoutMs ?? PROTOCOL_REQUEST_TIMEOUT_MS;
    const timeoutOrElse = options.timeoutOrElse ?? Effect.timeoutOrElse;
    const outgoing = yield* Queue.bounded<string, Cause.Done<void>>(PROTOCOL_QUEUE_CAPACITY);
    const incomingNotifications = yield* options.onNotification
      ? Queue.sliding<CodexAppServerIncomingNotification>(PROTOCOL_QUEUE_CAPACITY)
      : Queue.bounded<CodexAppServerIncomingNotification>(PROTOCOL_QUEUE_CAPACITY);
    const incomingRequests = yield* options.onRequest
      ? Queue.sliding<CodexAppServerIncomingRequest>(PROTOCOL_QUEUE_CAPACITY)
      : Queue.bounded<CodexAppServerIncomingRequest>(PROTOCOL_QUEUE_CAPACITY);
    const pending = yield* Ref.make(
      new Map<string, Deferred.Deferred<unknown, CodexError.CodexAppServerError>>(),
    );
    const nextRequestId = yield* Ref.make(1);
    const remainder: { fragments: Array<string>; byteLength: number } = {
      fragments: [],
      byteLength: 0,
    };
    const terminationHandled = yield* Ref.make(false);

    const logProtocol = (event: CodexAppServerProtocolLogEvent) => {
      if (event.direction === "incoming" && !options.logIncoming) {
        return Effect.void;
      }
      if (event.direction === "outgoing" && !options.logOutgoing) {
        return Effect.void;
      }
      return (
        options.logger?.(event) ??
        Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }))
      );
    };

    const offerBounded = <A, E>(
      queue: Queue.Queue<A, E>,
      value: A,
      queueName: string,
    ): Effect.Effect<void, CodexError.CodexAppServerError> =>
      Queue.offer(queue, value).pipe(
        timeoutOrElse({
          duration: PROTOCOL_ENQUEUE_DEADLINE_MS,
          orElse: () =>
            Effect.fail(
              new CodexError.CodexAppServerProtocolOverloadedError({
                queue: queueName,
                capacity: PROTOCOL_QUEUE_CAPACITY,
              }),
            ),
        }),
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Ref.get(terminationFailure).pipe(
                Effect.flatMap((failure) =>
                  Effect.fail(
                    Option.getOrElse(
                      failure,
                      () =>
                        new CodexError.CodexAppServerTransportError({
                          detail: "Codex App Server transport is closed",
                          cause: new Error("Transport closed"),
                        }),
                    ),
                  ),
                ),
              ),
        ),
        Effect.mapError((error) =>
          normalizeProtocolError(error, `Codex App Server ${queueName} queue failed`),
        ),
      );

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], (deferred) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) {
          return [Effect.void, true] as const;
        }
        return [
          Effect.gen(function* () {
            const error = yield* classify();
            yield* Ref.set(terminationFailure, Option.some(error));
            yield* failAllPending(error);
            yield* Queue.end(outgoing);
            yield* Deferred.succeed(terminationSignal, undefined);
            // A request's finalizer must not delay failure of unrelated RPCs or
            // deadlock by closing the scope of the fiber currently terminating.
            yield* Scope.close(requestHandlerScope, Exit.void).pipe(Effect.forkIn(protocolScope));
            if (options.onTermination) {
              yield* options.onTermination(error);
            }
          }),
          true,
        ] as const;
      }).pipe(Effect.flatten);

    const offerOutgoing = (message: Record<string, unknown>) =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(terminationFailure);
        if (Option.isSome(failure)) return yield* failure.value;
        yield* logProtocol({
          direction: "outgoing",
          stage: "decoded",
          payload: message,
        });
        const encoded = yield* encodeWireMessage(message);
        if (new TextEncoder().encode(encoded).byteLength > maxFrameBytes) {
          return yield* new CodexError.CodexAppServerProtocolOverloadedError({
            queue: "outgoing-frame-bytes",
            capacity: maxFrameBytes,
          });
        }
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: encoded,
        });
        yield* offerBounded(outgoing, encoded, "outgoing");
      });

    const removePending = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const resolvePending = (
      requestId: string,
      handler: (
        deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>,
      ) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const deferred = current.get(requestId);
        if (!deferred) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(deferred), next] as const;
      }).pipe(Effect.flatten);

    const respond = (requestId: string | number, result: unknown) =>
      offerOutgoing(toProtocolMessage(requestId, { result }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

    const handleResponse = (response: typeof JsonRpcResponseEnvelope.Type) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      if (protocolError !== undefined) {
        return resolvePending(requestId, (deferred) =>
          Deferred.fail(
            deferred,
            CodexError.CodexAppServerRequestError.fromProtocolError(protocolError),
          ),
        );
      }
      return resolvePending(requestId, (deferred) => Deferred.succeed(deferred, response.result));
    };

    const handleRequest = (request: CodexAppServerIncomingRequest) =>
      Effect.gen(function* () {
        yield* offerBounded(incomingRequests, request, "incoming-requests");
        const handler = options.onRequest;
        if (!handler) return;
        const accepted = yield* Ref.modify(activeRequestHandlers, (count) =>
          count < MAX_ACTIVE_REQUEST_HANDLERS ? [true, count + 1] : [false, count],
        );
        if (!accepted) {
          return yield* respondError(
            request.id,
            CodexError.CodexAppServerRequestError.overloaded(),
          );
        }
        yield* handler(request).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : respondError(
                    request.id,
                    CodexError.normalizeToRequestError(
                      normalizeProtocolError(Cause.squash(cause), "Codex request handler failed"),
                    ),
                  ),
            onSuccess: (result) => respond(request.id, result),
          }),
          Effect.ensuring(Ref.update(activeRequestHandlers, (count) => count - 1)),
          Effect.catch((error) => handleTermination(() => Effect.succeed(error))),
          Effect.forkIn(requestHandlerScope, { startImmediately: true }),
        );
      });

    const handleNotification = (notification: CodexAppServerIncomingNotification) =>
      offerBounded(incomingNotifications, notification, "incoming-notifications").pipe(
        Effect.andThen(options.onNotification ? options.onNotification(notification) : Effect.void),
      );

    const routeMessage = (
      message: unknown,
    ): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (isIncomingRequest(message)) {
        return handleRequest(message);
      }
      if (isIncomingNotification(message)) {
        return handleNotification(message);
      }
      if (isIncomingResponse(message)) {
        return handleResponse(message);
      }
      return Effect.logWarning("Ignoring non-protocol Codex stdout message");
    };

    const handleLine = (
      line: string,
      final = false,
    ): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (line.trim().length === 0) {
        return Effect.void;
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: line,
      }).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () => JSON.parse(line),
            catch: (cause) =>
              new CodexError.CodexAppServerProtocolParseError({
                detail: "Failed to decode Codex App Server wire message",
                cause,
              }),
          }),
        ),
        Effect.tap((decoded) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          }),
        ),
        Effect.tapErrorTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              detail: error.detail,
              cause: error.cause,
            },
          }),
        ),
        Effect.flatMap(routeMessage),
        Effect.catchTag("CodexAppServerProtocolParseError", (error) =>
          final ? Effect.fail(error) : Effect.logWarning("Ignoring malformed Codex stdout line"),
        ),
      );
    };

    yield* options.stdio.stdin.pipe(
      Stream.interruptWhen(Deferred.await(terminationSignal)),
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const lines: Array<string> = [];
          let start = 0;

          for (
            let newline = chunk.indexOf("\n");
            newline !== -1;
            newline = chunk.indexOf("\n", start)
          ) {
            const fragment = chunk.slice(start, newline);
            const frameBytes = remainder.byteLength + new TextEncoder().encode(fragment).byteLength;
            if (frameBytes > maxFrameBytes) {
              return yield* Effect.fail(
                new CodexError.CodexAppServerProtocolOverloadedError({
                  queue: "incoming-frame-bytes",
                  capacity: maxFrameBytes,
                }),
              );
            }

            remainder.fragments.push(fragment);
            lines.push(remainder.fragments.join("").replace(/\r$/, ""));
            remainder.fragments.length = 0;
            remainder.byteLength = 0;
            start = newline + 1;
          }

          if (start < chunk.length) {
            const fragment = chunk.slice(start);
            remainder.byteLength += new TextEncoder().encode(fragment).byteLength;
            if (remainder.byteLength > maxFrameBytes) {
              return yield* Effect.fail(
                new CodexError.CodexAppServerProtocolOverloadedError({
                  queue: "incoming-frame-bytes",
                  capacity: maxFrameBytes,
                }),
              );
            }
            remainder.fragments.push(fragment);
          }

          yield* Effect.forEach(lines, (line) => handleLine(line), { discard: true });
        }),
      ),
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : handleTermination(() =>
                Effect.succeed(
                  normalizeProtocolError(
                    Cause.squash(cause),
                    "Codex App Server input stream failed",
                  ),
                ),
              ),
        onSuccess: () =>
          Effect.sync(() => {
            const line = remainder.fragments.join("");
            remainder.fragments.length = 0;
            remainder.byteLength = 0;
            return line;
          }).pipe(
            Effect.flatMap((line) =>
              line.trim().length === 0 ? Effect.void : handleLine(line, true),
            ),
            Effect.matchEffect({
              onFailure: (error) => handleTermination(() => Effect.succeed(error)),
              onSuccess: () =>
                handleTermination(
                  () =>
                    options.terminationError ??
                    Effect.succeed(
                      new CodexError.CodexAppServerTransportError({
                        detail: "Codex App Server input stream ended",
                        cause: new Error("Codex App Server input stream ended"),
                      }),
                    ),
                ),
            }),
          ),
      }),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(options.stdio.stdout()),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : handleTermination(() =>
              Effect.succeed(
                normalizeProtocolError(
                  Cause.squash(cause),
                  "Codex App Server output stream failed",
                ),
              ),
            ),
      ),
      Effect.forkScoped,
    );

    const request = (method: string, payload?: unknown) =>
      Effect.gen(function* () {
        const failure = yield* Ref.get(terminationFailure);
        if (Option.isSome(failure)) return yield* failure.value;
        const requestId = yield* Ref.modify(
          nextRequestId,
          (current) => [current, current + 1] as const,
        );
        const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
        const admitted = yield* Ref.modify(pending, (current) =>
          current.size >= PROTOCOL_QUEUE_CAPACITY
            ? ([false, current] as const)
            : ([true, new Map(current).set(String(requestId), deferred)] as const),
        );
        if (!admitted) return yield* CodexError.CodexAppServerRequestError.overloaded();
        return yield* offerOutgoing({
          id: requestId,
          method,
          ...(payload !== undefined ? { params: payload } : {}),
        }).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.ensuring(removePending(String(requestId))),
        );
      }).pipe(
        timeoutOrElse({
          duration: requestTimeoutMs,
          orElse: () =>
            Effect.fail(
              new CodexError.CodexAppServerTransportError({
                detail: `Codex App Server ${method} request timed out`,
                cause: new Error("Request deadline exceeded; dispatch outcome is unknown"),
              }),
            ),
        }),
      );

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: Stream.fromQueue(incomingNotifications),
      incomingRequests: Stream.fromQueue(incomingRequests),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);
