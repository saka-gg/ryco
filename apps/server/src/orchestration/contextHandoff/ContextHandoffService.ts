import {
  CONTEXT_HANDOFF_CONTEXT_VERSION,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ContextHandoffInputBudget,
  type ContextHandoffEndpointSnapshot,
  type ContextHandoffId,
  type MessageId,
  type OrchestrationThread,
} from "@ryco/contracts";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";

import type { ContextHandoffRepositoryError } from "../../persistence/Errors.ts";
import {
  ContextHandoffRepository,
  type ContextHandoffRecord,
} from "../../persistence/Services/ContextHandoffs.ts";
import {
  type ContextHandoffArtifact,
  buildContextHandoffDocument,
} from "./ContextHandoffBuilder.ts";
import {
  type ContextHandoffDeliveryArtifact,
  ContextHandoffDeliveryArtifact as ContextHandoffDeliveryArtifactSchema,
  makeContextHandoffDeliveryArtifact,
  hasValidContextHandoffDeliveryDigests,
} from "./ContextHandoffArtifacts.ts";
import { verifyStoredContextHandoffDocument } from "./ContextHandoffIntegrity.ts";
import {
  ContextHandoffRenderError,
  type ContextHandoffRenderResult,
  renderContextHandoffInput,
} from "./ContextHandoffRenderer.ts";

export class ContextHandoffArtifactError extends Data.TaggedError("ContextHandoffArtifactError")<{
  readonly reason:
    | "record-not-found"
    | "record-mismatch"
    | "missing-stored-context"
    | "invalid-context"
    | "invalid-stored-context"
    | "digest-mismatch"
    | "invalid-delivery-artifact"
    | "delivery-artifact-conflict";
  readonly handoffId: ContextHandoffId;
  readonly message: string;
}> {}

export type ContextHandoffServiceError =
  | ContextHandoffArtifactError
  | ContextHandoffRenderError
  | ContextHandoffRepositoryError;

export interface BuildAndStoreContextHandoffInput {
  readonly handoffId: ContextHandoffId;
  readonly thread: OrchestrationThread;
  readonly targetMessageId: MessageId;
  readonly source: ContextHandoffEndpointSnapshot;
  readonly target: ContextHandoffEndpointSnapshot;
  readonly updatedAt: string;
}

export interface LoadStoredContextHandoffInput {
  readonly handoffId: ContextHandoffId;
}

export interface RenderStoredContextHandoffInput {
  readonly handoffId: ContextHandoffId;
  /** Passed separately so canonical history and the stored artifact never rewrite it. */
  readonly currentMessage: string;
  readonly maxInputChars?: number | undefined;
}

export interface PrepareContextHandoffDeliveryInput extends RenderStoredContextHandoffInput {
  readonly budgetSource?: ContextHandoffInputBudget["budgetSource"];
  readonly contextWindowTokens?: number | null;
  readonly triggeringMessageId: MessageId;
  readonly preparedAt: string;
}

export interface PreparedContextHandoffArtifact extends ContextHandoffArtifact {
  readonly origin: "built" | "stored";
}

export interface ContextHandoffServiceShape {
  readonly buildAndStore: (
    input: BuildAndStoreContextHandoffInput,
  ) => Effect.Effect<PreparedContextHandoffArtifact, ContextHandoffServiceError>;
  readonly loadStoredContext: (
    input: LoadStoredContextHandoffInput,
  ) => Effect.Effect<PreparedContextHandoffArtifact, ContextHandoffServiceError>;
  readonly renderStoredContext: (
    input: RenderStoredContextHandoffInput,
  ) => Effect.Effect<ContextHandoffRenderResult, ContextHandoffServiceError>;
  readonly prepareDeliveryArtifact: (
    input: PrepareContextHandoffDeliveryInput,
  ) => Effect.Effect<ContextHandoffDeliveryArtifact, ContextHandoffServiceError>;
}

export class ContextHandoffService extends Context.Service<
  ContextHandoffService,
  ContextHandoffServiceShape
>()("ryco/orchestration/contextHandoff/ContextHandoffService") {}

