import * as Schema from "effect/Schema";

import { AtlassianConnectionId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ChangeRequestState,
  SourceControlCommentReaction,
  SourceControlProviderKind,
} from "./sourceControl.ts";

export const WorkItemProviderKind = Schema.Literals(["jira"]);
export type WorkItemProviderKind = typeof WorkItemProviderKind.Type;

export const WorkItemState = Schema.Literals(["open", "in_progress", "done", "closed", "unknown"]);
export type WorkItemState = typeof WorkItemState.Type;

export const WorkItemStateFilter = Schema.Literals([
  "open",
  "in_progress",
  "done",
  "closed",
  "all",
]);
export type WorkItemStateFilter = typeof WorkItemStateFilter.Type;

export const WorkItemTransition = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  toState: WorkItemState,
  toStateName: Schema.optional(TrimmedNonEmptyString),
});
export type WorkItemTransition = typeof WorkItemTransition.Type;

export const WorkItemProject = Schema.Struct({
  provider: WorkItemProviderKind,
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: Schema.String,
  projectTypeKey: Schema.optional(TrimmedNonEmptyString),
  simplified: Schema.optional(Schema.Boolean),
  avatarUrl: Schema.optional(Schema.String),
});
export type WorkItemProject = typeof WorkItemProject.Type;

export const LinkedChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: Schema.Number,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  state: ChangeRequestState,
});
export type LinkedChangeRequest = typeof LinkedChangeRequest.Type;

export const WorkItemPriority = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  iconUrl: Schema.optional(Schema.String),
  statusColor: Schema.optional(TrimmedNonEmptyString),
});
export type WorkItemPriority = typeof WorkItemPriority.Type;

export const WorkItemSummary = Schema.Struct({
  provider: WorkItemProviderKind,
  key: TrimmedNonEmptyString,
  id: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  url: Schema.String,
  state: WorkItemState,
  stateName: Schema.optional(TrimmedNonEmptyString),
  issueType: Schema.optional(TrimmedNonEmptyString),
  priority: Schema.optional(TrimmedNonEmptyString),
  priorityDetail: Schema.optional(WorkItemPriority),
  assignee: Schema.NullOr(TrimmedNonEmptyString),
  reporter: Schema.optional(TrimmedNonEmptyString),
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  dueDate: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  startDate: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: Schema.optional(Schema.Option(Schema.DateTimeUtc)),
  updatedAt: Schema.Option(Schema.DateTimeUtc),
});
export type WorkItemSummary = typeof WorkItemSummary.Type;

export const WORK_ITEM_DETAIL_BODY_MAX_BYTES = 8 * 1024;
export const WORK_ITEM_DETAIL_COMMENT_BODY_MAX_BYTES = 2 * 1024;
export const WORK_ITEM_DETAIL_MAX_COMMENTS = 5;
export const WORK_ITEM_DETAIL_MAX_ACTIVITY = 20;

export const WorkItemEditableFieldId = Schema.Literals([
  "assignee",
  "priority",
  "parent",
  "dueDate",
  "startDate",
  "reporter",
  "description",
  "title",
]);
export type WorkItemEditableFieldId = typeof WorkItemEditableFieldId.Type;

export const WorkItemEditableFieldOption = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  key: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  iconUrl: Schema.optional(Schema.String),
  avatarUrl: Schema.optional(Schema.String),
  statusColor: Schema.optional(TrimmedNonEmptyString),
});
export type WorkItemEditableFieldOption = typeof WorkItemEditableFieldOption.Type;

export const WorkItemEditableFieldMetadata = Schema.Struct({
  id: WorkItemEditableFieldId,
  jiraFieldId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  required: Schema.Boolean,
  operations: Schema.Array(TrimmedNonEmptyString),
  options: Schema.optional(Schema.Array(WorkItemEditableFieldOption)),
});
export type WorkItemEditableFieldMetadata = typeof WorkItemEditableFieldMetadata.Type;

