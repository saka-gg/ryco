import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Queue, Schema, Stream, Tracer } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  prepareRelayMessage,
  RELAY_CHUNK_CAPABILITY_PRELUDE,
} from "@ryco/shared/relayMessageChunks";
import {
  appendRelayCompressionAdvertisement,
  decodeCompressedRelayPayload,
  isCompressedRelayPayload,
} from "@ryco/shared/relayPayloadCompression";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { inflateRawSync } from "node:zlib";

import { makeRpcByteSession, RpcOutputRefusedError } from "./RpcByteSession.ts";
import { deflateRelayRpcMessage, RelayResponseCompressor } from "./relayResponseCompression.ts";

const EchoRpc = Rpc.make("echo", {
  payload: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
});
const TestGroup = RpcGroup.make(EchoRpc);

const request = (id: string, value: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      _tag: "Request",
      id,
      tag: "echo",
      payload: { value },
      headers: [],
    }),
  );

const echoHandlers = TestGroup.toLayer(
  Effect.succeed(
    TestGroup.of({
      echo: ({ value }) => Effect.succeed({ value }),
    }),
  ),
);

describe("RpcByteSession", () => {
  it.effect("records a legacy-compatible chunk capability advertisement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const output = yield* Deferred.make<Uint8Array>();
        const handlers = TestGroup.toLayer(
          Effect.succeed(
            TestGroup.of({
              echo: ({ value }) => Effect.succeed({ value }),
            }),
          ),
        );
        const session = yield* makeRpcByteSession(TestGroup, handlers, (bytes) =>
          Deferred.succeed(output, Uint8Array.from(bytes)).pipe(Effect.asVoid),
        );
        expect(session.supportsChunkedMessages()).toBe(false);
        const legacyCompatibleRequest = new Uint8Array(
          RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength + request("1", "relay").byteLength,
        );
        legacyCompatibleRequest.set(RELAY_CHUNK_CAPABILITY_PRELUDE);
        legacyCompatibleRequest.set(
          request("1", "relay"),
          RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength,
        );
        expect(yield* session.receive(legacyCompatibleRequest)).toBe(true);
        yield* Deferred.await(output);
        expect(session.supportsChunkedMessages()).toBe(true);
      }),
    ),
  );

  it.effect("runs a real Effect RPC request through ordered bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const output = yield* Deferred.make<Uint8Array>();
        const handlers = TestGroup.toLayer(
          Effect.succeed(
            TestGroup.of({
              echo: ({ value }) => Effect.succeed({ value: value.toUpperCase() }),
            }),
          ),
        );
        const session = yield* makeRpcByteSession(
          TestGroup,
          handlers,
          (bytes) => Deferred.succeed(output, Uint8Array.from(bytes)).pipe(Effect.asVoid),
          { queueCapacity: 2 },
        );
        expect(yield* session.receive(request("1", "relay"))).toBe(true);
        const response = JSON.parse(new TextDecoder().decode(yield* Deferred.await(output))) as {
          _tag: string;
          requestId: string;
          exit: { _tag: string; value: { value: string } };
        };
        expect(response).toMatchObject({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: { value: "RELAY" } },
        });
        yield* session.close;
        expect(yield* session.receive(request("2", "closed"))).toBe(false);
      }),
    ),
  );

  it.effect("keeps a claimed payload away from the RPC parser", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const output = yield* Deferred.make<Uint8Array>();
        const seen: Uint8Array[] = [];
        const session = yield* makeRpcByteSession(
          TestGroup,
          echoHandlers,
          (bytes) => Deferred.succeed(output, Uint8Array.from(bytes)).pipe(Effect.asVoid),
          {
            interceptor: (message) =>
              Effect.sync(() => {
                seen.push(Uint8Array.from(message));
                return message[0] === 0x2a ? { kind: "claimed" } : { kind: "rpc", message };
              }),
          },
        );

        // The interceptor sees the payload the RPC decoder would have seen:
        // reassembled and with the chunk-capability prelude already stripped.
        const claimed = new Uint8Array(RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength + 3);
        claimed.set(RELAY_CHUNK_CAPABILITY_PRELUDE);
        claimed.set(Uint8Array.of(0x2a, 0x01, 0x02), RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength);
        expect(yield* session.receive(claimed)).toBe(true);
        expect(yield* session.receive(request("1", "relay"))).toBe(true);

        // Only the payload the interceptor passed through produced a response,
        // so the claimed bytes never reached the parser.
        const response = new TextDecoder().decode(yield* Deferred.await(output));
        expect(response).toContain('"requestId":"1"');
        expect(seen).toEqual([Uint8Array.of(0x2a, 0x01, 0x02), request("1", "relay")]);
      }),
    ),
  );

  // Live clock: the session sleeps between backpressure retries.
  it.live("waits out backpressure instead of dropping a response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const delivered = yield* Deferred.make<Uint8Array>();
        let refusals = 0;
        const failures: string[] = [];
        const session = yield* makeRpcByteSession(
          TestGroup,
          echoHandlers,
          (bytes) =>
            Effect.suspend(() => {
              if (refusals < 3) {
                refusals += 1;
                return Effect.fail(new RpcOutputRefusedError("backpressure"));
              }
              return Deferred.succeed(delivered, Uint8Array.from(bytes)).pipe(Effect.asVoid);
            }),
          { onOutputFailure: (failure) => failures.push(failure) },
        );

        expect(yield* session.receive(request("1", "first"))).toBe(true);
        // Dropping the refused response used to leave its request waiting
        // forever; the session now retries it until the send path admits it.
        const response = new TextDecoder().decode(yield* Deferred.await(delivered));
        expect(response).toContain('"requestId":"1"');
        expect(refusals).toBe(3);
        expect(failures).toEqual([]);
      }),
    ),
  );

  it.live("fails only the request whose response is too large to carry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: string[] = [];
        const second = yield* Deferred.make<void>();
        const failures: string[] = [];
        const session = yield* makeRpcByteSession(
          TestGroup,
          echoHandlers,
          (bytes) =>
            Effect.suspend(() => {
              const text = new TextDecoder().decode(bytes);
              if (text.includes("oversized")) {
                return Effect.fail(new RpcOutputRefusedError("too_large"));
              }
              sent.push(text);
              return text.includes('"requestId":"2"')
                ? Deferred.succeed(second, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
          { onOutputFailure: (failure) => failures.push(failure) },
        );

        expect(yield* session.receive(request("1", "oversized"))).toBe(true);
        expect(yield* session.receive(request("2", "small"))).toBe(true);
        yield* Deferred.await(second);

        // The client learns request 1 failed instead of waiting on it forever,
        // and the channel keeps serving everything else.
        const first = sent.find((text) => text.includes('"requestId":"1"'));
        expect(first).toContain('"_tag":"Exit"');
        expect(first).toContain('"_tag":"Die"');
        expect(failures).toEqual([]);
      }),
    ),
  );

  it.live("reports a response it could not deliver and sends nothing after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        let attempts = 0;
        const reported = yield* Deferred.make<void>();
        const session = yield* makeRpcByteSession(
          TestGroup,
          echoHandlers,
          () =>
            Effect.suspend(() => {
              attempts += 1;
              return Effect.fail(new RpcOutputRefusedError("unavailable"));
            }),
          {
            onOutputFailure: (failure) => {
              failures.push(failure);
              Deferred.doneUnsafe(reported, Exit.void);
            },
          },
        );

        expect(yield* session.receive(request("1", "first"))).toBe(true);
        yield* Deferred.await(reported);
        expect(yield* session.receive(request("2", "second"))).toBe(true);
        yield* Effect.sleep(20);

        expect(failures).toEqual(["lost"]);
        expect(attempts).toBe(1);
      }),
    ),
  );

  it.live("declares output stalled when backpressure outlasts the timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reported = yield* Deferred.make<string>();
        const session = yield* makeRpcByteSession(
          TestGroup,
          echoHandlers,
          () => Effect.fail(new RpcOutputRefusedError("backpressure")),
          {
            outputStallTimeoutMs: 40,
            onOutputFailure: (failure) => Deferred.doneUnsafe(reported, Exit.succeed(failure)),
          },
        );

        expect(yield* session.receive(request("1", "first"))).toBe(true);
        expect(yield* Deferred.await(reported)).toBe("stalled");
      }),
    ),
  );

  it.effect("reports an incomplete reassembly while a chunked message is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const output = yield* Deferred.make<Uint8Array>();
        const session = yield* makeRpcByteSession(TestGroup, echoHandlers, (bytes) =>
          Deferred.succeed(output, Uint8Array.from(bytes)).pipe(Effect.asVoid),
        );
        expect(session.incompleteReassembly()).toBe(false);

        const prepared = prepareRelayMessage(request("1", "relay".repeat(400)), {
          maxChunkBytes: 512,
          maxMessageBytes: 512 * 1_024,
          peerSupportsChunking: true,
        });
        if (prepared.kind !== "ready") throw new Error(prepared.reason);
        expect(prepared.payloads.length).toBeGreaterThan(1);

        expect(yield* session.receive(prepared.payloads[0]!)).toBe(true);
        for (let turn = 0; turn < 8; turn += 1) yield* Effect.yieldNow;
        // The channel-owning layer reads exactly this at teardown: a message the
        // assembler holds and can no longer complete is truncation (§10.4), and
        // it is knowable nowhere else.
        expect(session.incompleteReassembly()).toBe(true);

        for (const payload of prepared.payloads.slice(1)) {
          expect(yield* session.receive(payload)).toBe(true);
        }
        yield* Deferred.await(output);
        expect(session.incompleteReassembly()).toBe(false);
      }),
    ),
  );

  it.effect("bounds queued input and releases it on scope close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handlers = TestGroup.toLayer(
          Effect.succeed(
            TestGroup.of({
              echo: ({ value }) => Effect.succeed({ value }),
            }),
          ),
        );
        const session = yield* makeRpcByteSession(TestGroup, handlers, () => Effect.void, {
          queueCapacity: 1,
        });
        expect(yield* session.receive(request("1", "one"))).toBe(true);
        yield* Effect.yieldNow;
        expect(yield* session.queuedMessages).toBeLessThanOrEqual(1);
      }),
    ),
  );
});

