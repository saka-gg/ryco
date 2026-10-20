import {
  CheckpointRef,
  ContextHandoffId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ContextHandoffEndpointSnapshot,
  type OrchestrationThread,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { canonicalJson, sha256Hex } from "../../canonicalJson.ts";
import {
  ContextHandoffRepository,
  type ContextHandoffRecord,
  type ContextHandoffRepositoryShape,
  makeRequestedContextHandoffRecord,
} from "../../persistence/Services/ContextHandoffs.ts";
import { buildContextHandoffDocument } from "./ContextHandoffBuilder.ts";
import {
  ContextHandoffArtifactError,
  ContextHandoffService,
  ContextHandoffServiceLive,
} from "./ContextHandoffService.ts";

const createdAt = "2026-08-04T00:00:00.000Z";

// The SQLite repository stores both documents through this codec.
const JsonColumn = Schema.fromJsonString(Schema.Unknown);
const throughJsonColumn = (value: unknown): unknown =>
  Schema.decodeUnknownSync(JsonColumn)(Schema.encodeUnknownSync(JsonColumn)(value));

function throughJsonColumns(record: ContextHandoffRecord): ContextHandoffRecord {
  return {
    ...record,
    structuredContext:
      record.structuredContext === null ? null : throughJsonColumn(record.structuredContext),
    deliveryArtifact:
      record.deliveryArtifact === null ? null : throughJsonColumn(record.deliveryArtifact),
  };
}

/** A completed command whose output is `output`; its stored copy is cut at 16,000 characters. */
function commandActivity(output: string): OrchestrationThread["activities"][number] {
  return {
    id: EventId.make("activity-command"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: {
      itemType: "command_execution",
      data: {
        item: { type: "commandExecution", command: "bun run build", aggregatedOutput: output },
      },
    },
    turnId: TurnId.make("turn-prior"),
    createdAt: "2026-08-04T00:00:01.500Z",
  };
}

const TOOL_OUTPUT_MAX_CHARS = 16_000;
const outputCutAfterSpace = `${"x".repeat(TOOL_OUTPUT_MAX_CHARS - 1)} tail`;
const outputCutAfterNewline = `${"y".repeat(TOOL_OUTPUT_MAX_CHARS - 1)}\nnext line`;

function endpoint(instance: string, model: string): ContextHandoffEndpointSnapshot {
  return {
    providerInstanceId: ProviderInstanceId.make(instance),
    driverKind: ProviderDriverKind.make(instance.startsWith("claude") ? "claudeAgent" : "codex"),
    modelSlug: model,
  };
}

function thread(
  targetMessageId: MessageId,
  priorText = "canonical history",
  history: Pick<Partial<OrchestrationThread>, "activities" | "checkpoints"> = {},
): OrchestrationThread {
  return {
    id: ThreadId.make("thread-service"),
    projectId: ProjectId.make("project-service"),
    title: "Service context",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex_a"),
      model: "gpt-a",
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("message-prior"),
        role: "user",
        text: priorText,
        turnId: TurnId.make("turn-prior"),
        streaming: false,
        createdAt: "2026-08-04T00:00:01.000Z",
        updatedAt: "2026-08-04T00:00:01.000Z",
      },
      {
        id: targetMessageId,
        role: "user",
        text: "current message",
        turnId: TurnId.make("turn-target"),
        streaming: false,
        createdAt: "2026-08-04T00:00:02.000Z",
        updatedAt: "2026-08-04T00:00:02.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...history,
  };
}

function requestedRecord(handoffId: ContextHandoffId, targetMessageId: MessageId) {
  return makeRequestedContextHandoffRecord({
    handoffId,
    threadId: ThreadId.make("thread-service"),
    sourceSelection: {
      instanceId: ProviderInstanceId.make("codex_a"),
      model: "gpt-a",
    },
    targetSelection: {
      instanceId: ProviderInstanceId.make("claude_b"),
      model: "claude-b",
    },
    sourceRuntimeSessionId: RuntimeSessionId.make("runtime-source"),
    firstMessageId: targetMessageId,
    createdAt,
    updatedAt: createdAt,
  });
}

function memoryRepository(initial: ContextHandoffRecord) {
  let record = throughJsonColumns(initial);
  let storeCalls = 0;
  const service: ContextHandoffRepositoryShape = {
    create: () => Effect.succeed(false),
    getById: ({ handoffId }) =>
      Effect.succeed(handoffId === record.handoffId ? Option.some(record) : Option.none()),
    listByThread: () => Effect.succeed([record]),
    listRecoverable: () => Effect.succeed([record]),
    compareAndSetStatus: () => Effect.succeed(false),
    storeContextIfEmpty: (input) =>
      Effect.sync(() => {
        storeCalls += 1;
        if (record.structuredContext !== null || record.contextDigest !== null) {
          return false;
        }
        record = {
          ...record,
          contextVersion: input.contextVersion,
          structuredContext: throughJsonColumn(input.structuredContext),
          contextDigest: input.contextDigest,
          updatedAt: input.updatedAt,
        };
        return true;
      }),
    storeDeliveryArtifactIfEmpty: (input) =>
      Effect.sync(() => {
        if (record.deliveryArtifact !== null) return false;
        record = {
          ...record,
          deliveryArtifact: throughJsonColumn(input.deliveryArtifact),
          updatedAt: input.updatedAt,
        };
        return true;
      }),
  };
  return {
    layer: ContextHandoffServiceLive.pipe(
      Layer.provide(Layer.succeed(ContextHandoffRepository, service)),
    ),
    record: () => record,
    storeCalls: () => storeCalls,
    replace: (next: ContextHandoffRecord) => {
      record = throughJsonColumns(next);
    },
  };
}

function buildInput(handoffId: ContextHandoffId, handoffThread: OrchestrationThread) {
  return {
    handoffId,
    thread: handoffThread,
    targetMessageId: MessageId.make("message-target"),
    source: endpoint("codex_a", "gpt-a"),
    target: endpoint("claude_b", "claude-b"),
    updatedAt: "2026-08-04T00:00:03.000Z",
  };
}

/** A stored row as written before cut values were trimmed: the cut output keeps its space. */
function untrimmedStoredDocument(targetMessageId: MessageId) {
  const built = buildContextHandoffDocument(
    buildInput(
      ContextHandoffId.make("handoff-untrimmed"),
      thread(targetMessageId, "canonical history", {
        activities: [commandActivity(outputCutAfterSpace)],
      }),
    ),
  );
  const [tool] = built.document.tools;
  return {
    ...built.document,
    tools: [{ ...tool!, output: outputCutAfterSpace.slice(0, TOOL_OUTPUT_MAX_CHARS) }],
  };
}

it.effect("ContextHandoffService stores once and reuses deterministic bytes on retry", () => {
  const handoffId = ContextHandoffId.make("handoff-service");
  const targetMessageId = MessageId.make("message-target");
  const repository = memoryRepository(requestedRecord(handoffId, targetMessageId));
  return Effect.gen(function* () {
    const service = yield* ContextHandoffService;
    const first = yield* service.buildAndStore({
      handoffId,
      thread: thread(targetMessageId),
      targetMessageId,
      source: endpoint("codex_a", "gpt-a"),
      target: endpoint("claude_b", "claude-b"),
      updatedAt: "2026-08-04T00:00:03.000Z",
    });
    const retry = yield* service.buildAndStore({
      handoffId,
      thread: thread(targetMessageId, "history changed after preparation"),
      targetMessageId,
      source: endpoint("codex_a", "gpt-a"),
      target: endpoint("claude_b", "claude-b"),
      updatedAt: "2026-08-04T00:00:04.000Z",
    });

    assert.strictEqual(first.origin, "built");
    assert.strictEqual(retry.origin, "stored");
    assert.strictEqual(retry.canonicalJson, first.canonicalJson);
    assert.strictEqual(retry.digest, first.digest);
    assert.isFalse(retry.canonicalJson.includes("history changed after preparation"));
    assert.strictEqual(repository.storeCalls(), 1);
  }).pipe(Effect.provide(repository.layer));
});

it.effect("ContextHandoffService renders stored context with the exact separate message", () => {
  const handoffId = ContextHandoffId.make("handoff-render-service");
  const targetMessageId = MessageId.make("message-target");
  const repository = memoryRepository(requestedRecord(handoffId, targetMessageId));
  return Effect.gen(function* () {
    const service = yield* ContextHandoffService;
    yield* service.buildAndStore({
      handoffId,
      thread: thread(targetMessageId),
      targetMessageId,
      source: endpoint("codex_a", "gpt-a"),
      target: endpoint("claude_b", "claude-b"),
      updatedAt: "2026-08-04T00:00:03.000Z",
    });
    const currentMessage = "  exact message 😀\nwith whitespace  ";
    const rendered = yield* service.renderStoredContext({
      handoffId,
      currentMessage,
    });
    assert.isTrue(
      rendered.providerInput.includes(
        `<current_user_message>\n${currentMessage}\n</current_user_message>`,
      ),
    );
    assert.isFalse(rendered.renderedContextJson.includes(currentMessage));
  }).pipe(Effect.provide(repository.layer));
});

it.effect("ContextHandoffService persists and reuses the exact delivery artifact", () => {
  const handoffId = ContextHandoffId.make("handoff-delivery-service");
  const targetMessageId = MessageId.make("message-target");
  const repository = memoryRepository(requestedRecord(handoffId, targetMessageId));
  return Effect.gen(function* () {
    const service = yield* ContextHandoffService;
    yield* service.buildAndStore({
      handoffId,
      thread: thread(targetMessageId),
      targetMessageId,
      source: endpoint("codex_a", "gpt-a"),
      target: endpoint("claude_b", "claude-b"),
      updatedAt: "2026-08-04T00:00:03.000Z",
    });
    const currentMessage = "  exact message 😀  ";
    const first = yield* service.prepareDeliveryArtifact({
      handoffId,
      triggeringMessageId: targetMessageId,
      currentMessage,
      preparedAt: "2026-08-04T00:00:04.000Z",
    });
    const retry = yield* service.prepareDeliveryArtifact({
      maxInputChars: 1_400_000,
      budgetSource: "manifest",
      contextWindowTokens: 1_000_000,
      handoffId,
      triggeringMessageId: targetMessageId,
      currentMessage,
      preparedAt: "2026-08-04T00:00:05.000Z",
    });

    assert.strictEqual(first.providerInput, retry.providerInput);
    assert.strictEqual(first.providerInputDigest, retry.providerInputDigest);
    assert.strictEqual(first.preparedAt, "2026-08-04T00:00:04.000Z");
    assert.strictEqual(retry.preparedAt, first.preparedAt);
    assert.strictEqual(first.triggeringMessage.text, currentMessage);
    assert.deepStrictEqual(repository.record().deliveryArtifact, first);
    assert.strictEqual(retry.maxInputChars, first.maxInputChars);
    assert.strictEqual(retry.budgetSource, first.budgetSource);
    assert.strictEqual(retry.contextWindowTokens, first.contextWindowTokens);

    for (const change of [
      { currentMessage: "different message" },
      { triggeringMessageId: MessageId.make("different-message") },
    ]) {
      const error = yield* service
        .prepareDeliveryArtifact({
          handoffId,
          triggeringMessageId: targetMessageId,
          currentMessage,
          preparedAt: "2026-08-04T00:00:05.000Z",
          ...change,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ContextHandoffArtifactError);
      assert.strictEqual(error.reason, "delivery-artifact-conflict");
    }

    // Legacy artifacts without budget metadata still reuse the original bytes.
    const {
      maxInputChars: _budget,
      budgetSource: _source,
      contextWindowTokens: _tokens,
      ...legacy
    } = first;
    repository.replace({ ...repository.record(), deliveryArtifact: legacy });
    const legacyRetry = yield* service.prepareDeliveryArtifact({
      handoffId,
      triggeringMessageId: targetMessageId,
      currentMessage,
      preparedAt: "2026-08-04T00:00:05.000Z",
    });
    assert.strictEqual(legacyRetry.providerInput, first.providerInput);

    for (const corrupt of [
      { ...first, providerInput: "corrupted payload" },
      { ...first, renderedContext: { ...first.renderedContext, messages: [] } },
    ]) {
      repository.replace({ ...repository.record(), deliveryArtifact: corrupt });
      const error = yield* service
        .prepareDeliveryArtifact({
          handoffId,
          triggeringMessageId: targetMessageId,
          currentMessage,
          preparedAt: "2026-08-04T00:00:05.000Z",
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ContextHandoffArtifactError);
      assert.strictEqual(error.reason, "invalid-delivery-artifact");
    }
  }).pipe(Effect.provide(repository.layer));
});

it.effect(
  "ContextHandoffService rejects tampered stored artifacts without exposing their body",
  () => {
    const handoffId = ContextHandoffId.make("handoff-tampered");
    const targetMessageId = MessageId.make("message-target");
    const structuredContext = { secret: "must remain operational" };
    const repository = memoryRepository({
      ...requestedRecord(handoffId, targetMessageId),
      structuredContext,
      contextDigest: sha256Hex(canonicalJson(structuredContext)),
    });
    return Effect.gen(function* () {
      const service = yield* ContextHandoffService;
      const error = yield* service.loadStoredContext({ handoffId }).pipe(Effect.flip);
      assert.instanceOf(error, ContextHandoffArtifactError);
      assert.strictEqual(error.reason, "invalid-stored-context");
      assert.isFalse(error.message.includes("must remain operational"));
    }).pipe(Effect.provide(repository.layer));
  },
);

for (const [cut, output] of [
  ["a space", outputCutAfterSpace],
  ["a newline", outputCutAfterNewline],
] as const) {
  it.effect(
    `ContextHandoffService delivers a handoff whose tool output is cut after ${cut}`,
    () => {
      const handoffId = ContextHandoffId.make("handoff-cut-output");
      const targetMessageId = MessageId.make("message-target");
      const repository = memoryRepository(requestedRecord(handoffId, targetMessageId));
      return Effect.gen(function* () {
        const service = yield* ContextHandoffService;
        const built = yield* service.buildAndStore(
          buildInput(
            handoffId,
            thread(targetMessageId, "canonical history", { activities: [commandActivity(output)] }),
          ),
        );
        const delivery = {
          handoffId,
          triggeringMessageId: targetMessageId,
          currentMessage: "current message",
          preparedAt: "2026-08-04T00:00:04.000Z",
        };
        const first = yield* service.prepareDeliveryArtifact(delivery);
        const retry = yield* service.prepareDeliveryArtifact(delivery);
        const loaded = yield* service.loadStoredContext({ handoffId });

        assert.strictEqual(built.origin, "built");
        assert.strictEqual(loaded.digest, built.digest);
        assert.strictEqual(loaded.canonicalJson, built.canonicalJson);
        assert.strictEqual(
          loaded.document.tools[0]?.output,
          output.slice(0, TOOL_OUTPUT_MAX_CHARS - 1),
        );
        assert.isTrue(loaded.document.tools[0]?.truncated);
        assert.strictEqual(retry.providerInput, first.providerInput);
      }).pipe(Effect.provide(repository.layer));
    },
  );
}

it.effect(
  "ContextHandoffService accepts a stored document written before cut values were trimmed",
  () => {
    const handoffId = ContextHandoffId.make("handoff-untrimmed");
    const targetMessageId = MessageId.make("message-target");
    const structuredContext = untrimmedStoredDocument(targetMessageId);
    const storedJson = canonicalJson(structuredContext);
    const repository = memoryRepository({
      ...requestedRecord(handoffId, targetMessageId),
      contextVersion: 1,
      structuredContext,
      contextDigest: sha256Hex(storedJson),
    });
    return Effect.gen(function* () {
      const service = yield* ContextHandoffService;
      const loaded = yield* service.loadStoredContext({ handoffId });
      const delivery = yield* service.prepareDeliveryArtifact({
        handoffId,
        triggeringMessageId: targetMessageId,
        currentMessage: "current message",
        preparedAt: "2026-08-04T00:00:04.000Z",
      });

      assert.strictEqual(loaded.origin, "stored");
      assert.strictEqual(loaded.digest, sha256Hex(storedJson));
      assert.strictEqual(loaded.canonicalJson, storedJson);
      // Decoding trims the cut; the digest and canonical JSON stay the stored ones.
      assert.strictEqual(loaded.document.tools[0]?.output, "x".repeat(TOOL_OUTPUT_MAX_CHARS - 1));
      assert.notStrictEqual(sha256Hex(canonicalJson(loaded.document)), loaded.digest);
      assert.isTrue(delivery.providerInput.includes("x".repeat(TOOL_OUTPUT_MAX_CHARS - 1)));
    }).pipe(Effect.provide(repository.layer));
  },
);

it.effect("ContextHandoffService rejects a stored document edited after it was stored", () => {
  const handoffId = ContextHandoffId.make("handoff-edited");
  const targetMessageId = MessageId.make("message-target");
  const original = untrimmedStoredDocument(targetMessageId);
  const edited = {
    ...original,
    tools: [
      { ...original.tools[0]!, output: `z${outputCutAfterSpace.slice(1, TOOL_OUTPUT_MAX_CHARS)}` },
    ],
  };
  const repository = memoryRepository({
    ...requestedRecord(handoffId, targetMessageId),
    contextVersion: 1,
    structuredContext: edited,
    contextDigest: sha256Hex(canonicalJson(original)),
  });
  return Effect.gen(function* () {
    const service = yield* ContextHandoffService;
    const error = yield* service.loadStoredContext({ handoffId }).pipe(Effect.flip);
    assert.instanceOf(error, ContextHandoffArtifactError);
    assert.strictEqual(error.reason, "digest-mismatch");
  }).pipe(Effect.provide(repository.layer));
});

it.effect("ContextHandoffService reuses a stored delivery artifact it had to compact", () => {
  const handoffId = ContextHandoffId.make("handoff-compacted");
  const targetMessageId = MessageId.make("message-target");
  // The stored copy keeps 2,000 characters of it; a 1,500 character budget must shorten that.
  const longPath = `src/${"nested/".repeat(700)}file.ts`;
  const repository = memoryRepository(requestedRecord(handoffId, targetMessageId));
  return Effect.gen(function* () {
    const service = yield* ContextHandoffService;
    yield* service.buildAndStore(
      buildInput(
        handoffId,
        thread(targetMessageId, "canonical history", {
          activities: [commandActivity("z".repeat(9_000))],
          checkpoints: [
            {
              turnId: TurnId.make("turn-prior"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("checkpoint-1"),
              status: "ready",
              files: [{ path: longPath, kind: "modified", additions: 1, deletions: 0 }],
              assistantMessageId: null,
              completedAt: "2026-08-04T00:00:01.800Z",
            },
          ],
        }),
      ),
    );
    const delivery = {
      handoffId,
      triggeringMessageId: targetMessageId,
      currentMessage: "current message",
      maxInputChars: 1_500,
    };
    const first = yield* service.prepareDeliveryArtifact({
      ...delivery,
      preparedAt: "2026-08-04T00:00:04.000Z",
    });
    const retry = yield* service.prepareDeliveryArtifact({
      ...delivery,
      preparedAt: "2026-08-04T00:00:05.000Z",
    });

    assert.isTrue(first.truncated);
    const compactedPath = first.renderedContext.checkpoints?.[0]?.files[0]?.path;
    assert.isTrue(compactedPath !== undefined && compactedPath.length <= 1_024);
    assert.strictEqual(retry.providerInput, first.providerInput);
    assert.strictEqual(retry.preparedAt, first.preparedAt);
  }).pipe(Effect.provide(repository.layer));
});