export const WorkItemActivityItem = Schema.Struct({
  field: TrimmedNonEmptyString,
  from: Schema.optional(Schema.NullOr(Schema.String)),
  to: Schema.optional(Schema.NullOr(Schema.String)),
});
export type WorkItemActivityItem = typeof WorkItemActivityItem.Type;

export const WorkItemActivityEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.optional(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  items: Schema.Array(WorkItemActivityItem),
});
export type WorkItemActivityEntry = typeof WorkItemActivityEntry.Type;

export const WorkItemComment = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.optional(Schema.DateTimeUtc),
  editable: Schema.optional(Schema.Boolean),
  reactions: Schema.optional(Schema.Array(SourceControlCommentReaction)),
});
export type WorkItemComment = typeof WorkItemComment.Type;

export const WorkItemDetail = Schema.Struct({
  ...WorkItemSummary.fields,
  description: Schema.String,
  comments: Schema.Array(WorkItemComment),
  transitions: Schema.Array(WorkItemTransition),
  linkedChangeRequests: Schema.Array(LinkedChangeRequest),
  editableFields: Schema.Array(WorkItemEditableFieldMetadata),
  activity: Schema.Array(WorkItemActivityEntry),
  parentKey: Schema.optional(TrimmedNonEmptyString),
  epicKey: Schema.optional(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
});
export type WorkItemDetail = typeof WorkItemDetail.Type;

export const ComposerWorkItemContext = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: WorkItemProviderKind,
  key: TrimmedNonEmptyString,
  detail: WorkItemDetail,
  fetchedAt: Schema.DateTimeUtc,
  staleAfter: Schema.DateTimeUtc,
});
export type ComposerWorkItemContext = typeof ComposerWorkItemContext.Type;

export const WorkItemListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  state: WorkItemStateFilter,
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  projectKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type WorkItemListInput = typeof WorkItemListInput.Type;

export const WorkItemListProjectsInput = Schema.Struct({
  connectionId: AtlassianConnectionId,
  siteUrl: Schema.optional(Schema.String),
});
export type WorkItemListProjectsInput = typeof WorkItemListProjectsInput.Type;

export const WorkItemSearchInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  query: TrimmedNonEmptyString,
  limit: Schema.optional(Schema.Number),
  projectKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type WorkItemSearchInput = typeof WorkItemSearchInput.Type;

export const WorkItemGetInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  key: TrimmedNonEmptyString,
  fullContent: Schema.optional(Schema.Boolean),
});
export type WorkItemGetInput = typeof WorkItemGetInput.Type;

export const WorkItemAddCommentInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  key: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
});
export type WorkItemAddCommentInput = typeof WorkItemAddCommentInput.Type;

export const WorkItemUpdateFields = Schema.Struct({
  assigneeAccountId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  priorityId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  parentKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  dueDate: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  startDate: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  reporterAccountId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optional(Schema.String),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type WorkItemUpdateFields = typeof WorkItemUpdateFields.Type;

export const WorkItemUpdateInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  key: TrimmedNonEmptyString,
  fields: WorkItemUpdateFields,
});
export type WorkItemUpdateInput = typeof WorkItemUpdateInput.Type;

export const WorkItemEditCommentInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  key: TrimmedNonEmptyString,
  commentId: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
});
export type WorkItemEditCommentInput = typeof WorkItemEditCommentInput.Type;

export const WorkItemListTransitionsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  key: TrimmedNonEmptyString,
});
export type WorkItemListTransitionsInput = typeof WorkItemListTransitionsInput.Type;

export const WorkItemTransitionInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  key: TrimmedNonEmptyString,
  transitionId: TrimmedNonEmptyString,
  comment: Schema.optional(TrimmedNonEmptyString),
});
export type WorkItemTransitionInput = typeof WorkItemTransitionInput.Type;

export class WorkItemProviderError extends Schema.TaggedError<WorkItemProviderError>()(
  "WorkItemProviderError",
  {
    provider: WorkItemProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