// ─── relay payload compression ───────────────────────────────────────────────

const ShellItem = Schema.Struct({ kind: Schema.String, data: Schema.String });
const SubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: Schema.Struct({}),
  success: ShellItem,
  stream: true,
});
const CompressionGroup = RpcGroup.make(SubscribeShellRpc, EchoRpc);
const bigSnapshotData = Array.from({ length: 2_000 }, (_, index) => `thread-${index % 50}`).join(
  " ",
);
const compressionHandlers = CompressionGroup.toLayer(
  Effect.succeed(
    CompressionGroup.of({
      [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
        Stream.make({ kind: "snapshot-threads", data: bigSnapshotData }),
      echo: ({ value }: { readonly value: string }) => Effect.succeed({ value }),
    } as never),
  ),
);

const subscribeShellRequest = (id: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      _tag: "Request",
      id,
      tag: ORCHESTRATION_WS_METHODS.subscribeShell,
      payload: {},
      headers: [],
    }),
  );

function decodeResponse(bytes: Uint8Array): { readonly _tag: string; readonly requestId?: string } {
  let text: Uint8Array = bytes;
  if (isCompressedRelayPayload(bytes)) {
    const decoded = decodeCompressedRelayPayload(bytes);
    if (decoded.kind !== "ok") throw new Error(decoded.reason);
    text = new Uint8Array(inflateRawSync(decoded.body));
  }
  return JSON.parse(new TextDecoder().decode(text));
}

