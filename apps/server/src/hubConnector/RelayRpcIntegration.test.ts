import { describe, expect, it } from "vite-plus/test";

import { MessageId, ORCHESTRATION_WS_METHODS, ThreadId, WsRpcGroup } from "@ryco/contracts";
import {
  RELAY_INITIAL_LIMITS,
  RELAY_MAX_DATA_CHUNK_BYTES,
  type RelayChannelId,
  type RelayFrame,
} from "@ryco/contracts/relay";
import { decodeRelayFrame } from "@ryco/shared/relayCodec";
import {
  RELAY_CHUNK_CAPABILITY_PRELUDE,
  RelayMessageAssembler,
} from "@ryco/shared/relayMessageChunks";
import { Effect, Exit, Scope } from "effect";

import { makeRpcByteSession } from "../ws/RpcByteSession.ts";
import type { WsRpcContext } from "../ws/context.ts";
import { makeOrchestrationHandlers } from "../ws/orchestrationRpc.ts";
import { RelayChannelRegistry } from "./RelayChannelRegistry.ts";
import { RelaySendQueue } from "./RelaySendQueue.ts";

const channelId = `ch_${"R".repeat(22)}` as RelayChannelId;
const version = { protocolMajor: 1, protocolMinor: 2 } as const;
const limits = RELAY_INITIAL_LIMITS;

const rawRequest = new TextEncoder().encode(
  JSON.stringify({
    _tag: "Request",
    id: "1",
    tag: ORCHESTRATION_WS_METHODS.searchThreadMessages,
    payload: { query: "needle", limit: 5 },
    headers: [],
  }),
);
const request = new Uint8Array(RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength + rawRequest.byteLength);
request.set(RELAY_CHUNK_CAPABILITY_PRELUDE);
request.set(rawRequest, RELAY_CHUNK_CAPABILITY_PRELUDE.byteLength);

function decode(bytes: Uint8Array): RelayFrame {
  const result = decodeRelayFrame(bytes);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("relay RPC integration", () => {
  it("runs an oversized Ryco RPC response through a canonical logical relay channel", async () => {
    const sent: Uint8Array[] = [];
    const socket = {
      bufferedAmount: 0,
      send: (bytes: Uint8Array) => sent.push(Uint8Array.from(bytes)),
    };
    const sendQueue = new RelaySendQueue(socket, limits);
    const oversizedSnippet = `payload-canary-${"x".repeat(RELAY_MAX_DATA_CHUNK_BYTES + 1_024)}`;
    const searchResult = {
      threadId: ThreadId.make("thread-relay-rpc"),
      messageId: MessageId.make("message-relay-rpc"),
      snippet: oversizedSnippet,
      timestamp: "2026-07-16T00:00:00.000Z",
    };
    const handlers = makeOrchestrationHandlers({
      withAccess: (_access: unknown, _method: string, effect: unknown) => effect,
      projectionSnapshotQuery: {
        searchThreadMessages: () => Effect.succeed([searchResult]),
      },
    } as unknown as WsRpcContext);
    const handlerLayer = WsRpcGroup.toLayer(
      Effect.succeed(
        WsRpcGroup.of({
          [ORCHESTRATION_WS_METHODS.searchThreadMessages]:
            handlers[ORCHESTRATION_WS_METHODS.searchThreadMessages],
        } as never),
      ),
    );
    const registry = new RelayChannelRegistry({
      limits,
      protocol: version,
      sendQueue,
      onOutboundReady: () => sendQueue.flush(),
      factory: {
        open: async ({ send }) => {
          const scope = await Effect.runPromise(Scope.make("sequential"));
          const session = await Effect.runPromise(
            makeRpcByteSession(
              WsRpcGroup,
              handlerLayer,
              (bytes) =>
                Effect.sync(() => {
                  if (!send(bytes).accepted) throw new Error("relay output full");
                }),
              { queueCapacity: 4 },
            ).pipe(Effect.provideService(Scope.Scope, scope)),
          );
          return {
            receive: (bytes: Uint8Array) => Effect.runPromise(session.receive(bytes)),
            queuedBytes: () => Effect.runPromise(session.queuedBytes),
            supportsChunkedMessages: session.supportsChunkedMessages,
            close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
          };
        },
      },
    });

    await registry.handle({
      type: "channel.open",
      ...version,
      channelId,
      capability: "ryco.rpc",
      effectiveRole: "viewer",
    });
    sendQueue.flush();
    expect(decode(sent[0]!).type).toBe("channel.accept");

    await registry.handle({
      type: "data",
      ...version,
      channelId,
      sequence: 0 as never,
      payload: request,
    });
    const assembler = new RelayMessageAssembler();
    let responseBytes: Uint8Array | undefined;
    let cursor = 1;
    for (let turn = 0; turn < 100 && responseBytes === undefined; turn += 1) {
      while (cursor < sent.length) {
        const frame = decode(sent[cursor++]!);
        if (frame.type !== "data") continue;
        const assembled = assembler.push(frame.payload);
        if (assembled.kind === "error") throw new Error(assembled.reason);
        if (assembled.kind === "done") responseBytes = assembled.message;
      }
      if (responseBytes !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      sent
        .slice(1)
        .map(decode)
        .filter((frame) => frame.type === "data").length,
    ).toBeGreaterThan(1);
    if (responseBytes === undefined) throw new Error("expected assembled relay RPC response");
    const response = JSON.parse(new TextDecoder().decode(responseBytes)) as {
      readonly requestId: string;
      readonly exit: {
        readonly _tag: string;
        readonly value: ReadonlyArray<{ readonly snippet: string }>;
      };
    };
    expect(response.requestId).toBe("1");
    expect(response.exit._tag).toBe("Success");
    expect(response.exit.value[0]?.snippet).toBe(oversizedSnippet);

    await registry.closeAll();
    expect(registry.size).toBe(0);
  });
});
