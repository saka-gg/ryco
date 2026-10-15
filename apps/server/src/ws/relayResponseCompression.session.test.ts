import { inflateRawSync } from "node:zlib";

import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  WS_METHODS,
  WsRpcGroup,
} from "@ryco/contracts";
import {
  appendRelayCompressionAdvertisement,
  decodeCompressedRelayPayload,
  isCompressedRelayPayload,
} from "@ryco/shared/relayPayloadCompression";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeRpcByteSession } from "./RpcByteSession.ts";
import { pageShellSnapshot } from "./context/shellSnapshotPages.ts";
import {
  RELAY_COMPRESSION_ALLOWLIST,
  RELAY_COMPRESSION_OPT_IN_CLASSES,
  RelayResponseCompressor,
} from "./relayResponseCompression.ts";

// The allowlist over REAL Effect RPC traffic: the production group, its
// schemas encoding every response, and the byte session the relay runs on.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SECRET = "Authorization: Bearer ghp_relaySessionTestSecret0123456789";

interface Received {
  readonly compressed: boolean;
  readonly bytes: Uint8Array;
  readonly message: {
    readonly _tag: string;
    readonly requestId?: string;
    readonly values?: ReadonlyArray<{ readonly kind?: string; readonly type?: string }>;
    readonly exit?: { readonly _tag: string; readonly cause?: ReadonlyArray<{ _tag: string }> };
  };
}

