import { DateTime, Effect, Layer, Option } from "effect";
import {
  SourceControlProviderError,
  truncateSourceControlDetailContent,
  type ChangeRequest,
  type SourceControlChangeRequestDetail,
  type SourceControlIssueDetail,
  type SourceControlIssueSummary,
} from "@ryco/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketIssues from "./bitbucketIssues.ts";
import * as BitbucketPullRequests from "./bitbucketPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { makeBitbucketDiscovery } from "./SourceControlProviderDiscoveryCatalog.ts";

function providerError(
  operation: string,
  cause: BitbucketApi.BitbucketApiError,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "bitbucket",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(
  summary: BitbucketPullRequests.NormalizedBitbucketPullRequestRecord,
): ChangeRequest {
  return {
    provider: "bitbucket",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.author ? { author: summary.author } : {}),
    ...(typeof summary.commentsCount === "number" ? { commentsCount: summary.commentsCount } : {}),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
    ...(summary.isDraft !== undefined ? { isDraft: summary.isDraft } : {}),
    ...(summary.createdAt !== undefined ? { createdAt: summary.createdAt } : {}),
  };
}

function toIssueSummary(
  raw: BitbucketIssues.NormalizedBitbucketIssueRecord,
): SourceControlIssueSummary {
  return {
    provider: "bitbucket",
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
  raw: BitbucketIssues.NormalizedBitbucketIssueDetail,
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
  raw: BitbucketPullRequests.NormalizedBitbucketPullRequestDetail,
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
    ...(raw.linkedWorkItemKeys.length > 0 ? { linkedWorkItemKeys: raw.linkedWorkItemKeys } : {}),
    ...(raw.reviewers.length > 0 ? { reviewers: raw.reviewers } : {}),
    ...(raw.participants.length > 0 ? { participants: raw.participants } : {}),
    ...(typeof raw.tasksCount === "number" ? { tasksCount: raw.tasksCount } : {}),
    ...(raw.headSha !== undefined ? { headSha: raw.headSha } : {}),
    ...(raw.commits !== undefined ? { commits: raw.commits } : {}),
    ...(raw.reviewerStates !== undefined ? { reviewerStates: raw.reviewerStates } : {}),
    ...(raw.reviewDecision !== undefined ? { reviewDecision: raw.reviewDecision } : {}),
    ...(raw.mergeability !== undefined ? { mergeability: raw.mergeability } : {}),
    ...(raw.mergeStateStatus !== undefined ? { mergeStateStatus: raw.mergeStateStatus } : {}),
    ...(raw.mergeCapabilities !== undefined ? { mergeCapabilities: raw.mergeCapabilities } : {}),
    ...(raw.checkRollup !== undefined ? { checkRollup: raw.checkRollup } : {}),
    ...(raw.deleteBranchOnMerge !== undefined
      ? { deleteBranchOnMerge: raw.deleteBranchOnMerge }
      : {}),
    ...(raw.mergedBy !== undefined ? { mergedBy: raw.mergedBy } : {}),
  };
}

