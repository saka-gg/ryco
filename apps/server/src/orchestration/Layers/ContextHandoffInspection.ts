import {
  CONTEXT_HANDOFF_INSPECTION_MAX_RESPONSE_BYTES,
  CONTEXT_HANDOFF_INSPECTION_PAGE_MAX_ITEMS,
  ContextHandoffInspectionError,
  ProviderDriverKind,
  type ContextHandoffEndpointSnapshot,
  type ContextHandoffExportChunkInput,
  type ContextHandoffInspectionEntriesInput,
  type ContextHandoffInspectionSummaryInput,
  type ContextHandoffInspectionScope,
  type ContextHandoffRawPayloadChunkInput,
  type ModelSelection,
} from "@ryco/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import {
  ContextHandoffRepository,
  type ContextHandoffRecord,
} from "../../persistence/Services/ContextHandoffs.ts";
import { ContextHandoffInspection } from "../Services/ContextHandoffInspection.ts";
import type {
  ContextHandoffArtifact,
  ContextHandoffDocument as ContextHandoffDocumentType,
} from "../contextHandoff/ContextHandoffBuilder.ts";
import {
  ContextHandoffDeliveryArtifact,
  type ContextHandoffDeliveryArtifact as ContextHandoffDeliveryArtifactType,
  hasValidContextHandoffDeliveryDigests,
} from "../contextHandoff/ContextHandoffArtifacts.ts";
import { verifyStoredContextHandoffDocument } from "../contextHandoff/ContextHandoffIntegrity.ts";
import {
  contextHandoffDeliveryLabel,
  contextHandoffEntryId,
  contextHandoffSectionCounts,
  contextHandoffSectionEntries,
  contextHandoffUtf8Chunk,
  decodeContextHandoffCursor,
  encodeContextHandoffCursor,
  formatContextHandoffJson,
} from "../contextHandoff/ContextHandoffInspection.ts";
import { formatContextHandoffMarkdown } from "../contextHandoff/ContextHandoffMarkdown.ts";

interface LoadedInspection {
  readonly record: ContextHandoffRecord;
  readonly complete: ContextHandoffArtifact | null;
  readonly delivery: ContextHandoffDeliveryArtifactType | null;
  readonly sources: ReadonlyArray<ContextHandoffEndpointSnapshot>;
  readonly target: ContextHandoffEndpointSnapshot;
}

function inspectionError(
  reason: ContextHandoffInspectionError["reason"],
  message: string,
): ContextHandoffInspectionError {
  return new ContextHandoffInspectionError({ reason, message });
}

function endpointFromSelection(selection: ModelSelection): ContextHandoffEndpointSnapshot {
  return {
    providerInstanceId: selection.instanceId,
    driverKind: ProviderDriverKind.make(String(selection.instanceId)),
    modelSlug: selection.model,
  };
}

