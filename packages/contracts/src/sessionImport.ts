import { Schema } from "effect";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const SessionImportSource = Schema.Literals(["codex", "claudeAgent"]);
export type SessionImportSource = typeof SessionImportSource.Type;
export const SessionImportDiscoverInput = Schema.Struct({
  source: SessionImportSource,
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
  key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
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