export const make = Effect.fn("makeBitbucketSourceControlProvider")(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  /** The fresh, uncapped detail a mutation returns. */
  const getDetail = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) =>
    bitbucket
      .getPullRequestDetail({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
        reference: input.reference,
      })
      .pipe(Effect.map((raw) => toChangeRequestDetail(raw, { fullContent: true })));

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "bitbucket",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return bitbucket
        .listPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.involvement !== undefined ? { involvement: input.involvement } : {}),
          ...(input.query !== undefined ? { query: input.query } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) => providerError("listChangeRequests", error)),
        );
    },
    getChangeRequest: (input) =>
      bitbucket.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return bitbucket
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
      bitbucket
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    searchRepositories: (input) =>
      bitbucket
        .searchRepositories({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("searchRepositories", error))),
    cloneAuthentication: (input) =>
      bitbucket
        .cloneAuthentication(input)
        .pipe(Effect.mapError((error) => providerError("cloneAuthentication", error))),
    createRepository: (input) =>
      bitbucket
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      bitbucket
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      bitbucket
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
    listIssues: (input) =>
      bitbucket
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
      bitbucket
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
          provider: "bitbucket",
          operation: "addIssueComment",
          detail: "Not implemented for bitbucket",
        }),
      ),
    addIssueCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "bitbucket",
          operation: "addIssueCommentReaction",
          detail: "Not implemented for bitbucket",
        }),
      ),
    searchIssues: (input) =>
      bitbucket
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
      bitbucket
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
      bitbucket
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
    addChangeRequestComment: (input) =>
      bitbucket
        .addPullRequestComment({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          body: input.body,
        })
        .pipe(
          Effect.andThen(() => getDetail(input)),
          Effect.mapError((error) => providerError("addChangeRequestComment", error)),
        ),
    addChangeRequestCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "bitbucket",
          operation: "addChangeRequestCommentReaction",
          detail: "Not implemented for bitbucket",
        }),
      ),
    getChangeRequestDiff: (input) =>
      bitbucket
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
    getChangeRequestActivity: (input) =>
      bitbucket
        .getPullRequestActivity(input)
        .pipe(Effect.mapError((error) => providerError("getChangeRequestActivity", error))),
    getChangeRequestFileContents: (input) =>
      bitbucket
        .getPullRequestFileContents(input)
        .pipe(Effect.mapError((error) => providerError("getChangeRequestFileContents", error))),
    submitChangeRequestReview: (input) =>
      bitbucket
        .submitPullRequestReview(input)
        .pipe(Effect.mapError((error) => providerError("submitChangeRequestReview", error))),
    replyToReviewThread: (input) =>
      bitbucket.replyToPullRequestThread(input).pipe(
        Effect.map((thread) => ({ thread })),
        Effect.mapError((error) => providerError("replyToReviewThread", error)),
      ),
    setReviewThreadResolved: (input) =>
      bitbucket
        .setPullRequestThreadResolved(input)
        .pipe(Effect.mapError((error) => providerError("setReviewThreadResolved", error))),
    updateChangeRequestComment: (input) =>
      bitbucket
        .updatePullRequestComment({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          commentId: input.commentId,
          commentKind: input.commentKind,
          action: input.action,
          ...(input.action === "edit" ? { body: input.body } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("updateChangeRequestComment", error))),
    updateChangeRequest: (input) =>
      bitbucket.updatePullRequest(input).pipe(
        Effect.andThen(() => getDetail(input)),
        Effect.map((detail) => ({ detail })),
        Effect.mapError((error) => providerError("updateChangeRequest", error)),
      ),
    mergeChangeRequest: (input) =>
      bitbucket
        .mergePullRequest(input)
        .pipe(Effect.mapError((error) => providerError("mergeChangeRequest", error))),
    createIssue: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "bitbucket",
          operation: "createIssue",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listLabels: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "bitbucket",
          operation: "listLabels",
          detail: "Not implemented in Phase 1",
        }),
      ),
    // Workspace members: the reviewer picker's candidates (Bitbucket has no assignees).
    listAssignees: (input) =>
      bitbucket
        .listAssignees({ cwd: input.cwd, ...(input.context ? { context: input.context } : {}) })
        .pipe(Effect.mapError((error) => providerError("listAssignees", error))),
    getPullRequestState: (input) =>
      bitbucket
        .getPullRequestState({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: String(input.number),
        })
        .pipe(Effect.mapError((error) => providerError("getPullRequestState", error))),
    getIssueState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "bitbucket",
          operation: "getIssueState",
          detail: "Not implemented for bitbucket",
        }),
      ),
  });
  // Involvement kinds Bitbucket lacks (assigned, mentioned, involved) fail in the API.
  return SourceControlProvider.withUnsupportedChangeRequestOptionGuards(provider);
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());

export const makeDiscovery = Effect.fn("makeBitbucketSourceControlProviderDiscovery")(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  return makeBitbucketDiscovery(bitbucket);
});
