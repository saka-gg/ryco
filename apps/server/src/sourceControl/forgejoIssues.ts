import { Cause, Exit, Option, Result, Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";

export interface NormalizedForgejoLabel {
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
}

export interface NormalizedForgejoIssueRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly author: string | null;
  readonly updatedAt: Option.Option<string>;
  readonly labels: ReadonlyArray<NormalizedForgejoLabel>;
  readonly assignees: ReadonlyArray<string>;
  readonly commentsCount: number | null;
}

export interface NormalizedForgejoComment {
  /** Forgejo comment id; round-trips into comment edits, deletes, and reactions. */
  readonly id?: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface NormalizedForgejoIssueDetail extends NormalizedForgejoIssueRecord {
  readonly body: string;
  readonly comments: ReadonlyArray<NormalizedForgejoComment>;
}

export const ForgejoUserSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  login: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  full_name: Schema.optional(Schema.String),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ForgejoLabelSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  name: TrimmedNonEmptyString,
  color: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ForgejoIssueSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  labels: Schema.optional(Schema.Array(ForgejoLabelSchema)),
  assignees: Schema.optional(Schema.Array(ForgejoUserSchema)),
  comments: Schema.optional(Schema.NullOr(Schema.Number)),
  pull_request: Schema.optional(Schema.Unknown),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ForgejoCommentSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Number)),
  user: Schema.optional(Schema.NullOr(ForgejoUserSchema)),
  body: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
});

export const ForgejoIssueListSchema = Schema.Array(ForgejoIssueSchema);
export const ForgejoCommentListSchema = Schema.Array(ForgejoCommentSchema);

export const formatForgejoIssueDecodeError = formatSchemaError;

export function forgejoAuthorName(
  author:
    | {
        readonly login?: string | undefined;
        readonly username?: string | undefined;
        readonly full_name?: string | undefined;
      }
    | null
    | undefined,
): string | null {
  return author?.login?.trim() || author?.username?.trim() || author?.full_name?.trim() || null;
}

function normalizeIssueState(raw: string | null | undefined): "open" | "closed" {
  return raw?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

function normalizeLabel(
  raw: Schema.Schema.Type<typeof ForgejoLabelSchema>,
): NormalizedForgejoLabel {
  return {
    name: raw.name,
    ...(raw.color ? { color: raw.color } : {}),
    ...(raw.description ? { description: raw.description } : {}),
  };
}

export function normalizeForgejoIssueRecord(
  raw: Schema.Schema.Type<typeof ForgejoIssueSchema>,
): NormalizedForgejoIssueRecord | null {
  if (raw.pull_request !== undefined && raw.pull_request !== null) {
    return null;
  }

  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url ?? raw.url ?? `#${raw.number}`,
    state: normalizeIssueState(raw.state),
    author: forgejoAuthorName(raw.user),
    updatedAt: raw.updated_at ? Option.some(raw.updated_at) : Option.none(),
    labels: (raw.labels ?? []).map(normalizeLabel),
    assignees: (raw.assignees ?? [])
      .map((assignee) => forgejoAuthorName(assignee))
      .filter((assignee): assignee is string => assignee !== null),
    commentsCount: raw.comments ?? null,
  };
}

export function normalizeForgejoComment(
  raw: Schema.Schema.Type<typeof ForgejoCommentSchema>,
): NormalizedForgejoComment {
  return {
    ...(typeof raw.id === "number" ? { id: String(raw.id) } : {}),
    author: forgejoAuthorName(raw.user) ?? "unknown",
    body: raw.body ?? "",
    createdAt: raw.created_at ?? new Date(0).toISOString(),
  };
}

export function normalizeForgejoIssueDetail(input: {
  readonly issue: Schema.Schema.Type<typeof ForgejoIssueSchema>;
  readonly comments: ReadonlyArray<Schema.Schema.Type<typeof ForgejoCommentSchema>>;
}): NormalizedForgejoIssueDetail {
  const summary = normalizeForgejoIssueRecord(input.issue);
  if (summary === null) {
    return {
      number: input.issue.number,
      title: input.issue.title,
      url: input.issue.html_url ?? input.issue.url ?? `#${input.issue.number}`,
      state: normalizeIssueState(input.issue.state),
      author: forgejoAuthorName(input.issue.user),
      updatedAt: input.issue.updated_at ? Option.some(input.issue.updated_at) : Option.none(),
      labels: (input.issue.labels ?? []).map(normalizeLabel),
      assignees: (input.issue.assignees ?? [])
        .map((assignee) => forgejoAuthorName(assignee))
        .filter((assignee): assignee is string => assignee !== null),
      commentsCount: input.issue.comments ?? null,
      body: input.issue.body ?? "",
      comments: input.comments.map(normalizeForgejoComment),
    };
  }

  return {
    ...summary,
    body: input.issue.body ?? "",
    comments: input.comments.map(normalizeForgejoComment),
  };
}

const decodeIssueList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssueDetail = decodeJsonResult(ForgejoIssueSchema);
const decodeCommentList = decodeJsonResult(ForgejoCommentListSchema);
const decodeIssueEntry = Schema.decodeUnknownExit(ForgejoIssueSchema);

export function decodeForgejoIssueListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedForgejoIssueRecord>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeIssueList(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);

  const issues: NormalizedForgejoIssueRecord[] = [];
  for (const entry of result.success) {
    const decoded = decodeIssueEntry(entry);
    if (Exit.isFailure(decoded)) continue;
    const normalized = normalizeForgejoIssueRecord(decoded.value);
    if (normalized) issues.push(normalized);
  }

  return Result.succeed(issues);
}

export function decodeForgejoIssueDetailJson(
  raw: string,
): Result.Result<NormalizedForgejoIssueDetail, Cause.Cause<Schema.SchemaError>> {
  const result = decodeIssueDetail(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  return Result.succeed(
    normalizeForgejoIssueDetail({
      issue: result.success,
      comments: [],
    }),
  );
}

export function decodeForgejoCommentListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedForgejoComment>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeCommentList(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  return Result.succeed(result.success.map(normalizeForgejoComment));
}
