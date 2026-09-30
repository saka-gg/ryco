import { Clock, Effect, Queue, Scope, Semaphore } from "effect";
import type { Layer } from "effect";
import type { Rpc } from "effect/unstable/rpc";
import { RelayMessageAssembler } from "@ryco/shared/relayMessageChunks";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { RpcGroup } from "effect/unstable/rpc";

export interface RpcByteSession {
  readonly receive: (bytes: Uint8Array) => Effect.Effect<boolean>;
  readonly supportsChunkedMessages: () => boolean;
  /**
   * Does the relay chunk assembler still hold an incomplete reassembled message?
   *
   * Read at the moment the channel ends by a layer that has to report it — a
   * partial reassembled message at close is truncation, and an owner that cannot
   * tell truncation from an ordinary abrupt end cannot tell a squeezed
   * connection from a discarded tail. Synchronous, because the caller asking it
   * is on a teardown path where an `Effect` would sequence after the reset.
   */
  readonly incompleteReassembly: () => boolean;
  readonly close: Effect.Effect<void>;
  readonly queuedMessages: Effect.Effect<number>;
  readonly queuedBytes: Effect.Effect<number>;
}

/**
 * Why the transport declined a message.
 *
 * - `backpressure`: the send path is full right now; a later attempt may pass.
 * - `too_large`: these bytes can never be carried on this channel.
 * - `unavailable`: the channel will carry nothing further.
 */
export type RpcOutputRefusal = "backpressure" | "too_large" | "unavailable";

/**
 * The transport declined to carry a message.
 *
 * A refusal is a value, not a defect: failing the RPC server fiber here would
 * tear down every other in-flight request. The session reacts per refusal
 * instead — it waits out backpressure, fails just the request an oversized
 * response belongs to, and otherwise reports that output failed so the owner
 * can end the channel. What it never does is drop a response and carry on:
 * with acknowledged streams, one lost chunk stalls its subscription forever.
 * Genuine sink defects stay defects.
 */
export class RpcOutputRefusedError extends Error {
  readonly refusal: RpcOutputRefusal;
  constructor(refusal: RpcOutputRefusal = "unavailable") {
    super(`RPC byte session output was refused (${refusal}).`);
    this.name = "RpcOutputRefusedError";
    this.refusal = refusal;
  }
}

/**
 * Why the session gave up on output, reported once to the owner:
 * `stalled` when backpressure outlasted the stall timeout, `lost` when a
 * response could not be delivered at all.
 */
export type RpcOutputFailure = "stalled" | "lost";

/** How long output may sit behind backpressure before the channel is declared stalled. */
export const DEFAULT_RPC_OUTPUT_STALL_TIMEOUT_MS = 30_000;
const OUTPUT_RETRY_INITIAL_DELAY_MS = 5;
const OUTPUT_RETRY_MAX_DELAY_MS = 100;

/**
 * What an inbound, reassembled, prelude-stripped payload becomes.
 *
 * `claimed` means a layer above the RPC decoder took the payload and nothing
 * reaches the parser; `rpc` carries the bytes the parser should decode, which
 * need not be the bytes that arrived.
 */
export type RpcInboundDisposition =
  | { readonly kind: "rpc"; readonly message: Uint8Array }
  | { readonly kind: "claimed" };

/**
 * An inbound payload the interceptor refused, and the channel cannot continue.
 *
 * A value rather than a defect. Discrimination — and, for a payload
 * authentication layer, decryption — runs on the session's own consumer fiber,
 * where a defect kills the fiber outright: the session would go on accepting
 * bytes that nothing will ever read, and the condition that decided the channel
 * was finished would never be reported to anyone who could act on it. A
 * malformed or unauthenticated peer record is exactly that condition, so it has
 * to be expressible as a typed failure the session can handle. Genuine defects
 * in the interceptor stay defects.
 *
 * It carries no detail about the payload on purpose: the reason belongs to the
 * layer that raised it, which selects the close reason itself, and a rejected
 * record must not become a diagnostic that describes peer bytes.
 */
