import { Cause, Exit, Option, Result, Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@ryco/contracts";
import { decodeJsonResult, formatSchemaError } from "@ryco/shared/schemaJson";
import {
  normalizeReactionGroups,
  RawGitHubReactionGroupSchema,
  type NormalizedGitHubReaction,
} from "./gitHubReactions.ts";

export interface NormalizedGitHubLabel {
  readonly name: string;
  readonly color?: string;
  readonly description?: string;
}

export interface NormalizedGitHubIssueRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly author: string | null;
  readonly updatedAt: Option.Option<string>;
  readonly labels: ReadonlyArray<NormalizedGitHubLabel>;
  readonly assignees: ReadonlyArray<string>;
  readonly commentsCount: number | null;
}

function normalizeLabels(
  raw:
    | ReadonlyArray<{
        name: string;
        color?: string | null | undefined;
        description?: string | null | undefined;
      }>
    | undefined,
): ReadonlyArray<NormalizedGitHubLabel> {
  if (!raw) return [];
  return raw.map((l) => {
    const color = l.color?.trim() ?? "";
    const description = l.description?.trim() ?? "";
    return {
      name: l.name,
      ...(color.length > 0 ? { color } : {}),
      ...(description.length > 0 ? { description } : {}),
    };
  });
}

export interface NormalizedGitHubIssueDetail extends NormalizedGitHubIssueRecord {
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly id?: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly authorAssociation?: string;
    readonly reactions?: ReadonlyArray<NormalizedGitHubReaction>;
  }>;
}

const GitHubIssueSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  labels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        color: Schema.optional(Schema.NullOr(Schema.String)),
        description: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  assignees: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(
    Schema.Union([
      // `gh issue view` returns full comment objects.
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
          authorAssociation: Schema.optional(Schema.NullOr(Schema.String)),
          body: Schema.String,
          createdAt: Schema.String,
          reactionGroups: Schema.optional(Schema.Array(RawGitHubReactionGroupSchema)),
        }),
      ),
      // `gh issue list` returns just the count.
      Schema.Number,
    ]),
  ),
});

function normalizeIssueState(raw: string | null | undefined): "open" | "closed" {
  return raw?.trim().toUpperCase() === "CLOSED" ? "closed" : "open";
}

function normalizeIssueComment(raw: {
  readonly id?: string | null;
  readonly author?: { readonly login: string } | null;
  readonly authorAssociation?: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly reactionGroups?:
    | ReadonlyArray<Schema.Schema.Type<typeof RawGitHubReactionGroupSchema>>
    | undefined;
}): NormalizedGitHubIssueDetail["comments"][number] {
  const reactions = normalizeReactionGroups(raw.reactionGroups);
  const base = {
    ...(raw.id ? { id: raw.id } : {}),
    author: raw.author?.login ?? "unknown",
    body: raw.body,
    createdAt: raw.createdAt,
    ...(reactions.length > 0 ? { reactions } : {}),
  };
  if (raw.authorAssociation) {
    return { ...base, authorAssociation: raw.authorAssociation };
  }
  return base;
}

function normalizeGitHubIssueRecord(
  raw: Schema.Schema.Type<typeof GitHubIssueSchema>,
): NormalizedGitHubIssueRecord {
  const commentsCount =
    typeof raw.comments === "number"
      ? raw.comments
      : Array.isArray(raw.comments)
        ? raw.comments.length
        : null;
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: normalizeIssueState(raw.state),
    author: raw.author?.login ?? null,
    updatedAt: raw.updatedAt ? Option.some(raw.updatedAt) : Option.none(),
    labels: normalizeLabels(raw.labels),
    assignees: (raw.assignees ?? []).map((a) => a.login),
    commentsCount,
  };
}

const decodeIssueList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssueDetail = decodeJsonResult(GitHubIssueSchema);
const decodeIssueEntry = Schema.decodeUnknownExit(GitHubIssueSchema);

const GitHubLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const GitHubAssigneeSchema = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const decodeJsonLabelList = decodeJsonResult(Schema.Array(GitHubLabelSchema));
export const decodeJsonAssigneeList = decodeJsonResult(Schema.Array(GitHubAssigneeSchema));

export const formatGitHubIssueDecodeError = formatSchemaError;

export function decodeGitHubIssueListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedGitHubIssueRecord>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeIssueList(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  const issues: NormalizedGitHubIssueRecord[] = [];
  for (const entry of result.success) {
    const issue = decodeGitHubIssueEntryValue(entry);
    if (issue) issues.push(issue);
  }
  return Result.succeed(issues);
}

/** One already-parsed list entry in `gh`'s JSON shape; `null` when it does not decode. */
export function decodeGitHubIssueEntryValue(entry: unknown): NormalizedGitHubIssueRecord | null {
  const decoded = decodeIssueEntry(entry);
  return Exit.isSuccess(decoded) ? normalizeGitHubIssueRecord(decoded.value) : null;
}

export function decodeGitHubIssueDetailJson(
  raw: string,
): Result.Result<NormalizedGitHubIssueDetail, Cause.Cause<Schema.SchemaError>> {
  const result = decodeIssueDetail(raw);
  if (!Result.isSuccess(result)) return Result.fail(result.failure);
  const summary = normalizeGitHubIssueRecord(result.success);
  const rawComments = Array.isArray(result.success.comments) ? result.success.comments : [];
  const detail: NormalizedGitHubIssueDetail = {
    ...summary,
    body: result.success.body ?? "",
    comments: rawComments.map((c) => normalizeIssueComment(c)),
  };
  return Result.succeed(detail);
}