describe("RpcByteSession relay payload compression", () => {
  it.live("compresses an allowlisted snapshot for an advertised client, in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const outputs = yield* Queue.unbounded<Uint8Array>();
        let releaseDeflate: (() => void) | undefined;
        const deflateGate = new Promise<void>((resolve) => {
          releaseDeflate = resolve;
        });
        const compressor = new RelayResponseCompressor({
          deflate: async (message) => {
            await deflateGate;
            return deflateRelayRpcMessage(message);
          },
        });
        const session = yield* makeRpcByteSession(
          CompressionGroup,
          compressionHandlers,
          (bytes) => Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
          { compressor },
        );
        expect(
          yield* session.receive(appendRelayCompressionAdvertisement(subscribeShellRequest("1"))),
        ).toBe(true);
        // A small response for another request is produced while the snapshot
        // is still compressing; it may not overtake it.
        expect(yield* session.receive(request("2", "small"))).toBe(true);
        yield* Effect.sleep(20);
        expect(yield* Queue.size(outputs)).toBe(0);
        releaseDeflate?.();

        const first = yield* Queue.take(outputs);
        expect(isCompressedRelayPayload(first)).toBe(true);
        expect(decodeResponse(first)).toMatchObject({ _tag: "Chunk", requestId: "1" });
        const second = yield* Queue.take(outputs);
        expect(isCompressedRelayPayload(second)).toBe(false);
        expect(decodeResponse(second)).toMatchObject({ _tag: "Exit", requestId: "2" });
      }),
    ),
  );

  it.live("latches only an advertisement the interceptor passed to the parser", () =>
    // On an E2EE channel the interceptor is the authentication boundary: an
    // advertisement in bytes it claimed or refused cannot turn compression on.
    Effect.scoped(
      Effect.gen(function* () {
        const outputs = yield* Queue.unbounded<Uint8Array>();
        const compressor = new RelayResponseCompressor();
        const session = yield* makeRpcByteSession(
          CompressionGroup,
          compressionHandlers,
          (bytes) => Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
          {
            compressor,
            // Stands in for the E2EE layer: a leading 0x01 marks an envelope it
            // authenticates and unwraps; anything else it claims.
            interceptor: (message) =>
              Effect.succeed(
                message[0] === 0x01
                  ? { kind: "rpc", message: message.subarray(1) }
                  : { kind: "claimed" },
              ),
          },
        );
        expect(
          yield* session.receive(appendRelayCompressionAdvertisement(subscribeShellRequest("1"))),
        ).toBe(true);
        const envelope = (bytes: Uint8Array) => Uint8Array.from([0x01, ...bytes]);
        expect(yield* session.receive(envelope(subscribeShellRequest("2")))).toBe(true);
        const plain = yield* Queue.take(outputs);
        expect(compressor.advertised).toBe(false);
        expect(plain[0]).toBe(0x7b);
        expect(decodeResponse(plain)).toMatchObject({ _tag: "Chunk", requestId: "2" });

        expect(
          yield* session.receive(
            envelope(appendRelayCompressionAdvertisement(subscribeShellRequest("3"))),
          ),
        ).toBe(true);
        const compressed = yield* Queue.take(outputs);
        expect(compressor.advertised).toBe(true);
        expect(isCompressedRelayPayload(compressed)).toBe(true);
        expect(decodeResponse(compressed)).toMatchObject({ _tag: "Chunk", requestId: "3" });
      }),
    ),
  );

  it.live("sends plain bytes to a client that never advertised", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const outputs = yield* Queue.unbounded<Uint8Array>();
        const session = yield* makeRpcByteSession(
          CompressionGroup,
          compressionHandlers,
          (bytes) => Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
          { compressor: new RelayResponseCompressor() },
        );
        expect(yield* session.receive(subscribeShellRequest("1"))).toBe(true);
        const first = yield* Queue.take(outputs);
        expect(first.byteLength).toBeGreaterThan(16 * 1_024);
        expect(first[0]).toBe(0x7b);
        expect(decodeResponse(first)).toMatchObject({ _tag: "Chunk", requestId: "1" });
      }),
    ),
  );

  it.live("leaves a large response outside the allowlist uncompressed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const outputs = yield* Queue.unbounded<Uint8Array>();
        const session = yield* makeRpcByteSession(
          CompressionGroup,
          compressionHandlers,
          (bytes) => Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
          { compressor: new RelayResponseCompressor() },
        );
        expect(
          yield* session.receive(
            appendRelayCompressionAdvertisement(request("1", bigSnapshotData)),
          ),
        ).toBe(true);
        const response = yield* Queue.take(outputs);
        expect(response.byteLength).toBeGreaterThan(16 * 1_024);
        expect(response[0]).toBe(0x7b);
      }),
    ),
  );

  it.live("serves an advertised request unchanged on a node without compression", () =>
    // The base node's byte session — no compressor — is exactly this path: the
    // advertisement is trailing JSON whitespace its parser ignores.
    Effect.scoped(
      Effect.gen(function* () {
        const outputs = yield* Queue.unbounded<Uint8Array>();
        const session = yield* makeRpcByteSession(CompressionGroup, compressionHandlers, (bytes) =>
          Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
        );
        expect(
          yield* session.receive(appendRelayCompressionAdvertisement(request("1", "relay"))),
        ).toBe(true);
        expect(decodeResponse(yield* Queue.take(outputs))).toMatchObject({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: { value: "relay" } },
        });
        expect(
          yield* session.receive(appendRelayCompressionAdvertisement(subscribeShellRequest("2"))),
        ).toBe(true);
        const snapshot = yield* Queue.take(outputs);
        expect(snapshot[0]).toBe(0x7b);
        expect(decodeResponse(snapshot)).toMatchObject({ _tag: "Chunk", requestId: "2" });
      }),
    ),
  );
});

