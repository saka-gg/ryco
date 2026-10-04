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
import * as GitLabMergeRequestPage from "./gitLabMergeRequestPage.ts";
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
    ...(summary.isDraft !== undefined ? { isDraft: summary.isDraft } : {}),
    ...(summary.author ? { author: summary.author } : {}),
    ...(summary.assignees && summary.assignees.length > 0 ? { assignees: summary.assignees } : {}),
    ...(summary.labels && summary.labels.length > 0 ? { labels: summary.labels } : {}),
    ...(summary.commentsCount !== undefined ? { commentsCount: summary.commentsCount } : {}),
    ...(summary.headSha ? { headSha: summary.headSha } : {}),
    ...(summary.mergeability ? { mergeability: summary.mergeability } : {}),
    ...(summary.mergeStateStatus ? { mergeStateStatus: summary.mergeStateStatus } : {}),
    ...(summary.reviewDecision ? { reviewDecision: summary.reviewDecision } : {}),
    ...(summary.createdAt ? { createdAt: summary.createdAt } : {}),
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

  /** The page runner for one checkout: `glab api` resolves `:fullpath` from `cwd`. */
  const callIn =
    (cwd: string): GitLabMergeRequestPage.GitLabCall =>
    (operation, request, options) =>
      gitlab.api({ cwd, operation, request, ...options });

  const run = <A>(
    operation: string,
    effect: Effect.Effect<A, GitLabCli.GitLabCliError>,
  ): Effect.Effect<A, SourceControlProviderError> =>
    effect.pipe(Effect.mapError((error) => providerError(operation, error)));

  const getChangeRequestDetail: SourceControlProvider.SourceControlProviderShape["getChangeRequestDetail"] =
    (input) =>
      Effect.gen(function* () {
        const raw = yield* gitlab.getMergeRequestDetail({
          cwd: input.cwd,
          reference: input.reference,
        });
        const detail = toChangeRequestDetail(raw, { fullContent: input.fullContent ?? false });
        if (!raw.facts) return detail;
        const readiness = yield* GitLabMergeRequestPage.fetchGitLabDetailReadiness(
          callIn(input.cwd),
          raw.facts,
          String(raw.number),
        );
        return { ...detail, ...readiness };
      }).pipe(Effect.mapError((error) => providerError("getChangeRequestDetail", error)));

  const freshDetail = (input: { readonly cwd: string; readonly reference: string }) =>
    getChangeRequestDetail({ cwd: input.cwd, reference: input.reference, fullContent: true });

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "gitlab",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      const query = input.query?.trim() ?? "";
      const call = callIn(input.cwd);
      const records =
        input.involvement !== undefined || query.length > 0
          ? GitLabMergeRequestPage.listGitLabMergeRequestsFiltered(call, {
              state: input.state,
              involvement: input.involvement,
              query,
              sourceBranch: SourceControlProvider.sourceBranch(input) || undefined,
              limit: input.limit,
            })
          : gitlab.listMergeRequests({
              cwd: input.cwd,
              headSelector: input.headSelector,
              ...(source ? { source } : {}),
              state: input.state,
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
            });
      return records.pipe(
        Effect.map((items) => items.map(toChangeRequest)),
        // The page's lists (no branch) show each row's pipeline.
        Effect.flatMap((rows) =>
          input.headSelector.trim().length === 0 && input.includeStackSummary !== false
            ? GitLabMergeRequestPage.enrichGitLabListRowsWithPipelines(call, rows)
            : Effect.succeed(rows),
        ),
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
          ...(input.draft === true ? { draft: true } : {}),
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
    getChangeRequestDetail,
    addChangeRequestComment: (input) =>
      run(
        "addChangeRequestComment",
        GitLabMergeRequestPage.addGitLabComment(callIn(input.cwd), input),
      ).pipe(Effect.andThen(() => freshDetail(input))),
    // Reading award emoji takes one request per note over REST, so the page
    // could not show existing reactions; `reactions` stays off.
    addChangeRequestCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "addChangeRequestCommentReaction",
          detail: "GitLab does not support comment reactions.",
        }),
      ),
    getChangeRequestDiff: (input) =>
      run(
        "getChangeRequestDiff",
        GitLabMergeRequestPage.fetchGitLabChangeRequestDiff(callIn(input.cwd), input),
      ),
    mergeChangeRequest: (input) =>
      run(
        "mergeChangeRequest",
        GitLabMergeRequestPage.mergeGitLabMergeRequest(callIn(input.cwd), input),
      ),
    getChangeRequestActivity: (input) =>
      run(
        "getChangeRequestActivity",
        GitLabMergeRequestPage.fetchGitLabChangeRequestActivity(callIn(input.cwd), input.reference),
      ),
    getChangeRequestFileContents: ({ context: _context, ...input }) =>
      run(
        "getChangeRequestFileContents",
        GitLabMergeRequestPage.fetchGitLabFileContents(callIn(input.cwd), input),
      ),
    submitChangeRequestReview: ({ context: _context, ...input }) =>
      run(
        "submitChangeRequestReview",
        GitLabMergeRequestPage.submitGitLabReview(callIn(input.cwd), input),
      ),
    replyToReviewThread: (input) =>
      run(
        "replyToReviewThread",
        GitLabMergeRequestPage.replyToGitLabThread(callIn(input.cwd), input),
      ).pipe(Effect.map((thread) => ({ thread }))),
    setReviewThreadResolved: (input) =>
      run(
        "setReviewThreadResolved",
        GitLabMergeRequestPage.setGitLabThreadResolved(callIn(input.cwd), input),
      ),
    updateChangeRequestComment: ({ context: _context, ...input }) =>
      run(
        "updateChangeRequestComment",
        GitLabMergeRequestPage.updateGitLabComment(callIn(input.cwd), input),
      ),
    updateChangeRequest: (input) =>
      run(
        "updateChangeRequest",
        GitLabMergeRequestPage.updateGitLabMergeRequest(callIn(input.cwd), input),
      ).pipe(
        Effect.andThen(() => freshDetail(input)),
        Effect.map((detail) => ({ detail })),
      ),
    createIssue: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "createIssue",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listLabels: (input) =>
      run("listLabels", GitLabMergeRequestPage.listGitLabLabels(callIn(input.cwd))),
    listAssignees: (input) =>
      run("listAssignees", GitLabMergeRequestPage.listGitLabAssignees(callIn(input.cwd))),
    getPullRequestState: (input) =>
      gitlab.getMergeRequest({ cwd: input.cwd, reference: String(input.number) }).pipe(
        Effect.map((summary) => {
          const state = summary.state ?? "open";
          return {
            state,
            isDraft: summary.isDraft ?? false,
            terminalAt:
              state === "merged"
                ? (summary.mergedAt ?? summary.closedAt ?? null)
                : state === "closed"
                  ? (summary.closedAt ?? null)
                  : null,
          };
        }),
        Effect.mapError((error) => providerError("getPullRequestState", error)),
      ),
    getIssueState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "gitlab",
          operation: "getIssueState",
          detail: "Not implemented for gitlab",
        }),
      ),
    listWorkflowRuns: (input) =>
      run(
        "listWorkflowRuns",
        GitLabMergeRequestPage.listGitLabWorkflowRuns(callIn(input.cwd), input),
      ),
    getWorkflowRunJobs: (input) =>
      run(
        "getWorkflowRunJobs",
        GitLabMergeRequestPage.listGitLabPipelineJobs(callIn(input.cwd), input.runId),
      ),
    getWorkflowJobLog: (input) =>
      run("getWorkflowJobLog", GitLabMergeRequestPage.getGitLabJobLog(callIn(input.cwd), input)),
    rerunWorkflow: ({ context: _context, ...input }) =>
      run("rerunWorkflow", GitLabMergeRequestPage.rerunGitLabPipeline(callIn(input.cwd), input)),
  });
  // Guards involvement ("mentioned"/"involved" fail in the provider), list
  // search, commit diffs and drafts against the capability matrix.
  return SourceControlProvider.withUnsupportedChangeRequestOptionGuards(provider);
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());