export class RpcInboundRejectedError extends Error {
  constructor(options?: ErrorOptions) {
    super("RPC byte session inbound payload was rejected.", options);
    this.name = "RpcInboundRejectedError";
  }
}

/**
 * Inspects a reassembled payload before the RPC decoder sees it.
 *
 * The seam exists because discrimination has to happen on the payload *after*
 * chunk reassembly and prelude stripping, and because a layer that authenticates
 * payloads must be able to stop unauthenticated bytes from reaching the parser
 * at all. With no interceptor installed every payload is decoded exactly as it
 * was before this existed.
 *
 * Failing with `RpcInboundRejectedError` is how it declares the channel
 * finished. The session then stops consuming, drops any partially reassembled
 * message, refuses every later payload, and hands the error to
 * `onInboundRejected` — so the verdict reaches the channel layer instead of
 * silently killing the consumer fiber.
 *
 * What it still cannot do is *name the close reason*: a value returned here
 * could not reach the caller of `receive` for the payload that produced it, so
 * the reason would be reported one frame late, or never. The channel layer
 * closes with the reason its protocol requires — through the `close(reason)`
 * handle its channel session was given at open, after emitting whatever final
 * record precedes it, which the registry drains to the socket before the outer
 * close. That is why `RelayRpcChannelSession.receive` stays a plain
 * backpressure bit.
 */
export type RpcInboundInterceptor = (
  message: Uint8Array,
) => Effect.Effect<RpcInboundDisposition, RpcInboundRejectedError>;

const encoder = new TextEncoder();

const passThrough: RpcInboundInterceptor = (message) => Effect.succeed({ kind: "rpc", message });