// ─── first response span ─────────────────────────────────────────────────────

const FIRST_RESPONSE_SPAN = "relay.rpc.first_response";

const PingItem = Schema.Struct({ index: Schema.Number });
const SubscribeRpc = Rpc.make("subscribe", {
  payload: Schema.Struct({}),
  success: PingItem,
  stream: true,
});
const SubscribeEmptyRpc = Rpc.make("subscribeEmpty", {
  payload: Schema.Struct({}),
  success: PingItem,
  stream: true,
});
const SubscribeIdleRpc = Rpc.make("subscribeIdle", {
  payload: Schema.Struct({}),
  success: PingItem,
  stream: true,
});
const FirstResponseGroup = RpcGroup.make(
  SubscribeRpc,
  SubscribeEmptyRpc,
  SubscribeIdleRpc,
  EchoRpc,
);
const firstResponseHandlers = FirstResponseGroup.toLayer(
  Effect.succeed(
    FirstResponseGroup.of({
      // Three separate chunks: only the first one is a "first response".
      subscribe: () =>
        Stream.concat(
          Stream.concat(Stream.make({ index: 0 }), Stream.make({ index: 1 })),
          Stream.make({ index: 2 }),
        ),
      subscribeEmpty: () => Stream.empty,
      subscribeIdle: () => Stream.never,
      echo: ({ value }: { readonly value: string }) => Effect.succeed({ value }),
    } as never),
  ),
);

