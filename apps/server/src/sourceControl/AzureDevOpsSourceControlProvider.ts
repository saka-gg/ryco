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

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: ChangeRequest["updatedAt"];
}): ChangeRequest {
  return {
    provider: "azure-devops",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    isCrossRepository: false,
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
  raw: AzureDevOpsPullRequests.NormalizedAzureDevOpsPullRequestDetail,
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

export const make = Effect.fn("makeAzureDevOpsSourceControlProvider")(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .listPullRequests({
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
    getChangeRequestDetail: (input) =>
      azure.getPullRequestDetail({ cwd: input.cwd, reference: input.reference }).pipe(
        Effect.map((raw) =>
          toChangeRequestDetail(raw, { fullContent: input.fullContent ?? false }),
        ),
        Effect.mapError((error) => providerError("getChangeRequestDetail", error)),
      ),
    addChangeRequestComment: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "addChangeRequestComment",
          detail: "Not implemented for azure-devops",
        }),
      ),
    addChangeRequestCommentReaction: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "addChangeRequestCommentReaction",
          detail: "Not implemented for azure-devops",
        }),
      ),
    getChangeRequestDiff: (_input) => Effect.succeed(""),
    createIssue: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "createIssue",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listLabels: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "listLabels",
          detail: "Not implemented in Phase 1",
        }),
      ),
    listAssignees: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "listAssignees",
          detail: "Not implemented in Phase 1",
        }),
      ),
    getPullRequestState: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "azure-devops",
          operation: "getPullRequestState",
          detail: "Not implemented for azure-devops",
        }),
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
  // No server-side involvement filter, list search, commit-scoped diff, or draft creation.
  return SourceControlProvider.withUnsupportedChangeRequestOptionGuards(provider);
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());
