import { DateTime, Effect, Layer, Option } from "effect";
import {
  SourceControlProviderError,
  truncateSourceControlDetailContent,
  type ChangeRequest,
  type SourceControlChangeRequestDetail,
  type SourceControlIssueDetail,
  type SourceControlIssueSummary,
} from "@ryco/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import {
  makeAzureDevOpsPullRequestOperations,
  type AzureDevOpsPullRequestDetail,
} from "./azureDevOpsPullRequestOperations.ts";
import * as AzureDevOpsPullRequests from "./azureDevOpsPullRequests.ts";
import * as AzureDevOpsWorkItems from "./azureDevOpsWorkItems.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
export { azureDevOpsDiscovery as discovery } from "./SourceControlProviderDiscoveryCatalog.ts";

function providerError(
  operation: string,
  cause: AzureDevOpsCli.AzureDevOpsCliError,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "azure-devops",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(
  summary: AzureDevOpsPullRequests.NormalizedAzureDevOpsPullRequestRecord,
): ChangeRequest {
  return {
    provider: "azure-devops",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    isCrossRepository: summary.isCrossRepository ?? false,
    ...(summary.isDraft !== undefined ? { isDraft: summary.isDraft } : {}),
    ...(summary.author ? { author: summary.author } : {}),
    ...(summary.labels && summary.labels.length > 0 ? { labels: summary.labels } : {}),
    ...(summary.headSha ? { headSha: summary.headSha } : {}),
    ...(summary.mergeability ? { mergeability: summary.mergeability } : {}),
    ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
    ...(summary.reviewDecision !== undefined ? { reviewDecision: summary.reviewDecision } : {}),
  };
}

function toIssueSummary(
  raw: AzureDevOpsWorkItems.NormalizedAzureDevOpsWorkItemRecord,
): SourceControlIssueSummary {
  return {
    provider: "azure-devops",
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
  raw: AzureDevOpsWorkItems.NormalizedAzureDevOpsWorkItemDetail,
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
  raw: AzureDevOpsPullRequestDetail,
  options: { readonly fullContent: boolean },
): SourceControlChangeRequestDetail {
  const content = options.fullContent
    ? { body: raw.body, comments: raw.comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments: raw.comments });
  return {
    ...toChangeRequest(raw),
    body: content.body,
    comments: content.comments.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      createdAt: DateTime.fromDateUnsafe(new Date(c.createdAt)),
    })),
    truncated: content.truncated,
    ...(raw.commits.length > 0 ? { commits: raw.commits } : {}),
    ...(raw.reviewers.length > 0 ? { reviewers: raw.reviewers } : {}),
    reviewerStates: raw.reviewerStates,
    reviewDecision: raw.reviewDecision,
    ...(raw.mergeStateStatus ? { mergeStateStatus: raw.mergeStateStatus } : {}),
    ...(raw.mergeCapabilities ? { mergeCapabilities: raw.mergeCapabilities } : {}),
    autoMerge: raw.autoMerge,
    ...(raw.closedAt ? { closedAt: raw.closedAt } : {}),
    ...(raw.mergedAt ? { mergedAt: raw.mergedAt } : {}),
    ...(raw.mergedBy ? { mergedBy: raw.mergedBy } : {}),
  };
}

function remoteNameOf(context: SourceControlProvider.SourceControlProviderContext | undefined) {
  return context?.remoteName ?? "origin";
}

