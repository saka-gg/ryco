import { Schema } from "effect";
import { RpcSerialization } from "effect/rpc";
import { describe, expect, it } from "vite-plus/test";

import { NonNegativeInt } from "./baseSchemas.ts";
import {
  ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS,
  ORCHESTRATION_WS_METHODS,
  OrchestrationArchivedThreadStub,
  OrchestrationGetThreadShellsInput,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
} from "./orchestration.ts";
import { WsOrchestrationGetThreadShellsRpc, WsOrchestrationSubscribeShellRpc } from "./rpc.ts";

/**
 * `subscribeShell`'s input exactly as servers declared it before `archivedThreads`
 * existed (51d889a9a): what an older server decodes a newer client's request with.
 */
const LegacySubscribeShellInput = Schema.Struct({
  resumeFromSequence: Schema.optional(NonNegativeInt),
  threadPriorities: Schema.optional(Schema.Literal("delta")),
  snapshotDelivery: Schema.optional(Schema.Literal("paged")),
});

/** The codec the RPC server decodes payloads with (`RpcSerialization.layerJson`). */
const serverPayloadCodec = <S extends Schema.Top>(schema: S) =>
  RpcSerialization.json.codecFor(schema);

describe("archived thread stubs: subscribeShell input compatibility", () => {
  it("lets an older server decode a newer client's request, dropping the stub flag", () => {
    // What a newer client sends on the wire.
    const wire = JSON.parse(
      JSON.stringify(
        Schema.encodeSync(serverPayloadCodec(OrchestrationSubscribeShellInput))({
          snapshotDelivery: "paged",
          threadPriorities: "delta",
          archivedThreads: "stub",
        }),
      ),
    );
    expect(wire).toEqual({
      snapshotDelivery: "paged",
      threadPriorities: "delta",
      archivedThreads: "stub",
    });
    // An older server's decode (the RPC server's default parse options) ignores the
    // unknown key: it answers as it always did, with full archived shells.
    expect(Schema.decodeUnknownSync(serverPayloadCodec(LegacySubscribeShellInput))(wire)).toEqual({
      snapshotDelivery: "paged",
      threadPriorities: "delta",
    });
  });

  it("decodes an older client's request (no stub flag) on a newer server", () => {
    const decoded = Schema.decodeUnknownSync(
      serverPayloadCodec(WsOrchestrationSubscribeShellRpc.payloadSchema),
    )({ snapshotDelivery: "paged" });
    expect(decoded).toEqual({ snapshotDelivery: "paged" });
    expect("archivedThreads" in decoded).toBe(false);
  });

  it("accepts only the one stub literal", () => {
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationSubscribeShellInput)({ archivedThreads: "lazy" }),
    ).toThrow();
  });
});

describe("archived thread stubs: wire shapes", () => {
  const stub = {
    id: "thread-1",
    projectId: "project-1",
    title: "  Padded  ",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    archivedAt: "2026-10-15T00:00:00.000Z",
    latestUserMessageAt: null,
    lineage: null,
  };

  it("validates a stub with the full shell's leaf schemas", () => {
    expect(Schema.decodeUnknownSync(OrchestrationArchivedThreadStub)(stub).title).toBe("Padded");
    // A stub is always archived.
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationArchivedThreadStub)({ ...stub, archivedAt: null }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationArchivedThreadStub)({ ...stub, title: "  " }),
    ).toThrow();
  });

  it("round-trips a stub page through the stream item schema", () => {
    const item = Schema.decodeUnknownSync(OrchestrationShellStreamItem)({
      kind: "snapshot-archived-threads",
      threads: [stub],
    });
    expect(item.kind).toBe("snapshot-archived-threads");
    const encoded = Schema.encodeSync(OrchestrationShellStreamItem)(item);
    expect(Schema.decodeUnknownSync(OrchestrationShellStreamItem)(encoded)).toEqual(item);
  });

  it("names the thread shells method and bounds its request", () => {
    expect(ORCHESTRATION_WS_METHODS.getThreadShells).toBe("orchestration.getThreadShells");
    expect(WsOrchestrationGetThreadShellsRpc._tag).toBe("orchestration.getThreadShells");
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `thread-${index}`);
    expect(
      Schema.decodeUnknownSync(OrchestrationGetThreadShellsInput)({
        threadIds: ids(ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS),
      }).threadIds,
    ).toHaveLength(ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS);
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationGetThreadShellsInput)({
        threadIds: ids(ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS + 1),
      }),
    ).toThrow();
  });
});