function artifactError(
  handoffId: ContextHandoffId,
  reason: ContextHandoffArtifactError["reason"],
  message: string,
) {
  return new ContextHandoffArtifactError({ handoffId, reason, message });
}

function recordMatchesBuildInput(
  record: ContextHandoffRecord,
  input: BuildAndStoreContextHandoffInput,
): boolean {
  return (
    record.threadId === input.thread.id &&
    record.firstMessageId === input.targetMessageId &&
    record.sourceSelection.instanceId === input.source.providerInstanceId &&
    record.sourceSelection.model === input.source.modelSlug &&
    record.targetSelection.instanceId === input.target.providerInstanceId &&
    record.targetSelection.model === input.target.modelSlug
  );
}

const makeContextHandoffService = Effect.gen(function* () {
  const repository = yield* ContextHandoffRepository;

  const requireRecord = Effect.fn("ContextHandoffService.requireRecord")(function* (
    handoffId: ContextHandoffId,
  ) {
    const record = yield* repository.getById({ handoffId });
    return yield* Option.match(record, {
      onNone: () =>
        Effect.fail(
          artifactError(handoffId, "record-not-found", "Context handoff operation was not found"),
        ),
      onSome: Effect.succeed,
    });
  });

  const decodeStoredArtifact = Effect.fn("ContextHandoffService.decodeStoredArtifact")(function* (
    record: ContextHandoffRecord,
  ) {
    if (record.structuredContext === null || record.contextDigest === null) {
      return yield* artifactError(
        record.handoffId,
        "missing-stored-context",
        "Context handoff artifact has not been stored",
      );
    }
    const artifact = yield* verifyStoredContextHandoffDocument(
      record.structuredContext,
      record.contextDigest,
    ).pipe(
      Effect.mapError((error) =>
        error.reason === "digest-mismatch"
          ? artifactError(
              record.handoffId,
              "digest-mismatch",
              "Stored context handoff artifact digest does not match",
            )
          : artifactError(
              record.handoffId,
              "invalid-stored-context",
              "Stored context handoff artifact failed validation",
            ),
      ),
    );
    return { ...artifact, origin: "stored" as const };
  });

  const loadStoredContext: ContextHandoffServiceShape["loadStoredContext"] = ({ handoffId }) =>
    requireRecord(handoffId).pipe(Effect.flatMap(decodeStoredArtifact));

  const buildAndStore: ContextHandoffServiceShape["buildAndStore"] = (input) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(input.handoffId);
      if (!recordMatchesBuildInput(record, input)) {
        return yield* artifactError(
          input.handoffId,
          "record-mismatch",
          "Context handoff operation does not match the requested history boundary",
        );
      }
      if (record.structuredContext !== null || record.contextDigest !== null) {
        return yield* decodeStoredArtifact(record);
      }

      const artifact = yield* Effect.try({
        try: () => buildContextHandoffDocument(input),
        // The cause can quote history; the error keeps it out of activities and logs.
        catch: () =>
          artifactError(
            input.handoffId,
            "invalid-context",
            "Context handoff artifact failed validation",
          ),
      });
      const stored = yield* repository.storeContextIfEmpty({
        handoffId: input.handoffId,
        contextVersion: CONTEXT_HANDOFF_CONTEXT_VERSION,
        structuredContext: artifact.document,
        contextDigest: artifact.digest,
        updatedAt: input.updatedAt,
      });
      if (stored) {
        return { ...artifact, origin: "built" as const };
      }

      // Another in-process handler won the compare-and-set. Always reuse its
      // bytes rather than rebuilding from a projection that may have advanced.
      return yield* loadStoredContext({ handoffId: input.handoffId });
    });

  const renderStoredContext: ContextHandoffServiceShape["renderStoredContext"] = (input) =>
    loadStoredContext({ handoffId: input.handoffId }).pipe(
      Effect.flatMap((artifact) =>
        Effect.try({
          try: () =>
            renderContextHandoffInput({
              document: artifact.document,
              currentMessage: input.currentMessage,
              ...(input.maxInputChars !== undefined ? { maxInputChars: input.maxInputChars } : {}),
            }),
          catch: (cause) =>
            cause instanceof ContextHandoffRenderError
              ? cause
              : artifactError(
                  input.handoffId,
                  "invalid-stored-context",
                  "Stored context handoff artifact could not be rendered",
                ),
        }),
      ),
    );

  const decodeDeliveryArtifact = Effect.fn("ContextHandoffService.decodeDeliveryArtifact")(
    function* (record: ContextHandoffRecord) {
      if (record.deliveryArtifact === null) {
        return yield* artifactError(
          record.handoffId,
          "invalid-delivery-artifact",
          "Context handoff delivery artifact has not been stored",
        );
      }
      const artifact = yield* Schema.decodeUnknownEffect(ContextHandoffDeliveryArtifactSchema)(
        record.deliveryArtifact,
      ).pipe(
        Effect.mapError(() =>
          artifactError(
            record.handoffId,
            "invalid-delivery-artifact",
            "Stored context handoff delivery artifact failed validation",
          ),
        ),
      );
      if (
        artifact.triggeringMessage.messageId !== record.firstMessageId ||
        !hasValidContextHandoffDeliveryDigests(artifact)
      ) {
        return yield* artifactError(
          record.handoffId,
          "invalid-delivery-artifact",
          "Stored context handoff delivery artifact failed integrity validation",
        );
      }
      return artifact;
    },
  );

  const prepareDeliveryArtifact: ContextHandoffServiceShape["prepareDeliveryArtifact"] = (input) =>
    Effect.gen(function* () {
      const recordBeforeRender = yield* requireRecord(input.handoffId);
      if (recordBeforeRender.deliveryArtifact !== null) {
        const existing = yield* decodeDeliveryArtifact(recordBeforeRender);
        if (
          existing.triggeringMessage.messageId !== input.triggeringMessageId ||
          existing.triggeringMessage.text !== input.currentMessage
        ) {
          return yield* artifactError(
            input.handoffId,
            "delivery-artifact-conflict",
            "Stored context handoff delivery artifact conflicts with the triggering message",
          );
        }
        return existing;
      }
      const rendered = yield* renderStoredContext(input);
      const artifact = yield* Effect.try({
        try: () =>
          makeContextHandoffDeliveryArtifact({
            maxInputChars: input.maxInputChars ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
            budgetSource: input.budgetSource ?? null,
            contextWindowTokens: input.contextWindowTokens ?? null,
            renderedContext: rendered.renderedContext,
            renderedContextJson: rendered.renderedContextJson,
            providerInput: rendered.providerInput,
            triggeringMessageId: input.triggeringMessageId,
            triggeringMessage: input.currentMessage,
            includedEntryCount: rendered.includedEntryCount,
            totalEntryCount: rendered.totalEntryCount,
            contextChars: rendered.contextChars,
            inputChars: rendered.inputChars,
            truncated: rendered.truncated,
            preparedAt: input.preparedAt,
          }),
        catch: () =>
          artifactError(
            input.handoffId,
            "invalid-delivery-artifact",
            "Context handoff delivery artifact could not be prepared",
          ),
      });
      const stored = yield* repository.storeDeliveryArtifactIfEmpty({
        handoffId: input.handoffId,
        deliveryArtifact: artifact,
        updatedAt: input.preparedAt,
      });
      if (stored) return artifact;

      const record = yield* requireRecord(input.handoffId);
      const existing = yield* decodeDeliveryArtifact(record);
      if (
        existing.providerInputDigest !== artifact.providerInputDigest ||
        existing.providerInput !== artifact.providerInput ||
        existing.triggeringMessage.messageId !== artifact.triggeringMessage.messageId
      ) {
        return yield* artifactError(
          input.handoffId,
          "delivery-artifact-conflict",
          "Stored context handoff delivery artifact conflicts with the prepared payload",
        );
      }
      return existing;
    });

  return {
    buildAndStore,
    loadStoredContext,
    renderStoredContext,
    prepareDeliveryArtifact,
  } satisfies ContextHandoffServiceShape;
});

export const ContextHandoffServiceLive = Layer.effect(
  ContextHandoffService,
  makeContextHandoffService,
);