export const make = Effect.fn("makeAzureDevOpsSourceControlProvider")(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const page = makeAzureDevOpsPullRequestOperations(azure);

  const getChangeRequestDetail = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly fullContent?: boolean;
  }) =>
    page.getDetail({ cwd: input.cwd, reference: input.reference }).pipe(
      Effect.map((raw) => toChangeRequestDetail(raw, { fullContent: input.fullContent ?? false })),
      Effect.mapError((error) => providerError("getChangeRequestDetail", error)),
    );

  const freshDetail = (
    operation: string,
    input: { readonly cwd: string; readonly reference: string },
  ) =>
    page.getDetail(input).pipe(
      Effect.map((raw) => toChangeRequestDetail(raw, { fullContent: true })),
      Effect.mapError((error) => providerError(operation, error)),
    );

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return page
        .listChangeRequests({
          cwd: input.cwd,
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
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
          ...(input.draft ? { draft: true } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error)));
    },
    getRepositoryCloneUrls: (input) =>
      azure
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    createRepository: (input) =>
      azure
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      azure
        .getDefaultBranch({ cwd: input.cwd })
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(input.context ? { remoteName: input.context.remoteName } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
    listIssues: (input) =>
      azure
        .listWorkItems({
          cwd: input.cwd,
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toIssueSummary)),
          Effect.mapError((error) => providerError("listIssues", error)),
        ),
    getIssue: (input) =>
      azure.getWorkItem({ cwd: input.cwd, reference: input.reference }).pipe(
        Effect.map((raw) => toIssueDetail(raw, { fullContent: input.fullContent ?? false })),
        Effect.mapError((error) => providerError("getIssue", error)),
      ),
    addIssueComment: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "addIssueComment",
          detail: "Not implemented for azure-devops",
        }),
      ),
    addIssueCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "addIssueCommentReaction",
          detail: "Not implemented for azure-devops",
        }),
      ),
    searchIssues: (input) =>
      azure
        .searchWorkItems({
          cwd: input.cwd,
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toIssueSummary)),
          Effect.mapError((error) => providerError("searchIssues", error)),
        ),
    searchChangeRequests: (input) =>
      azure
        .searchPullRequests({
          cwd: input.cwd,
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError((error) => providerError("searchChangeRequests", error)),
        ),
    getChangeRequestDetail,
    addChangeRequestComment: (input) =>
      page.addComment({ cwd: input.cwd, reference: input.reference, body: input.body }).pipe(
        Effect.mapError((error) => providerError("addChangeRequestComment", error)),
        Effect.flatMap(() => freshDetail("addChangeRequestComment", input)),
      ),
    // Azure only has "like" (thumbs-up) on comments; the page's reaction set does not apply.
    addChangeRequestCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "addChangeRequestCommentReaction",
          detail: "Azure DevOps does not support comment reactions.",
        }),
      ),
    getChangeRequestDiff: (input) =>
      page
        .getDiff({
          cwd: input.cwd,
          reference: input.reference,
          remoteName: remoteNameOf(input.context),
          ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
          ...(input.commitSha ? { commitSha: input.commitSha } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("getChangeRequestDiff", error))),
    getChangeRequestActivity: (input) =>
      page
        .getActivity({ cwd: input.cwd, reference: input.reference })
        .pipe(Effect.mapError((error) => providerError("getChangeRequestActivity", error))),
    getChangeRequestFileContents: (input) =>
      page
        .getFileContents({
          cwd: input.cwd,
          reference: input.reference,
          remoteName: remoteNameOf(input.context),
          path: input.path,
          ...(input.previousPath ? { previousPath: input.previousPath } : {}),
          ...(input.baseSha ? { baseSha: input.baseSha } : {}),
          headSha: input.headSha,
        })
        .pipe(Effect.mapError((error) => providerError("getChangeRequestFileContents", error))),
    submitChangeRequestReview: ({ context: _context, ...input }) =>
      page
        .submitReview(input)
        .pipe(Effect.mapError((error) => providerError("submitChangeRequestReview", error))),
    replyToReviewThread: (input) =>
      page
        .replyToThread({
          cwd: input.cwd,
          reference: input.reference,
          threadId: input.threadId,
          body: input.body,
        })
        .pipe(
          Effect.map((thread) => ({ thread })),
          Effect.mapError((error) => providerError("replyToReviewThread", error)),
        ),
    setReviewThreadResolved: (input) =>
      page
        .setThreadResolved({
          cwd: input.cwd,
          reference: input.reference,
          threadId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(Effect.mapError((error) => providerError("setReviewThreadResolved", error))),
    updateChangeRequestComment: ({ context: _context, ...input }) =>
      page
        .updateComment(input)
        .pipe(Effect.mapError((error) => providerError("updateChangeRequestComment", error))),
    updateChangeRequest: (input) =>
      page
        .updatePullRequest({ cwd: input.cwd, reference: input.reference, action: input.action })
        .pipe(
          Effect.mapError((error) => providerError("updateChangeRequest", error)),
          Effect.flatMap(() => freshDetail("updateChangeRequest", input)),
          Effect.map((detail) => ({ detail })),
        ),
    mergeChangeRequest: (input) =>
      page
        .merge({
          cwd: input.cwd,
          reference: input.reference,
          mergeMethod: input.mergeMethod,
          ...(input.deleteBranch !== undefined ? { deleteBranch: input.deleteBranch } : {}),
          ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("mergeChangeRequest", error))),
    createIssue: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "createIssue",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listLabels: (input) =>
      page
        .listLabels({ cwd: input.cwd })
        .pipe(Effect.mapError((error) => providerError("listLabels", error))),
    listAssignees: (input) =>
      page
        .listAssignees({ cwd: input.cwd })
        .pipe(Effect.mapError((error) => providerError("listAssignees", error))),
    getPullRequestState: (input) =>
      azure.getPullRequest({ cwd: input.cwd, reference: String(input.number) }).pipe(
        Effect.map((summary) => ({
          state: summary.state,
          isDraft: summary.isDraft ?? false,
          terminalAt: summary.state === "open" ? null : (summary.closedAt ?? null),
        })),
        Effect.mapError((error) => providerError("getPullRequestState", error)),
      ),
    getIssueState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "getIssueState",
          detail: "Not implemented for azure-devops",
        }),
      ),
  });
  return SourceControlProvider.withUnsupportedChangeRequestOptionGuards(provider);
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());
