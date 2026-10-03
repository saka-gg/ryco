import { DateTime, Effect, Layer, Option } from "effect";
import {
  SourceControlProviderError,
  truncateSourceControlDetailContent,
  type ChangeRequest,
  type SourceControlChangeRequestDetail,
  type SourceControlIssueDetail,
  type SourceControlIssueSummary,
} from "@ryco/contracts";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabIssues from "./gitLabIssues.ts";
import * as GitLabMergeRequests from "./gitLabMergeRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
export { gitlabDiscovery as discovery } from "./SourceControlProviderDiscoveryCatalog.ts";

function providerError(
  operation: string,
  cause: GitLabCli.GitLabCliError,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "gitlab",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(summary: GitLabCli.GitLabMergeRequestSummary): ChangeRequest {
  return {
    provider: "gitlab",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

function toIssueSummary(raw: GitLabIssues.NormalizedGitLabIssueRecord): SourceControlIssueSummary {
  return {
    provider: "gitlab",
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    ...(raw.author ? { author: raw.author } : {}),
    updatedAt: raw.updatedAt.pipe(Option.map((s) => DateTime.fromDateUnsafe(new Date(s)))),
    labels: raw.labels.map((name) => ({ name })),
  };
}

function toIssueDetail(
  raw: GitLabIssues.NormalizedGitLabIssueDetail,
  options: { readonly fullContent: boolean },
): SourceControlIssueDetail {
  const content = options.fullContent
    ? { body: raw.body, comments: raw.comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments: raw.comments });
  return {
    ...toIssueSummary(raw),
    body: content.body,
    comments: content.comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: DateTime.fromDateUnsafe(new Date(c.createdAt)),
    })),
    truncated: content.truncated,
  };
}

function toChangeRequestDetail(
  raw: GitLabMergeRequests.NormalizedGitLabMergeRequestDetail,
  options: { readonly fullContent: boolean },
): SourceControlChangeRequestDetail {
  const content = options.fullContent
    ? { body: raw.body, comments: raw.comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments: raw.comments });
  return {
    ...toChangeRequest(raw),
    body: content.body,
    comments: content.comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: DateTime.fromDateUnsafe(new Date(c.createdAt)),
    })),
    truncated: content.truncated,
  };
}

export const make = Effect.fn("makeGitLabSourceControlProvider")(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "gitlab",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return gitlab
        .listMergeRequests({
          cwd: input.cwd,
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
      gitlab.getMergeRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return gitlab
        .createMergeRequest({
          cwd: input.cwd,
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
      gitlab
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    createRepository: (input) =>
      gitlab
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      gitlab
        .getDefaultBranch(input)
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      gitlab
        .checkoutMergeRequest(input)
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
    listIssues: (input) =>
      gitlab
        .listIssues({
          cwd: input.cwd,
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toIssueSummary)),
          Effect.mapError((error) => providerError("listIssues", error)),
        ),
    getIssue: (input) =>
      gitlab.getIssue({ cwd: input.cwd, reference: input.reference }).pipe(
        Effect.map((raw) => toIssueDetail(raw, { fullContent: input.fullContent ?? false })),
        Effect.mapError((error) => providerError("getIssue", error)),
      ),
    addIssueComment: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "addIssueComment",
          detail: "Not implemented for gitlab",
        }),
      ),
    addIssueCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "addIssueCommentReaction",
          detail: "Not implemented for gitlab",
        }),
      ),
    searchIssues: (input) =>
      gitlab
        .searchIssues({
          cwd: input.cwd,
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toIssueSummary)),
          Effect.mapError((error) => providerError("searchIssues", error)),
        ),
    searchChangeRequests: (input) =>
      gitlab
        .searchMergeRequests({
          cwd: input.cwd,
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) => providerError("searchChangeRequests", error)),
        ),
    getChangeRequestDetail: (input) =>
      gitlab.getMergeRequestDetail({ cwd: input.cwd, reference: input.reference }).pipe(
        Effect.map((raw) =>
          toChangeRequestDetail(raw, { fullContent: input.fullContent ?? false }),
        ),
        Effect.mapError((error) => providerError("getChangeRequestDetail", error)),
      ),
    addChangeRequestComment: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "addChangeRequestComment",
          detail: "Not implemented for gitlab",
        }),
      ),
    addChangeRequestCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "addChangeRequestCommentReaction",
          detail: "Not implemented for gitlab",
        }),
      ),
    getChangeRequestDiff: (_input) => Effect.succeed(""),
    createIssue: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "createIssue",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listLabels: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "listLabels",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listAssignees: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "listAssignees",
          detail: "Not implemented in Phase 1",
        }),
      ),
    getPullRequestState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "getPullRequestState",
          detail: "Not implemented for gitlab",
        }),
      ),
    getIssueState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "getIssueState",
          detail: "Not implemented for gitlab",
        }),
      ),
  });
  // No server-side involvement filter, list search, commit-scoped diff, or draft creation.
  return SourceControlProvider.withUnsupportedChangeRequestOptionGuards(provider);
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());
