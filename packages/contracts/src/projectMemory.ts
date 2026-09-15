import { ProviderInstanceId } from "./providerInstance.ts";
import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  MessageId,
} from "./baseSchemas.ts";

export const PROJECT_MEMORY_CAP = 200;
export const PROJECT_MEMORY_TEXT_CHARS = 500;
export const PROJECT_MEMORY_TEXT_BYTES = 2048;
export const PROJECT_MEMORY_PAGE_SIZE = 50;
export const PROJECT_MEMORY_RECALL_CAP = 8;
export const PROJECT_MEMORY_ENVELOPE_BYTES = 16384;
export const PROJECT_MEMORY_REVIEW_DAYS = 90;
export const ProjectMemoryId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,64}$/));
export const ProjectMemoryKind = Schema.Literals(["fact", "convention", "decision", "preference"]);
export const ProjectMemoryText = Schema.String.check(
  Schema.isMaxLength(1000),
  Schema.makeFilter(
    (text) => text.trim().length > 0 && Array.from(text).length <= PROJECT_MEMORY_TEXT_CHARS,
  ),
);
export const ProjectMemorySource = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
/** Actor is minted by the authenticated server, never a client-supplied identity or credential. */
export const ProjectMemoryProvenance = Schema.Struct({
  kind: Schema.Literal("user"),
  actorId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  source: Schema.optional(ProjectMemorySource),
  sourceProviderInstanceId: Schema.optional(ProviderInstanceId),
});
export const ProjectMemoryEntry = Schema.Struct({
  id: ProjectMemoryId,
  projectId: ProjectId,
  kind: ProjectMemoryKind,
  text: ProjectMemoryText,
  revision: PositiveInt,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  affirmedAt: IsoDateTime,
  provenance: ProjectMemoryProvenance,
});
export type ProjectMemoryEntry = typeof ProjectMemoryEntry.Type;
export type ProjectMemoryProvenance = typeof ProjectMemoryProvenance.Type;
export const ProjectMemoryReference = Schema.Struct({ id: ProjectMemoryId, revision: PositiveInt });
export type ProjectMemoryReference = typeof ProjectMemoryReference.Type;
export const ProjectMemoryReferences = Schema.Array(ProjectMemoryReference).check(
  Schema.isMaxLength(PROJECT_MEMORY_RECALL_CAP),
);
export const ProjectMemoryScope = Schema.Struct({ projectId: ProjectId });
export const ProjectMemoryListInput = Schema.Struct({
  projectId: ProjectId,
  offset: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROJECT_MEMORY_CAP)),
  query: Schema.String.check(Schema.isMaxLength(200)),
});
export const ProjectMemoryPage = Schema.Struct({
  enabled: Schema.Boolean,
  revision: NonNegativeInt,
  entries: Schema.Array(ProjectMemoryEntry).check(Schema.isMaxLength(PROJECT_MEMORY_PAGE_SIZE)),
  total: NonNegativeInt,
  matched: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
  asOf: IsoDateTime,
});
export type ProjectMemoryPage = typeof ProjectMemoryPage.Type;
export const ProjectMemoryMutation = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("enable"), enabled: Schema.Boolean }),
  Schema.Struct({
    operation: Schema.Literal("create"),
    id: ProjectMemoryId,
    kind: ProjectMemoryKind,
    text: ProjectMemoryText,
    source: Schema.optional(ProjectMemorySource),
  }),
  Schema.Struct({
    operation: Schema.Literal("edit"),
    id: ProjectMemoryId,
    revision: PositiveInt,
    kind: ProjectMemoryKind,
    text: ProjectMemoryText,
  }),
  Schema.Struct({
    operation: Schema.Literal("pin"),
    id: ProjectMemoryId,
    revision: PositiveInt,
    pinned: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("affirm"),
    id: ProjectMemoryId,
    revision: PositiveInt,
  }),
  Schema.Struct({
    operation: Schema.Literal("forget"),
    id: ProjectMemoryId,
    revision: PositiveInt,
  }),
  Schema.Struct({ operation: Schema.Literal("deleteAll") }),
]);
export const ProjectMemoryMutateInput = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: NonNegativeInt,
  mutation: ProjectMemoryMutation,
});
export type ProjectMemoryMutateInput = typeof ProjectMemoryMutateInput.Type;
export const ProjectMemoryMutationResult = Schema.Struct({ revision: NonNegativeInt });
export const ProjectMemoryRecallInput = Schema.Struct({
  projectId: ProjectId,
  references: ProjectMemoryReferences,
});
export type ProjectMemoryRecallInput = typeof ProjectMemoryRecallInput.Type;
export const ProjectMemoryRecallPreview = Schema.Struct({
  entries: Schema.Array(ProjectMemoryEntry).check(Schema.isMaxLength(PROJECT_MEMORY_RECALL_CAP)),
  envelopeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROJECT_MEMORY_ENVELOPE_BYTES)),
});
export type ProjectMemoryRecallPreview = typeof ProjectMemoryRecallPreview.Type;
export const ProjectMemoryExport = Schema.Struct({
  version: Schema.Literal(1),
  projectId: ProjectId,
  enabled: Schema.Boolean,
  exportedAt: IsoDateTime,
  entries: Schema.Array(ProjectMemoryEntry).check(Schema.isMaxLength(PROJECT_MEMORY_CAP)),
});
export type ProjectMemoryExport = typeof ProjectMemoryExport.Type;
export class ProjectMemoryError extends Schema.TaggedError<ProjectMemoryError>()(
  "ProjectMemoryError",
  {
    reason: Schema.Literals([
      "unavailable",
      "disabled",
      "conflict",
      "notFound",
      "capacity",
      "invalid",
      "sensitive",
      "expired",
      "envelopeTooLarge",
    ]),
    message: Schema.String,
  },
) {}
export const PROJECT_MEMORY_WS_METHODS = {
  list: "projectMemory.list",
  mutate: "projectMemory.mutate",
  preview: "projectMemory.preview",
  export: "projectMemory.export",
} as const;
