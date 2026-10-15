import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Queue, Schema, Stream } from "effect";
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
import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
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
