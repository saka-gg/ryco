import {
  ContextHandoffId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { sha256Hex } from "../../canonicalJson.ts";
import {
  ContextHandoffRepository,
  type ContextHandoffRecord,
  makeRequestedContextHandoffRecord,
} from "../../persistence/Services/ContextHandoffs.ts";
import { ContextHandoffInspection } from "../Services/ContextHandoffInspection.ts";
import {
  countContextHandoffEntries,
  stableStringifyContextHandoff,
  type ContextHandoffDocument,
} from "../contextHandoff/ContextHandoffBuilder.ts";
import { makeContextHandoffDeliveryArtifact } from "../contextHandoff/ContextHandoffArtifacts.ts";
import { ContextHandoffInspectionLive } from "./ContextHandoffInspection.ts";

const threadId = ThreadId.make("thread-inspection-service");
const handoffId = ContextHandoffId.make("handoff-inspection-service");
const messageId = MessageId.make("message-trigger");
const createdAt = "2026-08-05T10:00:00.000Z";
const source = {
  providerInstanceId: ProviderInstanceId.make("codex_work"),
  driverKind: ProviderDriverKind.make("codex"),
  modelSlug: "gpt-5.6-sol",
  modelDisplayName: "GPT-5.6 Sol",
};
const target = {
  providerInstanceId: ProviderInstanceId.make("claude_work"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  modelSlug: "claude-fable-5",
  modelDisplayName: "Fable 5",
};
const document: ContextHandoffDocument = {
  version: 1,
  mode: "full-context-fresh-session",
  thread: { id: threadId, title: "Inspection", branch: null, worktreePath: null },
  provenance: { sources: [source], target },
  messages: [],
  plans: [],
  tools: [],
  checkpoints: [],
  notices: [],
  subagents: [],
  priorHandoffs: [],
};
const canonicalJson = stableStringifyContextHandoff(document);
const providerInput = `<context>${canonicalJson}</context>\n<current_user_message>exact 😀</current_user_message>`;
const deliveryArtifact = makeContextHandoffDeliveryArtifact({
  maxInputChars: 1_400_000,
  budgetSource: "manifest",
  contextWindowTokens: 1_000_000,
  renderedContext: document,
  renderedContextJson: canonicalJson,
  providerInput,
  triggeringMessageId: messageId,
  triggeringMessage: "exact 😀",
  includedEntryCount: countContextHandoffEntries(document),
  totalEntryCount: countContextHandoffEntries(document),
  contextChars: canonicalJson.length,
  inputChars: providerInput.length,
  truncated: false,
  preparedAt: createdAt,
});
const record = {
  ...makeRequestedContextHandoffRecord({
    handoffId,
    threadId,
    sourceSelection: {
      instanceId: source.providerInstanceId,
      model: source.modelSlug,
    },
    targetSelection: {
      instanceId: target.providerInstanceId,
      model: target.modelSlug,
    },
    sourceRuntimeSessionId: RuntimeSessionId.make("runtime-source"),
    firstMessageId: messageId,
    createdAt,
    updatedAt: createdAt,
  }),
  status: "consumed" as const,
  contextVersion: 1,
  structuredContext: document,
  contextDigest: sha256Hex(canonicalJson),
  deliveryArtifact,
  targetRuntimeSessionId: RuntimeSessionId.make("runtime-target"),
  acceptedProviderTurnId: TurnId.make("turn-target"),
};

function layerFor(stored: ContextHandoffRecord) {
  return ContextHandoffInspectionLive.pipe(
    Layer.provide(
      Layer.mock(ContextHandoffRepository)({
        getById: ({ handoffId: requestedId }) =>
          Effect.succeed(requestedId === stored.handoffId ? Option.some(stored) : Option.none()),
      }),
    ),
  );
}

const layer = layerFor(record);

/** A stored document as written before cut values were trimmed: the tool output keeps its space. */
const untrimmedDocument = {
  ...document,
  tools: [
    {
      id: "tool-1",
      createdAt,
      turnId: null,
      lifecycle: "completed",
      itemType: "command_execution",
      summary: "Ran command",
      output: `${"x".repeat(15_999)} `,
      paths: [],
      fileChanges: [],
      truncated: true,
    },
  ],
};
const untrimmedJson = stableStringifyContextHandoff(untrimmedDocument);

it.effect("ContextHandoffInspection serves bounded exact and complete artifacts", () =>
  Effect.gen(function* () {
    const inspection = yield* ContextHandoffInspection;
    const summary = yield* inspection.getSummary({ threadId, handoffId });
    assert.strictEqual(summary.maxInputChars, 1_400_000);
    assert.strictEqual(summary.budgetSource, "manifest");
    assert.strictEqual(summary.contextWindowTokens, 1_000_000);
    assert.strictEqual(summary.deliveryLabel, "sent");
    assert.strictEqual(summary.sent.available, true);
    assert.strictEqual(summary.sent.digest, deliveryArtifact.providerInputDigest);
    assert.deepStrictEqual(summary.sent.sections, [
      { section: "triggeringMessage", entryCount: 1 },
    ]);
    assert.isFalse(JSON.stringify(summary).includes("exact 😀"));

    const trigger = yield* inspection.listEntries({
      threadId,
      handoffId,
      scope: "sent",
      section: "triggeringMessage",
    });
    assert.strictEqual(trigger.entries.length, 1);
    assert.strictEqual((trigger.entries[0]!.value as { readonly text: string }).text, "exact 😀");

    const raw = yield* inspection.readRawChunk({
      threadId,
      handoffId,
      scope: "sent",
      offset: 0,
    });
    assert.strictEqual(raw.chunk, providerInput);
    assert.strictEqual(raw.digest, deliveryArtifact.providerInputDigest);

    const exported = yield* inspection.readExportChunk({
      threadId,
      handoffId,
      scope: "complete",
      format: "json",
      offset: 0,
    });
    assert.strictEqual(
      exported.filename,
      `${"ryco-context-handoff-handoff-inspection-service-complete.json"}`,
    );
    assert.strictEqual(JSON.parse(exported.chunk).scope, "complete");
  }).pipe(Effect.provide(layer)),
);

it.effect("ContextHandoffInspection hides cross-thread handoff ids as not found", () =>
  Effect.gen(function* () {
    const inspection = yield* ContextHandoffInspection;
    const error = yield* inspection
      .getSummary({ threadId: ThreadId.make("thread-other"), handoffId })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "not-found");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "ContextHandoffInspection serves a stored document written before cut values were trimmed",
  () =>
    Effect.gen(function* () {
      const inspection = yield* ContextHandoffInspection;
      const summary = yield* inspection.getSummary({ threadId, handoffId });
      const raw = yield* inspection.readRawChunk({
        threadId,
        handoffId,
        scope: "complete",
        offset: 0,
      });
      const tools = yield* inspection.listEntries({
        threadId,
        handoffId,
        scope: "complete",
        section: "tools",
      });

      assert.strictEqual(summary.complete.digest, sha256Hex(untrimmedJson));
      assert.strictEqual(summary.complete.entryCount, 1);
      assert.strictEqual(raw.chunk, untrimmedJson);
      assert.strictEqual(
        (tools.entries[0]!.value as { readonly output: string }).output,
        "x".repeat(15_999),
      );
    }).pipe(
      Effect.provide(
        layerFor({
          ...record,
          deliveryArtifact: null,
          structuredContext: JSON.parse(untrimmedJson),
          contextDigest: sha256Hex(untrimmedJson),
        }),
      ),
    ),
);

it.effect("ContextHandoffInspection reports edited stored artifacts as invalid", () =>
  Effect.gen(function* () {
    const edited = {
      ...untrimmedDocument,
      tools: [{ ...untrimmedDocument.tools[0]!, output: `z${untrimmedDocument.tools[0]!.output}` }],
    };
    for (const stored of [
      { ...record, structuredContext: edited, contextDigest: sha256Hex(untrimmedJson) },
      { ...record, deliveryArtifact: { ...deliveryArtifact, providerInput: "edited payload" } },
    ]) {
      const error = yield* ContextHandoffInspection.pipe(
        Effect.flatMap((inspection) => inspection.getSummary({ threadId, handoffId })),
        Effect.flip,
        Effect.provide(layerFor(stored)),
      );
      assert.strictEqual(error.reason, "invalid-artifact");
    }
  }),
);

it.effect(
  "ContextHandoffInspection leaves legacy budgets unknown without changing stored digests",
  () => {
    const legacyArtifact = Object.fromEntries(
      Object.entries(deliveryArtifact).filter(
        ([key]) => !["maxInputChars", "budgetSource", "contextWindowTokens"].includes(key),
      ),
    );
    const legacyRecord = { ...record, deliveryArtifact: legacyArtifact };
    const storedJson = JSON.stringify(legacyRecord);
    const legacyLayer = ContextHandoffInspectionLive.pipe(
      Layer.provide(
        Layer.mock(ContextHandoffRepository)({
          getById: () => Effect.succeed(Option.some(legacyRecord)),
        }),
      ),
    );
    return Effect.gen(function* () {
      const inspection = yield* ContextHandoffInspection;
      const summary = yield* inspection.getSummary({ threadId, handoffId });
      assert.isNull(summary.maxInputChars);
      assert.isNull(summary.budgetSource);
      assert.isNull(summary.contextWindowTokens);
      assert.strictEqual(summary.sent.digest, deliveryArtifact.providerInputDigest);
      assert.strictEqual(JSON.stringify(legacyRecord), storedJson);
    }).pipe(Effect.provide(legacyLayer));
  },
);
