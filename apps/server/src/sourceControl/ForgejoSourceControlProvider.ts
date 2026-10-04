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
import { stripCommentMutationMarker } from "./gitHubCommentMutationMarker.ts";
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
  const readiness = summary.readiness;
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
    ...(summary.assignees && summary.assignees.length > 0 ? { assignees: summary.assignees } : {}),
    ...(summary.labels && summary.labels.length > 0 ? { labels: summary.labels } : {}),
    ...(typeof summary.commentsCount === "number" ? { commentsCount: summary.commentsCount } : {}),
    ...(summary.headRepositoryNameWithOwner !== null
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== null
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
    ...(summary.headSha ? { headSha: summary.headSha } : {}),
    ...(readiness?.mergeability ? { mergeability: readiness.mergeability } : {}),
    ...(readiness?.checkRollup ? { checkRollup: readiness.checkRollup } : {}),
    ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
    ...(readiness && readiness.reviewDecision !== undefined
      ? { reviewDecision: readiness.reviewDecision }
      : {}),
    ...(summary.additions !== undefined ? { additions: summary.additions } : {}),
    ...(summary.deletions !== undefined ? { deletions: summary.deletions } : {}),
    ...(summary.changedFiles !== undefined ? { changedFiles: summary.changedFiles } : {}),
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
  const comments = raw.comments.map((comment) => ({
    ...comment,
    body: stripCommentMutationMarker(comment.body),
  }));
  const content = options.fullContent
    ? { body: raw.body, comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments });
  const readiness = raw.readiness;
  const reviewers = [...(raw.requestedReviewers ?? []), ...(raw.requestedTeams ?? [])];
  return {
    ...toChangeRequest(raw),
    body: content.body,
    comments: content.comments.map((comment) => ({
      ...(comment.id ? { id: comment.id } : {}),
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
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(readiness?.reviewerStates ? { reviewerStates: readiness.reviewerStates } : {}),
    ...(readiness?.mergeStateStatus ? { mergeStateStatus: readiness.mergeStateStatus } : {}),
    ...(readiness?.mergeCapabilities ? { mergeCapabilities: readiness.mergeCapabilities } : {}),
    ...(raw.closedAt ? { closedAt: raw.closedAt } : {}),
    ...(raw.mergedAt ? { mergedAt: raw.mergedAt } : {}),
    ...(raw.mergedBy ? { mergedBy: raw.mergedBy } : {}),
  };
}

function notImplemented(operation: string, detail = "Not implemented for forgejo") {
  return Effect.fail(new SourceControlProviderError({ provider: "forgejo", operation, detail }));
}

export const make = Effect.fn("makeForgejoSourceControlProvider")(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  const getChangeRequestDetail: SourceControlProvider.SourceControlProviderShape["getChangeRequestDetail"] =
    (input) =>
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
        );

  /** The fresh, uncapped detail a mutation returns. */
  const freshDetail = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) =>
    getChangeRequestDetail({
      cwd: input.cwd,
      ...(input.context ? { context: input.context } : {}),
      reference: input.reference,
      fullContent: true,
    });

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "forgejo",
    listChangeRequests: (input) => {
      const context = input.context ? { context: input.context } : {};
      const limit = input.limit !== undefined ? { limit: input.limit } : {};
      const query = input.query?.trim() ?? "";
      if (input.involvement !== undefined) {
        return forgejo
          .listInvolvedPullRequests({
            cwd: input.cwd,
            ...context,
            involvement: input.involvement,
            state: input.state,
            ...(query.length > 0 ? { query } : {}),
            ...limit,
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError((error) => providerError("listChangeRequests", error)),
          );
      }
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return forgejo
        .listPullRequests({
          cwd: input.cwd,
          ...context,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...limit,
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
          ...(input.draft === true ? { draft: true } : {}),
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
    addIssueComment: () => notImplemented("addIssueComment"),
    addIssueCommentReaction: () => notImplemented("addIssueCommentReaction"),
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
    getChangeRequestDetail,
    addChangeRequestComment: (input) =>
      forgejo.addPullRequestComment(input).pipe(
        Effect.mapError((error) => providerError("addChangeRequestComment", error)),
        Effect.andThen(() => freshDetail(input)),
      ),
    addChangeRequestCommentReaction: (input) =>
      forgejo.togglePullRequestCommentReaction(input).pipe(
        Effect.mapError((error) => providerError("addChangeRequestCommentReaction", error)),
        Effect.andThen(() => freshDetail(input)),
      ),
    getChangeRequestDiff: (input) =>
      forgejo
        .getPullRequestDiff({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.expectedHeadSha !== undefined
            ? { expectedHeadSha: input.expectedHeadSha }
            : {}),
          ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("getChangeRequestDiff", error))),
    mergeChangeRequest: (input) =>
      forgejo
        .mergePullRequest(input)
        .pipe(Effect.mapError((error) => providerError("mergeChangeRequest", error))),
    getChangeRequestActivity: (input) =>
      forgejo
        .getPullRequestActivity(input)
        .pipe(Effect.mapError((error) => providerError("getChangeRequestActivity", error))),
    getChangeRequestFileContents: (input) =>
      forgejo
        .getPullRequestFileContents(input)
        .pipe(Effect.mapError((error) => providerError("getChangeRequestFileContents", error))),
    submitChangeRequestReview: (input) =>
      forgejo
        .submitPullRequestReview(input)
        .pipe(Effect.mapError((error) => providerError("submitChangeRequestReview", error))),
    replyToReviewThread: (input) =>
      forgejo.replyToPullRequestReviewThread(input).pipe(
        Effect.map((thread) => ({ thread })),
        Effect.mapError((error) => providerError("replyToReviewThread", error)),
      ),
    // Forgejo's API cannot resolve conversations: no `setReviewThreadResolved`.
    updateChangeRequestComment: (input) =>
      forgejo
        .updatePullRequestComment(input)
        .pipe(Effect.mapError((error) => providerError("updateChangeRequestComment", error))),
    updateChangeRequest: (input) =>
      forgejo.updatePullRequest(input).pipe(
        Effect.mapError((error) => providerError("updateChangeRequest", error)),
        Effect.andThen(() => freshDetail(input)),
        Effect.map((detail) => ({ detail })),
      ),
    createIssue: () => notImplemented("createIssue", "Not implemented in Phase 1"),
    listLabels: (input) =>
      forgejo
        .listLabels(input)
        .pipe(Effect.mapError((error) => providerError("listLabels", error))),
    listAssignees: (input) =>
      forgejo
        .listAssignees(input)
        .pipe(Effect.mapError((error) => providerError("listAssignees", error))),
    getPullRequestState: (input) =>
      forgejo
        .getPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: String(input.number),
        })
        .pipe(
          Effect.map((summary) => ({
            state: summary.state,
            isDraft: summary.isDraft ?? false,
            terminalAt:
              summary.state === "merged"
                ? (summary.mergedAt ?? summary.closedAt ?? null)
                : summary.state === "closed"
                  ? (summary.closedAt ?? null)
                  : null,
          })),
          Effect.mapError((error) => providerError("getPullRequestState", error)),
        ),
    getIssueState: () => notImplemented("getIssueState"),
  });
  return SourceControlProvider.withUnsupportedChangeRequestOptionGuards(provider);
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());

export const makeDiscovery = Effect.fn("makeForgejoSourceControlProviderDiscovery")(function* () {
  const forgejo = yield* ForgejoApi.ForgejoApi;

  return makeForgejoDiscovery(forgejo);
});