function byteCount(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function unavailableScope(
  scope: ContextHandoffInspectionScope,
  reason: "not-prepared" | "exact-payload-unavailable",
) {
  return {
    scope,
    available: false,
    unavailableReason: reason,
    entryCount: 0,
    byteCount: 0,
    digest: null,
    truncated: null,
    sections: [],
  } as const;
}

function isIntactDeliveryArtifact(
  record: ContextHandoffRecord,
  artifact: ContextHandoffDeliveryArtifactType,
): boolean {
  return (
    artifact.triggeringMessage.messageId === record.firstMessageId &&
    hasValidContextHandoffDeliveryDigests(artifact)
  );
}

export const makeContextHandoffInspection = Effect.gen(function* () {
  const repository = yield* ContextHandoffRepository;

  const load = Effect.fn("ContextHandoffInspection.load")(function* (input: {
    readonly threadId: ContextHandoffRecord["threadId"];
    readonly handoffId: ContextHandoffRecord["handoffId"];
  }): Effect.fn.Return<LoadedInspection, ContextHandoffInspectionError> {
    const recordOption = yield* repository
      .getById({ handoffId: input.handoffId })
      .pipe(
        Effect.mapError(() =>
          inspectionError("internal", "The context handoff could not be loaded."),
        ),
      );
    if (Option.isNone(recordOption)) {
      return yield* inspectionError("not-found", "The context handoff could not be found.");
    }
    const record = recordOption.value;
    if (record.threadId !== input.threadId) {
      return yield* inspectionError("not-found", "The context handoff could not be found.");
    }

    const complete =
      record.structuredContext === null || record.contextDigest === null
        ? null
        : yield* verifyStoredContextHandoffDocument(
            record.structuredContext,
            record.contextDigest,
          ).pipe(
            Effect.mapError(() =>
              inspectionError(
                "invalid-artifact",
                "The stored context handoff artifact is invalid.",
              ),
            ),
          );
    const delivery =
      record.deliveryArtifact === null
        ? null
        : yield* Schema.decodeUnknownEffect(ContextHandoffDeliveryArtifact)(
            record.deliveryArtifact,
          ).pipe(
            Effect.filterOrFail((artifact) => isIntactDeliveryArtifact(record, artifact)),
            Effect.mapError(() =>
              inspectionError(
                "invalid-artifact",
                "The stored context handoff artifact is invalid.",
              ),
            ),
          );
    if (delivery !== null && complete === null) {
      return yield* inspectionError(
        "invalid-artifact",
        "The stored context handoff artifact is invalid.",
      );
    }
    return {
      record,
      complete,
      delivery,
      sources: complete?.document.provenance.sources ?? [
        endpointFromSelection(record.sourceSelection),
      ],
      target: complete?.document.provenance.target ?? endpointFromSelection(record.targetSelection),
    };
  });

  const requireScope = (
    loaded: LoadedInspection,
    scope: ContextHandoffInspectionScope,
  ): {
    readonly document:
      | ContextHandoffDocumentType
      | ContextHandoffDeliveryArtifactType["renderedContext"];
    readonly digest: string;
    readonly raw: string;
  } => {
    if (scope === "sent") {
      if (!loaded.delivery) {
        throw inspectionError(
          "scope-unavailable",
          "Exact sent payload is unavailable for this context handoff.",
        );
      }
      return {
        document: loaded.delivery.renderedContext,
        digest: loaded.delivery.providerInputDigest,
        raw: loaded.delivery.providerInput,
      };
    }
    if (!loaded.complete) {
      throw inspectionError(
        "scope-unavailable",
        "The complete context artifact is unavailable for this handoff.",
      );
    }
    return {
      document: loaded.complete.document,
      digest: loaded.complete.digest,
      raw: loaded.complete.canonicalJson,
    };
  };

  const getSummary = Effect.fn("ContextHandoffInspection.getSummary")(function* (
    input: ContextHandoffInspectionSummaryInput,
  ) {
    const loaded = yield* load(input);
    const { record, complete, delivery } = loaded;
    return {
      threadId: record.threadId,
      handoffId: record.handoffId,
      status: record.status,
      deliveryLabel: contextHandoffDeliveryLabel(record.status, delivery !== null),
      sources: loaded.sources,
      target: loaded.target,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      maxInputChars: delivery?.maxInputChars ?? null,
      budgetSource: delivery?.budgetSource ?? null,
      contextWindowTokens: delivery?.contextWindowTokens ?? null,
      preparedAt: delivery?.preparedAt ?? null,
      acceptedAt: record.acceptedProviderTurnId !== null ? record.updatedAt : null,
      sent: delivery
        ? {
            scope: "sent" as const,
            available: true,
            unavailableReason: null,
            entryCount: delivery.includedEntryCount,
            byteCount: byteCount(delivery.providerInput),
            digest: delivery.providerInputDigest,
            truncated: delivery.truncated,
            sections: contextHandoffSectionCounts(delivery.renderedContext, true),
          }
        : unavailableScope("sent", "exact-payload-unavailable"),
      complete: complete
        ? {
            scope: "complete" as const,
            available: true,
            unavailableReason: null,
            entryCount: complete.entryCount,
            byteCount: byteCount(complete.canonicalJson),
            digest: complete.digest,
            truncated: null,
            sections: contextHandoffSectionCounts(complete.document, false),
          }
        : unavailableScope("complete", "not-prepared"),
    };
  });

  const listEntries = Effect.fn("ContextHandoffInspection.listEntries")(function* (
    input: ContextHandoffInspectionEntriesInput,
  ) {
    const loaded = yield* load(input);
    const selected = requireScope(loaded, input.scope);
    if (input.section === "triggeringMessage" && input.scope !== "sent") {
      return yield* inspectionError(
        "scope-unavailable",
        "The triggering message is available only in the sent scope.",
      );
    }
    const values: ReadonlyArray<unknown> =
      input.section === "triggeringMessage"
        ? [
            {
              id: loaded.delivery!.triggeringMessage.messageId,
              role: "user",
              text: loaded.delivery!.triggeringMessage.text,
            },
          ]
        : contextHandoffSectionEntries(selected.document, input.section);
    let index = 0;
    if (input.cursor) {
      const cursor = decodeContextHandoffCursor(input.cursor);
      if (
        cursor.handoffId !== input.handoffId ||
        cursor.scope !== input.scope ||
        cursor.section !== input.section ||
        cursor.digest !== selected.digest ||
        cursor.index > values.length
      ) {
        return yield* inspectionError(
          "invalid-cursor",
          "The context handoff page cursor is invalid or stale.",
        );
      }
      index = cursor.index;
    }
    const limit = Math.min(
      input.limit ?? CONTEXT_HANDOFF_INSPECTION_PAGE_MAX_ITEMS,
      CONTEXT_HANDOFF_INSPECTION_PAGE_MAX_ITEMS,
    );
    const entries: Array<{ readonly id: string; readonly value: unknown }> = [];
    let nextIndex = index;
    while (nextIndex < values.length && entries.length < limit) {
      const value = values[nextIndex];
      const candidate = [
        ...entries,
        {
          id: contextHandoffEntryId(value, `${input.section}-${nextIndex}`),
          value,
        },
      ];
      if (byteCount(JSON.stringify(candidate)) > CONTEXT_HANDOFF_INSPECTION_MAX_RESPONSE_BYTES) {
        if (entries.length === 0) {
          return yield* inspectionError(
            "response-too-large",
            "A context handoff entry exceeds the inspection response limit.",
          );
        }
        break;
      }
      entries.push(candidate.at(-1)!);
      nextIndex += 1;
    }
    return {
      scope: input.scope,
      section: input.section,
      artifactDigest: selected.digest,
      entries,
      nextCursor:
        nextIndex < values.length
          ? encodeContextHandoffCursor({
              handoffId: input.handoffId,
              scope: input.scope,
              section: input.section,
              digest: selected.digest,
              index: nextIndex,
            })
          : null,
    };
  });

  const readRawChunk = Effect.fn("ContextHandoffInspection.readRawChunk")(function* (
    input: ContextHandoffRawPayloadChunkInput,
  ) {
    const loaded = yield* load(input);
    const selected = requireScope(loaded, input.scope);
    return {
      scope: input.scope,
      ...contextHandoffUtf8Chunk(selected.raw, input.offset),
    };
  });

  const readExportChunk = Effect.fn("ContextHandoffInspection.readExportChunk")(function* (
    input: ContextHandoffExportChunkInput,
  ) {
    const loaded = yield* load(input);
    const selected = requireScope(loaded, input.scope);
    const deliveryLabel = contextHandoffDeliveryLabel(
      loaded.record.status,
      loaded.delivery !== null,
    );
    const exported =
      input.format === "json"
        ? formatContextHandoffJson({
            scope: input.scope,
            handoffId: input.handoffId,
            status: deliveryLabel,
            digest: selected.digest,
            completeDocument: loaded.complete!.document,
            ...(loaded.delivery ? { deliveryArtifact: loaded.delivery } : {}),
          })
        : formatContextHandoffMarkdown({
            scope: input.scope,
            handoffId: input.handoffId,
            status: deliveryLabel,
            createdAt: loaded.record.createdAt,
            digest: selected.digest,
            sources: loaded.sources,
            target: loaded.target,
            truncated: input.scope === "sent" ? loaded.delivery!.truncated : null,
            document: selected.document,
            ...(input.scope === "sent"
              ? { triggeringMessage: loaded.delivery!.triggeringMessage.text }
              : {}),
          });
    const safeId = String(input.handoffId).replace(/[^a-zA-Z0-9_-]/g, "-");
    const extension = input.format === "markdown" ? "md" : "json";
    return {
      scope: input.scope,
      format: input.format,
      ...contextHandoffUtf8Chunk(exported, input.offset),
      filename: `ryco-context-handoff-${safeId}-${input.scope}.${extension}`,
    };
  });

  return { getSummary, listEntries, readRawChunk, readExportChunk };
});

export const ContextHandoffInspectionLive = Layer.effect(
  ContextHandoffInspection,
  makeContextHandoffInspection,
);
