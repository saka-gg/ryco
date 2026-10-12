import * as Schema from "effect/Schema";

import {
  AtlassianConnectionId,
  AtlassianResourceId,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const AtlassianConnectionKind = Schema.Literals([
  "oauth_3lo",
  "bitbucket_token",
  "jira_token",
  "env_fallback",
]);
export type AtlassianConnectionKind = typeof AtlassianConnectionKind.Type;

export const AtlassianProduct = Schema.Literals(["jira", "bitbucket"]);
export type AtlassianProduct = typeof AtlassianProduct.Type;

export const AtlassianConnectionStatus = Schema.Literals([
  "connected",
  "needs_reauth",
  "invalid",
  "revoked",
]);
export type AtlassianConnectionStatus = typeof AtlassianConnectionStatus.Type;

export const AtlassianCapability = Schema.Literals([
  "jira:read",
  "jira:write",
  "bitbucket:read",
  "bitbucket:write",
]);
export type AtlassianCapability = typeof AtlassianCapability.Type;

export const AtlassianConnectionSummary = Schema.Struct({
  connectionId: AtlassianConnectionId,
  kind: AtlassianConnectionKind,
  label: TrimmedNonEmptyString,
  status: AtlassianConnectionStatus,
  products: Schema.Array(AtlassianProduct),
  capabilities: Schema.Array(AtlassianCapability),
  accountName: Schema.NullOr(TrimmedNonEmptyString),
  accountEmail: Schema.NullOr(TrimmedNonEmptyString),
  avatarUrl: Schema.NullOr(Schema.String),
  baseUrl: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.DateTimeUtc),
  lastVerifiedAt: Schema.NullOr(Schema.DateTimeUtc),
  readonly: Schema.Boolean,
  isDefault: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type AtlassianConnectionSummary = typeof AtlassianConnectionSummary.Type;

export const AtlassianResourceSummary = Schema.Struct({
  resourceId: AtlassianResourceId,
  connectionId: AtlassianConnectionId,
  product: AtlassianProduct,
  name: TrimmedNonEmptyString,
  url: Schema.String,
  capabilities: Schema.Array(AtlassianCapability),
  cloudId: Schema.NullOr(TrimmedNonEmptyString),
  workspaceSlug: Schema.NullOr(TrimmedNonEmptyString),
  avatarUrl: Schema.NullOr(Schema.String),
  updatedAt: Schema.DateTimeUtc,
});
export type AtlassianResourceSummary = typeof AtlassianResourceSummary.Type;

export const AtlassianProjectLink = Schema.Struct({
  projectId: ProjectId,
  jiraConnectionId: Schema.NullOr(AtlassianConnectionId),
  bitbucketConnectionId: Schema.NullOr(AtlassianConnectionId),
  jiraCloudId: Schema.NullOr(TrimmedNonEmptyString),
  jiraSiteUrl: Schema.NullOr(Schema.String),
  jiraProjectKeys: Schema.Array(TrimmedNonEmptyString),
  bitbucketWorkspace: Schema.NullOr(TrimmedNonEmptyString),
  bitbucketRepoSlug: Schema.NullOr(TrimmedNonEmptyString),
  defaultIssueTypeName: Schema.NullOr(TrimmedNonEmptyString),
  branchNameTemplate: TrimmedNonEmptyString,
  commitMessageTemplate: TrimmedNonEmptyString,
  pullRequestTitleTemplate: TrimmedNonEmptyString,
  smartLinkingEnabled: Schema.Boolean,
  autoAttachWorkItems: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type AtlassianProjectLink = typeof AtlassianProjectLink.Type;

export const AtlassianStartOAuthInput = Schema.Struct({
  products: Schema.Array(AtlassianProduct),
  projectId: Schema.optional(ProjectId),
  redirectPath: Schema.optional(TrimmedNonEmptyString),
});
export type AtlassianStartOAuthInput = typeof AtlassianStartOAuthInput.Type;

export const AtlassianStartOAuthResult = Schema.Struct({
  authorizationUrl: TrimmedNonEmptyString,
  state: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AtlassianStartOAuthResult = typeof AtlassianStartOAuthResult.Type;

export const AtlassianDisconnectInput = Schema.Struct({
  connectionId: AtlassianConnectionId,
  revokeRemote: Schema.optional(Schema.Boolean),
});
export type AtlassianDisconnectInput = typeof AtlassianDisconnectInput.Type;

export const AtlassianRefreshInput = Schema.Struct({
  connectionId: AtlassianConnectionId,
});
export type AtlassianRefreshInput = typeof AtlassianRefreshInput.Type;

export const AtlassianListResourcesInput = Schema.Struct({
  connectionId: Schema.optional(AtlassianConnectionId),
  product: Schema.optional(AtlassianProduct),
});
export type AtlassianListResourcesInput = typeof AtlassianListResourcesInput.Type;

export const AtlassianGetProjectLinkInput = Schema.Struct({
  projectId: ProjectId,
});
export type AtlassianGetProjectLinkInput = typeof AtlassianGetProjectLinkInput.Type;

export const AtlassianSaveProjectLinkInput = Schema.Struct({
  projectId: ProjectId,
  jiraConnectionId: Schema.NullOr(AtlassianConnectionId),
  bitbucketConnectionId: Schema.NullOr(AtlassianConnectionId),
  jiraCloudId: Schema.NullOr(TrimmedNonEmptyString),
  jiraSiteUrl: Schema.NullOr(Schema.String),
  jiraProjectKeys: Schema.Array(TrimmedNonEmptyString),
  bitbucketWorkspace: Schema.NullOr(TrimmedNonEmptyString),
  bitbucketRepoSlug: Schema.NullOr(TrimmedNonEmptyString),
  defaultIssueTypeName: Schema.NullOr(TrimmedNonEmptyString),
  branchNameTemplate: TrimmedNonEmptyString,
  commitMessageTemplate: TrimmedNonEmptyString,
  pullRequestTitleTemplate: TrimmedNonEmptyString,
  smartLinkingEnabled: Schema.Boolean,
  autoAttachWorkItems: Schema.Boolean,
});
export type AtlassianSaveProjectLinkInput = typeof AtlassianSaveProjectLinkInput.Type;

export const AtlassianSaveManualBitbucketTokenInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  workspaceSlug: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Boolean),
});
export type AtlassianSaveManualBitbucketTokenInput =
  typeof AtlassianSaveManualBitbucketTokenInput.Type;

export const AtlassianSaveManualJiraTokenInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  siteUrl: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type AtlassianSaveManualJiraTokenInput = typeof AtlassianSaveManualJiraTokenInput.Type;

export class AtlassianConnectionError extends Schema.TaggedError<AtlassianConnectionError>()(
  "AtlassianConnectionError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
