import { Schema } from "effect";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./orchestration.ts";

export const SessionImportSource = Schema.Literals(["codex", "claudeAgent"]);
export type SessionImportSource = typeof SessionImportSource.Type;
const ImportKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const SessionImportSourcesInput = Schema.Struct({ source: SessionImportSource });
export const SessionImportStore = Schema.Struct({
  key: ImportKey,
  label: Schema.String,
  isDefault: Schema.Boolean,
  instanceIds: Schema.Array(ProviderInstanceId),
});
export const SessionImportStores = Schema.Array(SessionImportStore);
export type SessionImportStore = typeof SessionImportStore.Type;
export const SessionImportDiscoverInput = Schema.Struct({
  source: SessionImportSource,
  storeKey: Schema.optional(ImportKey),
  search: Schema.String.check(Schema.isMaxLength(200)),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  includeArchived: Schema.Boolean,
});
export type SessionImportDiscoverInput = typeof SessionImportDiscoverInput.Type;
export const SessionImportCandidate = Schema.Struct({
  key: Schema.String,
  source: SessionImportSource,
  title: Schema.String,
  cwd: Schema.String,
  archived: Schema.Boolean,
  messageCount: Schema.Int,
  importedThreadId: Schema.NullOr(ThreadId),
  quarantined: Schema.Boolean,
});
export type SessionImportCandidate = typeof SessionImportCandidate.Type;
export const SessionImportPage = Schema.Struct({
  items: Schema.Array(SessionImportCandidate),
  nextOffset: Schema.NullOr(Schema.Int),
  notices: Schema.Array(Schema.String),
});
export type SessionImportPage = typeof SessionImportPage.Type;
export const SessionImportInput = Schema.Struct({
  source: SessionImportSource,
  key: ImportKey,
  storeKey: Schema.optional(ImportKey),
  projectId: ProjectId,
  modelSelection: ModelSelection,
});
export type SessionImportInput = typeof SessionImportInput.Type;
export const SessionImportResult = Schema.Struct({
  threadId: ThreadId,
  alreadyImported: Schema.Boolean,
});
export type SessionImportResult = typeof SessionImportResult.Type;
export class SessionImportError extends Schema.TaggedError<SessionImportError>()(
  "SessionImportError",
  {
    message: Schema.String,
  },
) {}

export const SessionImportReconcileInput = Schema.Struct({
  source: SessionImportSource,
  key: ImportKey,
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type SessionImportReconcileInput = typeof SessionImportReconcileInput.Type;
export const SessionImportRecovery = Schema.Struct({
  state: Schema.Literals(["scanning", "missing", "unique", "multiple", "mismatched", "unknown"]),
  candidates: Schema.Array(Schema.Struct({ id: Schema.String, messageCount: Schema.Int })),
  nextCursor: Schema.NullOr(Schema.String),
  adoptionToken: Schema.NullOr(Schema.String),
  notice: Schema.String,
});
export type SessionImportRecovery = typeof SessionImportRecovery.Type;
export const SessionImportAdoptInput = Schema.Struct({
  source: SessionImportSource,
  key: ImportKey,
  adoptionToken: Schema.String.check(Schema.isMaxLength(64)),
});
export type SessionImportAdoptInput = typeof SessionImportAdoptInput.Type;
