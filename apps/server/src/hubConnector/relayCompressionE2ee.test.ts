import { inflateRawSync } from "node:zlib";

import { ORCHESTRATION_WS_METHODS, WsRpcGroup } from "@ryco/contracts";
import { E2EE_INNER_TYPE_RPC } from "@ryco/shared/relayE2eeWire";
import { RelayMessageAssembler } from "@ryco/shared/relayMessageChunks";
import {
  appendRelayCompressionAdvertisement,
  decodeCompressedRelayPayload,
  isCompressedRelayPayload,
} from "@ryco/shared/relayPayloadCompression";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeRpcByteSession } from "../ws/RpcByteSession.ts";
import { pageShellSnapshot } from "../ws/context/shellSnapshotPages.ts";
import { RelayResponseCompressor } from "../ws/relayResponseCompression.ts";
import { nodeE2eeRpcInterceptor, nodeE2eeRpcSink } from "./NodeE2eeRelayChannel.ts";
import {
  clientSend,
  establish,
  harness,
  type EstablishedClient,
} from "./testUtils/nodeE2eeChannelHarness.ts";

// Relay payload compression on a REAL E2EE channel: the node's channel session
// behind the real registry and send queue, an `RpcByteSession` bound to it with
// the very sink and interceptor `HubConnectorLive` uses, the production RPC
// group, and a client running the real Noise handshake and record session.
// `HubConnectorLive` itself is not instantiated — it is a service layer over a
// live Hub connection — so the binding is shared with it through
// `nodeE2eeRpcSink` / `nodeE2eeRpcInterceptor` rather than copied here.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SECRET = "DATABASE_URL=postgres://e2ee:s3cret@db.internal/app";

function shellThread(index: number) {
  return {
    id: `thread-${index}`,
    projectId: "project-e2ee",
    title: `Investigate relay case ${index % 37}`,
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `feature/relay-${index}`,
    worktreePath: null,
    latestTurn: null,
    goal: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const snapshot = {
  snapshotSequence: 1,
  projects: [
    {
      id: "project-e2ee",
      title: "E2EE",
      workspaceRoot: "/tmp/e2ee",
      defaultModelSelection: null,
      scripts: [
        { id: "m", name: "Migrate", command: SECRET, icon: "play", runOnWorktreeCreate: false },
      ],
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  ],
  worktrees: [],
  threads: Array.from({ length: 1_200 }, (_, index) => shellThread(index)),
  updatedAt: "2026-07-18T00:00:00.000Z",
};

async function e2eeNode() {
  return harness({
    rpc: async (e2ee) => {
      const scope = await Effect.runPromise(Scope.make("sequential"));
      // The byte session consumes on its own fiber; the harness's `deliver`
      // asserts on the wire as soon as it returns, so `receive` here resolves
      // once the payload it accepted has been through the interceptor.
      let accepted = 0;
      let intercepted = 0;
      const interceptor = nodeE2eeRpcInterceptor(e2ee);
      const session = await Effect.runPromise(
        makeRpcByteSession(
          WsRpcGroup,
          WsRpcGroup.toLayer(
            Effect.succeed(
              WsRpcGroup.of({
                [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
                  Stream.fromArrays(...pageShellSnapshot(snapshot as never, 96 * 1_024)),
              } as never),
            ),
          ),
          nodeE2eeRpcSink(e2ee),
          {
            queueCapacity: 64,
            interceptor: (message) =>
              interceptor(message).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    intercepted += 1;
                  }),
                ),
              ),
            onOutputFailure: () => e2ee.abandon(),
            compressor: new RelayResponseCompressor(),
          },
        ).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      return {
        session: {
          receive: async (bytes) => {
            const ok = await Effect.runPromise(session.receive(bytes));
            if (ok) accepted += 1;
            const behind = () => intercepted < accepted;
            for (let turn = 0; turn < 200 && behind(); turn += 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return ok;
          },
          queuedBytes: () => Effect.runPromise(session.queuedBytes),
          supportsChunkedMessages: session.supportsChunkedMessages,
          incompleteReassembly: session.incompleteReassembly,
        },
        release: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      };
    },
  });
}

interface Record {
  readonly envelopeBytes: number;
  readonly body: Uint8Array;
}

/** Subscribe to the shell over the E2EE channel and read it to its exit, acking each chunk. */
async function subscribe(advertise: boolean) {
  const node = await e2eeNode();
  const advertisement = await node.open();
  const client: EstablishedClient = await establish(node, "web", advertisement);
  const request = encoder.encode(
    JSON.stringify({
      _tag: "Request",
      id: "1",
      tag: ORCHESTRATION_WS_METHODS.subscribeShell,
      payload: { snapshotDelivery: "paged" },
      headers: [],
    }),
  );
  let cursor = node.dataPayloads().length;
  await clientSend(
    node,
    client,
    E2EE_INNER_TYPE_RPC,
    advertise ? appendRelayCompressionAdvertisement(request) : request,
  );
  const assembler = new RelayMessageAssembler();
  const records: Record[] = [];
  let done = false;
  while (!done) {
    await vi.waitFor(
      () => {
        node.flush();
        expect(node.dataPayloads().length).toBeGreaterThan(cursor);
      },
      { timeout: 5_000 },
    );
    for (const payload of node.dataPayloads().slice(cursor)) {
      cursor += 1;
      const assembled = assembler.push(payload);
      if (assembled.kind === "error") throw new Error(assembled.reason);
      if (assembled.kind === "pending") continue;
      const opened = client.record.unprotect(assembled.message);
      if (opened.kind !== "authenticated") throw new Error(JSON.stringify(opened));
      records.push({ envelopeBytes: assembled.message.byteLength, body: opened.body });
      const text = isCompressedRelayPayload(opened.body) ? inflate(opened.body) : opened.body;
      const message = JSON.parse(decoder.decode(text)) as { readonly _tag: string };
      if (message._tag === "Chunk") {
        await clientSend(
          node,
          client,
          E2EE_INNER_TYPE_RPC,
          encoder.encode(JSON.stringify({ _tag: "Ack", requestId: "1" })),
        );
      }
      if (message._tag === "Exit") done = true;
    }
  }
  return { node, records };
}

function inflate(frame: Uint8Array): Uint8Array {
  const decoded = decodeCompressedRelayPayload(frame);
  if (decoded.kind !== "ok") throw new Error(decoded.reason);
  return new Uint8Array(inflateRawSync(decoded.body));
}

describe("relay payload compression on a real E2EE channel", () => {
  it("compresses thread pages inside the encrypted records, never the project data", async () => {
    const { node, records } = await subscribe(true);
    const chunks = records.slice(0, -1);
    expect(chunks.length).toBeGreaterThan(3);
    expect(isCompressedRelayPayload(chunks[0]!.body)).toBe(false);
    expect(decoder.decode(chunks[0]!.body)).toContain("s3cret");
    for (const record of chunks.slice(1)) {
      expect(isCompressedRelayPayload(record.body)).toBe(true);
      expect(decoder.decode(inflate(record.body))).not.toContain("s3cret");
      // What the Hub sees is the record: the compressed frame plus constant overhead.
      expect(record.envelopeBytes).toBeLessThan(record.body.byteLength + 64);
    }
    // Every split chunk was acknowledged exactly once (the stream ran to its
    // exit) and the channel stayed open.
    expect(node.closeReasons()).toEqual([]);
  });

  it("sends plain JSON records to an E2EE client that never advertised", async () => {
    const { records } = await subscribe(false);
    expect(records.length).toBeGreaterThan(3);
    expect(records.some((record) => isCompressedRelayPayload(record.body))).toBe(false);
  });
});