const methodRequest = (id: string, tag: string) =>
  new TextEncoder().encode(JSON.stringify({ _tag: "Request", id, tag, payload: {}, headers: [] }));
const ackFor = (requestId: string) =>
  new TextEncoder().encode(JSON.stringify({ _tag: "Ack", requestId }));
const interruptFor = (requestId: string) =>
  new TextEncoder().encode(JSON.stringify({ _tag: "Interrupt", requestId }));

describe("RpcByteSession first response span", () => {
  it.live("records one span per streaming request, tagged with the method only", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const firstResponseSpans = () => spans.filter((span) => span.name === FIRST_RESPONSE_SPAN);
    const endedFirstResponseSpans = () =>
      firstResponseSpans().filter((span) => span.status._tag === "Ended");
    return Effect.scoped(
      Effect.gen(function* () {
        const outputs = yield* Queue.unbounded<Uint8Array>();
        const session = yield* makeRpcByteSession(
          FirstResponseGroup,
          firstResponseHandlers,
          (bytes) => Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
        );

        const streamIds = ["s1", "s2", "s3"];
        for (const id of streamIds) {
          expect(yield* session.receive(methodRequest(id, "subscribe"))).toBe(true);
        }
        expect(yield* session.receive(request("e1", "plain"))).toBe(true);
        expect(yield* session.receive(methodRequest("empty", "subscribeEmpty"))).toBe(true);
        expect(yield* session.receive(methodRequest("idle", "subscribeIdle"))).toBe(true);
        yield* Effect.yieldNow;
        expect(yield* session.receive(interruptFor("idle"))).toBe(true);

        // Acknowledge every chunk so each stream runs to its end.
        const exited = new Set<string>();
        const chunks = new Map<string, number>();
        while (!["s1", "s2", "s3", "e1", "empty"].every((id) => exited.has(id))) {
          const response = decodeResponse(yield* Queue.take(outputs));
          if (response.requestId === undefined) continue;
          if (response._tag === "Chunk") {
            chunks.set(response.requestId, (chunks.get(response.requestId) ?? 0) + 1);
            yield* session.receive(ackFor(response.requestId));
          }
          if (response._tag === "Exit") exited.add(response.requestId);
        }
        expect(chunks.get("s1")).toBeGreaterThan(1);

        // A stream that ended or was interrupted without writing a chunk never
        // had a first response, so its span stays open and is never reported.
        expect(firstResponseSpans()).toHaveLength(streamIds.length + 2);
        const recorded = endedFirstResponseSpans();
        expect(recorded).toHaveLength(streamIds.length);
        for (const span of recorded) {
          expect([...span.attributes.entries()]).toEqual([["rpc.method", "subscribe"]]);
          expect(span.status._tag).toBe("Ended");
          if (span.status._tag === "Ended") {
            expect(span.status.endTime).toBeGreaterThanOrEqual(span.status.startTime);
          }
        }
      }),
    ).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });
});