export function makeRpcByteSession<Rpcs extends Rpc.Any, E, R>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs>, E, R>,
  sink: (bytes: Uint8Array) => Effect.Effect<void, RpcOutputRefusedError>,
  options: {
    readonly queueCapacity?: number;
    readonly interceptor?: RpcInboundInterceptor;
    /** See `DEFAULT_RPC_OUTPUT_STALL_TIMEOUT_MS`. */
    readonly outputStallTimeoutMs?: number;
    /**
     * Told, once, that a response could not be delivered and the session can no
     * longer keep this channel coherent. The owner is expected to end the
     * channel so the client reconnects with fresh state. Nothing further is
     * sent after this fires.
     */
    readonly onOutputFailure?: (failure: RpcOutputFailure) => void;
    /**
     * Told that the interceptor refused a payload and this channel is finished.
     *
     * Called once, on the consumer fiber, after the session has stopped
     * consuming. The owner is expected to close its channel here with the
     * reason its protocol selects; it may emit a final record first, since the
     * session's outbound path is untouched by an inbound rejection. A handler
     * that throws is contained — turning a channel-fatal verdict back into a
     * dead fiber is the failure this seam exists to remove — and with no
     * handler installed the session simply refuses everything that follows,
     * which the channel layer sees as an unavailable consumer.
     */
    readonly onInboundRejected?: (error: RpcInboundRejectedError) => void;
  } = {},
): Effect.Effect<RpcByteSession, E, Scope.Scope | R> {
  return Effect.gen(function* () {
    const capacity = options.queueCapacity ?? 16;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_024) {
      return yield* Effect.die(new Error("RPC byte session capacity is invalid."));
    }
    const incoming = yield* Queue.dropping<Uint8Array>(capacity);
    const disconnects = yield* Queue.sliding<number>(1);
    const parser = RpcSerialization.json.makeUnsafe();
    // Reassembles messages the peer had to split because they exceeded the
    // relay data-frame limit. An unchunked payload passes straight through, so
    // an old peer is unaffected. Reassembly happens BEFORE `parser.decode`, so
    // the serializer always sees one complete message and a multi-byte UTF-8
    // sequence split across a frame boundary cannot be mangled.
    const assembler = new RelayMessageAssembler();
    const discriminate = options.interceptor ?? passThrough;
    const clients = new Set<number>([0]);
    let queuedBytes = 0;
    let rejected = false;
    const outputStallTimeoutMs = options.outputStallTimeoutMs ?? DEFAULT_RPC_OUTPUT_STALL_TIMEOUT_MS;
    // One response at a time, in order: a response waiting out backpressure
    // holds its place, exactly as it would on a socket, instead of letting later
    // responses overtake it.
    const outputLock = yield* Semaphore.make(1);
    let outputFailed = false;
    const failOutput = (failure: RpcOutputFailure) =>
      Effect.sync(() => {
        if (outputFailed) return;
        outputFailed = true;
        try {
          options.onOutputFailure?.(failure);
        } catch {
          // Contained: the owner's reaction must not kill the RPC server fiber.
        }
      });
    const encodeResponse = (response: unknown): Uint8Array | undefined => {
      const encoded = parser.encode(response);
      if (encoded === undefined) return undefined;
      return typeof encoded === "string" ? encoder.encode(encoded) : Uint8Array.from(encoded);
    };
    /**
     * Hands bytes to the sink, waiting out backpressure. Resolves `undefined`
     * once accepted, otherwise the refusal that ended the attempt — with
     * `stalled` standing for backpressure that outlasted the timeout.
     */
    const deliver = (bytes: Uint8Array) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        let delayMs = OUTPUT_RETRY_INITIAL_DELAY_MS;
        while (true) {
          const refusal = yield* sink(bytes).pipe(
            Effect.as(undefined),
            Effect.catch((error: RpcOutputRefusedError) => Effect.succeed(error.refusal)),
          );
          if (refusal !== "backpressure") return refusal;
          if (outputFailed) return "unavailable" as const;
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          if (elapsed >= outputStallTimeoutMs) return "stalled" as const;
          yield* Effect.sleep(Math.min(delayMs, outputStallTimeoutMs - elapsed));
          delayMs = Math.min(delayMs * 2, OUTPUT_RETRY_MAX_DELAY_MS);
        }
      });
    // Interrupts are handed to the server from their own fiber: the response
    // that needs one is being sent BY the request fiber it interrupts, and a
    // fiber cannot wait for its own interruption.
    const interrupts = yield* Queue.unbounded<RpcMessage.RequestId>();

    const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(interrupts).pipe(
              Effect.flatMap((requestId) =>
                writeRequest(0, { _tag: "Interrupt", requestId } as never),
              ),
            ),
          ),
        );
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(incoming).pipe(
              Effect.flatMap((bytes) =>
                Effect.gen(function* () {
                  const assembled = yield* Effect.sync(() => {
                    queuedBytes = Math.max(0, queuedBytes - bytes.byteLength);
                    const result = assembler.push(bytes);
                    if (result.kind === "error") {
                      // Fail the session so the channel closes rather than
                      // silently decoding a half-message.
                      throw new Error(`Relay message reassembly failed: ${result.reason}`);
                    }
                    return result;
                  });
                  if (assembled.kind === "pending") return;
                  // Discrimination happens here, on the reassembled and
                  // prelude-stripped payload, and never on raw wire bytes: a
                  // chunk payload legitimately begins with the chunk magic and
                  // an authenticating layer must be able to refuse a payload
                  // before the decoder sees it.
                  const disposition = yield* discriminate(assembled.message);
                  if (disposition.kind === "claimed") return;
                  const messages = parser.decode(disposition.message);
                  yield* Effect.forEach(messages, (message) => writeRequest(0, message as never), {
                    discard: true,
                  });
                }),
              ),
            ),
          ).pipe(
            // A refused payload ends consumption instead of ending the fiber.
            // Nothing after a record the interceptor rejected may be decoded,
            // and the owner — not this session — decides what the channel
            // reports, so the error is handed over and the loop stops here.
            Effect.catch((error: RpcInboundRejectedError) =>
              Effect.sync(() => {
                rejected = true;
                queuedBytes = 0;
                assembler.reset();
                try {
                  options.onInboundRejected?.(error);
                } catch {
                  // Contained deliberately: see `onInboundRejected`.
                }
              }).pipe(Effect.andThen(Queue.shutdown(incoming))),
            ),
          ),
        );
        return {
          disconnects,
          send: (_clientId, response) =>
            outputLock.withPermits(1)(
              Effect.gen(function* () {
                if (outputFailed) return;
                const bytes = encodeResponse(response);
                if (bytes === undefined) return;
                const outcome = yield* deliver(bytes);
                if (outcome === undefined) return;
                if (
                  outcome === "too_large" &&
                  (response._tag === "Chunk" || response._tag === "Exit")
                ) {
                  // Only this request is lost. Fail it for the client, and stop a
                  // stream on the server — it would otherwise wait forever for
                  // the acknowledgement of a chunk that was never sent.
                  const requestId = RpcMessage.RequestId(response.requestId);
                  if (response._tag === "Chunk") yield* Queue.offer(interrupts, requestId);
                  const replacement = encodeResponse(
                    RpcMessage.ResponseExitDieEncoded({
                      requestId,
                      defect: new Error(
                        "The response exceeded the largest message this connection can carry.",
                      ),
                    }),
                  );
                  if (replacement !== undefined && (yield* deliver(replacement)) === undefined) {
                    return;
                  }
                }
                yield* failOutput(outcome === "stalled" ? "stalled" : "lost");
              }),
            ),
          end: () => Effect.void,
          clientIds: Effect.sync(() => clients as ReadonlySet<number>),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
        };
      }),
    );

    yield* RpcServer.make(group, {
      spanPrefix: "ws.rpc",
      spanAttributes: {
        "rpc.transport": "byte-session",
        "rpc.system": "effect-rpc",
      },
    }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(handlers),
      Effect.forkScoped,
    );

    yield* Scope.addFinalizer(
      yield* Effect.scope,
      Effect.gen(function* () {
        clients.clear();
        queuedBytes = 0;
        assembler.reset();
        yield* Queue.offer(disconnects, 0);
        yield* Queue.shutdown(incoming);
        yield* Queue.shutdown(disconnects);
      }),
    );

    return {
      receive: (bytes) => {
        // Once the interceptor has refused a payload this session decodes
        // nothing further, so it stops claiming it can. The owner's own close
        // normally lands first; this is what happens to a peer that keeps
        // sending in the meantime, and it is the whole behavior when no
        // `onInboundRejected` handler is installed.
        if (rejected) return Effect.succeed(false);
        const copy = Uint8Array.from(bytes);
        queuedBytes += copy.byteLength;
        return Queue.offer(incoming, copy).pipe(
          Effect.tap((accepted) =>
            accepted
              ? Effect.void
              : Effect.sync(() => {
                  queuedBytes = Math.max(0, queuedBytes - copy.byteLength);
                  copy.fill(0);
                }),
          ),
        );
      },
      supportsChunkedMessages: () => assembler.peerSupportsChunking,
      incompleteReassembly: () => assembler.incompleteMessage,
      close: Effect.sync(() => {
        queuedBytes = 0;
        assembler.reset();
      }).pipe(Effect.andThen(Queue.shutdown(incoming)), Effect.asVoid),
      queuedMessages: Queue.size(incoming),
      // Includes bytes held by a partially-reassembled message: without this a
      // peer could hold megabytes that the backpressure logic cannot see.
      queuedBytes: Effect.sync(() => queuedBytes + assembler.heldBytes),
    } satisfies RpcByteSession;
  }) as Effect.Effect<RpcByteSession, E, Scope.Scope | R>;
}
