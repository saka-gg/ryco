import { DateTime, Effect, Layer, Option } from "effect";
import {
  SourceControlProviderError,
  truncateSourceControlDetailContent,
  type ChangeRequest,
  type SourceControlChangeRequestDetail,
  type SourceControlIssueDetail,
  type SourceControlIssueSummary,
} from "@ryco/contracts";

import * as ForgejoApi from "./ForgejoApi.ts";
import * as ForgejoIssues from "./forgejoIssues.ts";
import * as ForgejoPullRequests from "./forgejoPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { makeForgejoDiscovery } from "./SourceControlProviderDiscoveryCatalog.ts";

function providerError(
  operation: string,
  cause: ForgejoApi.ForgejoApiError,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "forgejo",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(
  summary: ForgejoPullRequests.NormalizedForgejoPullRequestRecord,
): ChangeRequest {
  return {
    provider: "forgejo",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.isDraft !== undefined ? { isDraft: summary.isDraft } : {}),
    ...(summary.author ? { author: summary.author } : {}),
    ...(typeof summary.commentsCount === "number" ? { commentsCount: summary.commentsCount } : {}),
    ...(summary.headRepositoryNameWithOwner !== null
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== null
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

function toIssueSummary(
  raw: ForgejoIssues.NormalizedForgejoIssueRecord,
): SourceControlIssueSummary {
  return {
    provider: "forgejo",
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    ...(raw.author ? { author: raw.author } : {}),
    updatedAt: raw.updatedAt.pipe(Option.map((s) => DateTime.fromDateUnsafe(new Date(s)))),
    ...(raw.labels.length > 0 ? { labels: raw.labels } : {}),
    ...(raw.assignees.length > 0 ? { assignees: raw.assignees } : {}),
    ...(typeof raw.commentsCount === "number" ? { commentsCount: raw.commentsCount } : {}),
  };
}

function toIssueDetail(
  raw: ForgejoIssues.NormalizedForgejoIssueDetail,
  options: { readonly fullContent: boolean },
): SourceControlIssueDetail {
  const content = options.fullContent
    ? { body: raw.body, comments: raw.comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments: raw.comments });
  return {
    ...toIssueSummary(raw),
    body: content.body,
    comments: content.comments.map((comment) => ({
      author: comment.author,
      body: comment.body,
      createdAt: DateTime.fromDateUnsafe(new Date(comment.createdAt)),
    })),
    truncated: content.truncated,
  };
}

function toChangeRequestDetail(
  raw: ForgejoPullRequests.NormalizedForgejoPullRequestDetail,
  options: { readonly fullContent: boolean },
): SourceControlChangeRequestDetail {
  const content = options.fullContent
    ? { body: raw.body, comments: raw.comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments: raw.comments });
  return {
    ...toChangeRequest(raw),
    body: content.body,
    comments: content.comments.map((comment) => ({
      author: comment.author,
      body: comment.body,
      createdAt: DateTime.fromDateUnsafe(new Date(comment.createdAt)),
    })),
    truncated: content.truncated,
    ...(raw.commits.length > 0 ? { commits: raw.commits } : {}),
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    ...(raw.files.length > 0 ? { files: raw.files } : {}),
  };
}

export const make = Effect.fn("makeForgejoSourceControlProvider")(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "forgejo",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .listPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) => providerError("listChangeRequests", error)),
        );
    },
    getChangeRequest: (input) =>
      forgejo.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .createPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error)));
    },
    getRepositoryCloneUrls: (input) =>
      forgejo
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    createRepository: (input) =>
      forgejo
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      forgejo
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      forgejo
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
    listIssues: (input) =>
      forgejo
        .listIssues({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toIssueSummary)),
          Effect.mapError((error) => providerError("listIssues", error)),
        ),
    getIssue: (input) =>
      forgejo
        .getIssue({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
        })
        .pipe(
          Effect.map((raw) => toIssueDetail(raw, { fullContent: input.fullContent ?? false })),
          Effect.mapError((error) => providerError("getIssue", error)),
        ),
    addIssueComment: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "addIssueComment",
          detail: "Not implemented for forgejo",
        }),
      ),
    addIssueCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "addIssueCommentReaction",
          detail: "Not implemented for forgejo",
        }),
      ),
    searchIssues: (input) =>
      forgejo
        .searchIssues({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toIssueSummary)),
          Effect.mapError((error) => providerError("searchIssues", error)),
        ),
    searchChangeRequests: (input) =>
      forgejo
        .searchPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) => providerError("searchChangeRequests", error)),
        ),
    getChangeRequestDetail: (input) =>
      forgejo
        .getPullRequestDetail({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
        })
        .pipe(
          Effect.map((raw) =>
            toChangeRequestDetail(raw, { fullContent: input.fullContent ?? false }),
          ),
          Effect.mapError((error) => providerError("getChangeRequestDetail", error)),
        ),
    addChangeRequestComment: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "addChangeRequestComment",
          detail: "Not implemented for forgejo",
        }),
      ),
    addChangeRequestCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "addChangeRequestCommentReaction",
          detail: "Not implemented for forgejo",
        }),
      ),
    getChangeRequestDiff: (input) =>
      forgejo
        .getPullRequestDiff({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
        })
        .pipe(Effect.mapError((error) => providerError("getChangeRequestDiff", error))),
    createIssue: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "createIssue",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listLabels: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "listLabels",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listAssignees: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "listAssignees",
          detail: "Not implemented in Phase 1",
        }),
      ),
    getPullRequestState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "getPullRequestState",
          detail: "Not implemented for forgejo",
        }),
      ),
    getIssueState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "forgejo",
          operation: "getIssueState",
          detail: "Not implemented for forgejo",
        }),
      ),
  });
  // No server-side involvement filter, list search, commit-scoped diff, or draft creation.
  return SourceControlProvider.withUnsupportedChangeRequestOptionGuards(provider);
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());

export const makeDiscovery = Effect.fn("makeForgejoSourceControlProviderDiscovery")(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  return makeForgejoDiscovery(forgejo);
});