// ─── inbound burst ───────────────────────────────────────────────────────────

/** The inbound queue capacity the hub connector opens each relay channel's session with. */
const HUB_CONNECTOR_QUEUE_CAPACITY = 64;

const BurstItem = Schema.Struct({ kind: Schema.String });
const burstMethods = [
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.subscribeServerConfig,
  ORCHESTRATION_WS_METHODS.subscribeShell,
] as const;
const burstRpcs = [
  ...burstMethods,
  ORCHESTRATION_WS_METHODS.subscribeThreadWindow,
  WS_METHODS.subscribeVcsStatus,
].map((tag) => Rpc.make(tag, { payload: Schema.Struct({}), success: BurstItem, stream: true }));
const BurstGroup = RpcGroup.make(...(burstRpcs as [(typeof burstRpcs)[number]]));
const burstHandlers = BurstGroup.toLayer(
  Effect.succeed(
    BurstGroup.of(
      Object.fromEntries(
        burstRpcs.map((rpc) => [rpc._tag, () => Stream.make({ kind: rpc._tag })]),
      ) as never,
    ),
  ),
);

// A hosted connection's first flight: lifecycle, config, shell, a window per
// retained thread, and a few VCS statuses, all sent before anything is read.
const hostedFirstFlight = [
  ...burstMethods,
  ...Array.from({ length: 32 }, () => ORCHESTRATION_WS_METHODS.subscribeThreadWindow),
  ...Array.from({ length: 3 }, () => WS_METHODS.subscribeVcsStatus),
].map((tag, index) => methodRequest(String(index + 1), tag));

const sendFirstFlight = (queueCapacity: number | undefined) =>
  Effect.gen(function* () {
    const outputs = yield* Queue.unbounded<Uint8Array>();
    const consumerGate = yield* Deferred.make<void>();
    const session = yield* makeRpcByteSession(
      BurstGroup,
      burstHandlers,
      (bytes) => Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
      {
        ...(queueCapacity === undefined ? {} : { queueCapacity }),
        // Holds the session's consumer, so the burst lands on the inbound
        // queue with nothing draining it.
        interceptor: (message) =>
          Deferred.await(consumerGate).pipe(Effect.as({ kind: "rpc" as const, message })),
      },
    );
    const accepted: Array<boolean> = [];
    for (const bytes of hostedFirstFlight) accepted.push(yield* session.receive(bytes));
    return { session, outputs, consumerGate, accepted };
  });

describe("RpcByteSession inbound burst", () => {
  it.effect("receives a hosted first flight sent in one burst at the production capacity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(hostedFirstFlight).toHaveLength(38);
        const { session, outputs, consumerGate, accepted } = yield* sendFirstFlight(
          HUB_CONNECTOR_QUEUE_CAPACITY,
        );
        expect(accepted).toEqual(hostedFirstFlight.map(() => true));
        expect(yield* session.queuedMessages).toBeLessThanOrEqual(HUB_CONNECTOR_QUEUE_CAPACITY);

        // Every request is answered once the consumer runs: none was dropped.
        yield* Deferred.succeed(consumerGate, undefined);
        const exited = new Set<string>();
        while (exited.size < hostedFirstFlight.length) {
          const response = decodeResponse(yield* Queue.take(outputs));
          if (response.requestId === undefined) continue;
          if (response._tag === "Chunk") yield* session.receive(ackFor(response.requestId));
          if (response._tag === "Exit") exited.add(response.requestId);
        }
        expect(exited.size).toBe(hostedFirstFlight.length);
      }),
    ),
  );

  it.effect("drops part of the same burst when the inbound queue is smaller", () =>
    // Guards the test above: the burst only proves the capacity if a smaller
    // queue visibly overflows under the same load.
    Effect.scoped(
      Effect.gen(function* () {
        const { accepted } = yield* sendFirstFlight(16);
        expect(accepted.filter((admitted) => !admitted).length).toBeGreaterThan(0);
      }),
    ),
  );
});