async function openSession(
  handlers: Record<string, unknown>,
  compressor: RelayResponseCompressor = new RelayResponseCompressor(),
) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const outputs = await Effect.runPromise(Queue.unbounded<Uint8Array>());
  const session = await Effect.runPromise(
    makeRpcByteSession(
      WsRpcGroup,
      WsRpcGroup.toLayer(Effect.succeed(WsRpcGroup.of(handlers as never))),
      (bytes) => Queue.offer(outputs, Uint8Array.from(bytes)).pipe(Effect.asVoid),
      { compressor },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const send = (message: unknown, advertise = true) => {
    const bytes = encoder.encode(JSON.stringify(message));
    return Effect.runPromise(
      session.receive(advertise ? appendRelayCompressionAdvertisement(bytes) : bytes),
    );
  };
  const next = async (): Promise<Received> => {
    const bytes = await Effect.runPromise(Queue.take(outputs));
    let text = bytes;
    if (isCompressedRelayPayload(bytes)) {
      const frame = decodeCompressedRelayPayload(bytes);
      if (frame.kind !== "ok") throw new Error(frame.reason);
      text = new Uint8Array(inflateRawSync(frame.body));
    }
    return {
      compressed: isCompressedRelayPayload(bytes),
      bytes: text,
      message: JSON.parse(decoder.decode(text)) as Received["message"],
    };
  };
  /** Read until this request's exit, acknowledging every chunk as a client does. */
  const drain = async (requestId: string): Promise<Received[]> => {
    const received: Received[] = [];
    while (true) {
      const response = await next();
      received.push(response);
      if (response.message._tag === "Chunk") await send({ _tag: "Ack", requestId }, false);
      // A handler defect is reported to the whole connection as `Defect`.
      if (
        response.message._tag === "Defect" ||
        (response.message._tag === "Exit" && response.message.requestId === requestId)
      ) {
        return received;
      }
    }
  };
  return {
    send,
    drain,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

const request = (id: string, tag: string, payload: unknown = {}) => ({
  _tag: "Request",
  id,
  tag,
  payload,
  headers: [],
});

function shellThread(index: number) {
  return {
    id: `thread-${index}`,
    projectId: "project-session-test",
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

const shellSnapshot = {
  snapshotSequence: 3,
  projects: [
    {
      id: "project-session-test",
      title: "Session test",
      workspaceRoot: "/tmp/session-test",
      defaultModelSelection: null,
      customSystemPrompt: `Use this token when calling the API: ${SECRET}`,
      scripts: [
        {
          id: "deploy",
          name: "Deploy",
          command: `curl -H '${SECRET}'`,
          icon: "play",
          runOnWorktreeCreate: false,
        },
      ],
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  ],
  worktrees: [],
  threads: Array.from({ length: 1_500 }, (_, index) => shellThread(index)),
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const provider = (index: number): ServerProvider => ({
  instanceId: ProviderInstanceId.make(`provider-${index}`),
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T00:00:00.000Z",
  models: Array.from({ length: 200 }, (_, model) => ({
    slug: `vendor-${model % 9}/model-${model}`,
    name: `Model ${model}`,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

describe("relay compression over real RPC traffic", () => {
  it("compresses paged shell thread pages and never the project data", async () => {
    const session = await openSession({
      [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
        Stream.fromArrays(...pageShellSnapshot(shellSnapshot as never, 128 * 1_024)),
    });
    await session.send(
      request("1", ORCHESTRATION_WS_METHODS.subscribeShell, { snapshotDelivery: "paged" }),
    );
    const received = await session.drain("1");
    const chunks = received.filter((response) => response.message._tag === "Chunk");
    expect(chunks.length).toBeGreaterThan(3);
    // `snapshot-begin` alone and uncompressed, then nothing but compressed pages.
    expect(chunks[0]!.compressed).toBe(false);
    expect(chunks[0]!.message.values?.map((value) => value.kind)).toEqual(["snapshot-begin"]);
    expect(chunks.slice(1).every((chunk) => chunk.compressed)).toBe(true);
    for (const chunk of received) {
      if (chunk.compressed) expect(decoder.decode(chunk.bytes)).not.toContain("ghp_");
    }
    expect(decoder.decode(chunks[0]!.bytes)).toContain("ghp_");
    expect(received.at(-1)!.message.exit?._tag).toBe("Success");
    await session.close();
  });

  it("never compresses the unpaged shell snapshot, which carries projects", async () => {
    const session = await openSession({
      [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
        Stream.make({ kind: "snapshot", snapshot: shellSnapshot }),
    });
    await session.send(request("1", ORCHESTRATION_WS_METHODS.subscribeShell));
    const received = await session.drain("1");
    expect(received[0]!.bytes.byteLength).toBeGreaterThan(100_000);
    expect(received.some((response) => response.compressed)).toBe(false);
    await session.close();
  });

  it("leaves a real failure and a real defect of an allowlisted stream uncompressed", async () => {
    const session = await openSession({
      [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: { readonly snapshotDelivery?: string }) =>
        input.snapshotDelivery === "paged"
          ? Stream.fail(new OrchestrationGetSnapshotError({ message: "x".repeat(40_000) }))
          : Stream.die(new Error("y".repeat(40_000))),
    });
    await session.send(
      request("1", ORCHESTRATION_WS_METHODS.subscribeShell, { snapshotDelivery: "paged" }),
    );
    const failed = await session.drain("1");
    expect(failed.at(-1)!.message.exit?._tag).toBe("Failure");
    expect(failed.at(-1)!.bytes.byteLength).toBeGreaterThan(40_000);
    expect(failed.some((response) => response.compressed)).toBe(false);
    await session.send(request("2", ORCHESTRATION_WS_METHODS.subscribeShell));
    const died = await session.drain("2");
    expect(died.at(-1)!.message._tag).toBe("Defect");
    expect(died.at(-1)!.bytes.byteLength).toBeGreaterThan(40_000);
    expect(died.some((response) => response.compressed)).toBe(false);
    await session.close();
  });

  it("compresses a full provider list and leaves the delta that follows it plain", async () => {
    const providers = Array.from({ length: 4 }, (_, index) => provider(index));
    const session = await openSession({
      [WS_METHODS.subscribeServerConfig]: () =>
        Stream.make(
          { version: 1, type: "providerStatuses", payload: { providers } },
          {
            version: 1,
            type: "providerStatusesDelta",
            payload: { instanceIds: providers.map((entry) => entry.instanceId), providers },
          },
        ).pipe(Stream.rechunk(1)),
    });
    await session.send(request("1", WS_METHODS.subscribeServerConfig));
    const chunks = (await session.drain("1")).filter(
      (response) => response.message._tag === "Chunk",
    );
    expect(chunks.map((chunk) => chunk.message.values?.[0]?.type)).toEqual([
      "providerStatuses",
      "providerStatusesDelta",
    ]);
    expect(chunks.map((chunk) => chunk.compressed)).toEqual([true, false]);
    expect(chunks[1]!.bytes.byteLength).toBeGreaterThan(16 * 1_024);
    await session.close();
  });

  it("leaves an opted-in thread window's real failure and defect uncompressed", async () => {
    const session = await openSession(
      {
        [ORCHESTRATION_WS_METHODS.getThreadWindow]: (input: { readonly threadId: string }) =>
          input.threadId === "fail"
            ? Effect.fail(new OrchestrationGetSnapshotError({ message: "z".repeat(40_000) }))
            : Effect.die(new Error("w".repeat(40_000))),
      },
      new RelayResponseCompressor({
        allowlist: { ...RELAY_COMPRESSION_ALLOWLIST, ...RELAY_COMPRESSION_OPT_IN_CLASSES },
      }),
    );
    const limits = { messages: 10, proposedPlans: 10, activities: 10, checkpoints: 10 };
    await session.send(
      request("1", ORCHESTRATION_WS_METHODS.getThreadWindow, { threadId: "fail", limits }),
    );
    const [failure] = await session.drain("1");
    expect(failure!.message.exit?._tag).toBe("Failure");
    expect(failure!.message.exit?.cause?.[0]?._tag).toBe("Fail");
    expect(failure!.bytes.byteLength).toBeGreaterThan(40_000);
    expect(failure!.compressed).toBe(false);
    await session.send(
      request("2", ORCHESTRATION_WS_METHODS.getThreadWindow, { threadId: "die", limits }),
    );
    const [defect] = await session.drain("2");
    expect(defect!.message._tag).toBe("Defect");
    expect(defect!.bytes.byteLength).toBeGreaterThan(40_000);
    expect(defect!.compressed).toBe(false);
    await session.close();
  });
});
