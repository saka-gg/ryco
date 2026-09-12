import { Context, Effect } from "effect";
import type {
  SourceControlGetChangeRequestFilesViewedInput,
  SourceControlChangeRequestFilesViewed,
  SourceControlSetChangeRequestFileViewedInput,
  SourceControlSetChangeRequestFileViewedResult,
  ChangeRequest,
  ChangeRequestState,
  IssueState,
  PullRequestState,
  SourceControlAssigneeCandidate,
  SourceControlAddCommentReactionInput,
  SourceControlChangeRequestDetail,
  SourceControlMergeChangeRequestInput,
  SourceControlMergeChangeRequestResult,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRerunInput,
  SourceControlWorkflowRerunResult,
  SourceControlWorkflowRunJobsResult,
  SourceControlWorkflowRunListResult,
  SourceControlIssueDetail,
  SourceControlIssueSummary,
  SourceControlLabel,
  SourceControlProviderError,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@ryco/contracts";

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
}

export interface SourceControlRefSelector {
  readonly refName: string;
  readonly owner?: string;
  readonly repository?: string;
}

export interface SourceControlCloneAuthentication {
  readonly kind: "http-basic";
  readonly username: string;
  readonly password: string;
}

export function parseSourceControlOwnerRef(
  headSelector: string,
): SourceControlRefSelector | undefined {
  const match = /^([^:/\s]+):(.+)$/u.exec(headSelector.trim());
  const owner = match?.[1]?.trim();
  const refName = match?.[2]?.trim();
  return owner && refName ? { owner, refName } : undefined;
}

export function normalizeSourceBranch(headSelector: string): string {
  return parseSourceControlOwnerRef(headSelector)?.refName ?? headSelector.trim();
}

export function sourceBranch(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeSourceBranch(input.headSelector);
}

export function sourceControlRefFromInput(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): SourceControlRefSelector | undefined {
  return input.source ?? parseSourceControlOwnerRef(input.headSelector);
}

export interface SourceControlProviderShape {
  readonly kind: SourceControlProviderKind;
  readonly listChangeRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly source?: SourceControlRefSelector;
    readonly headSelector: string;
    readonly state: ChangeRequestState | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
  readonly getChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ChangeRequest, SourceControlProviderError>;
  readonly createChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly source?: SourceControlRefSelector;
    readonly target?: SourceControlRefSelector;
    readonly baseRefName: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly searchRepositories?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly query?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlRepositoryCloneUrls>, SourceControlProviderError>;
  readonly cloneAuthentication?: (input: {
    readonly remoteUrl: string;
  }) => Effect.Effect<SourceControlCloneAuthentication | null, SourceControlProviderError>;
  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<string | null, SourceControlProviderError>;
  readonly checkoutChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly listIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly state: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlIssueSummary>, SourceControlProviderError>;
  readonly getIssue: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly fullContent?: boolean;
  }) => Effect.Effect<SourceControlIssueDetail, SourceControlProviderError>;
  readonly addIssueComment: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly body: string;
    readonly clientMutationId?: string;
  }) => Effect.Effect<SourceControlIssueDetail, SourceControlProviderError>;
  readonly addIssueCommentReaction: (
    input: SourceControlAddCommentReactionInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlIssueDetail, SourceControlProviderError>;
  readonly searchIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlIssueSummary>, SourceControlProviderError>;
  readonly searchChangeRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
  readonly getChangeRequestDetail: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly fullContent?: boolean;
  }) => Effect.Effect<SourceControlChangeRequestDetail, SourceControlProviderError>;
  readonly addChangeRequestComment: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly body: string;
    readonly clientMutationId?: string;
  }) => Effect.Effect<SourceControlChangeRequestDetail, SourceControlProviderError>;
  readonly addChangeRequestCommentReaction: (
    input: SourceControlAddCommentReactionInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlChangeRequestDetail, SourceControlProviderError>;
  readonly getChangeRequestFilesViewed?: (
    input: SourceControlGetChangeRequestFilesViewedInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlChangeRequestFilesViewed, SourceControlProviderError>;
  readonly setChangeRequestFileViewed?: (
    input: SourceControlSetChangeRequestFileViewedInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlSetChangeRequestFileViewedResult, SourceControlProviderError>;
  readonly getChangeRequestDiff: (input: {
    readonly expectedHeadSha?: string | undefined;
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<string, SourceControlProviderError>;
  readonly mergeChangeRequest?: (
    input: SourceControlMergeChangeRequestInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlMergeChangeRequestResult, SourceControlProviderError>;
  readonly createIssue: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly title: string;
    readonly body: string;
    readonly labels?: ReadonlyArray<string>;
    readonly assignees?: ReadonlyArray<string>;
  }) => Effect.Effect<SourceControlIssueSummary, SourceControlProviderError>;
  readonly listLabels: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<ReadonlyArray<SourceControlLabel>, SourceControlProviderError>;
  readonly listAssignees: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<ReadonlyArray<SourceControlAssigneeCandidate>, SourceControlProviderError>;
  readonly getPullRequestState: (input: {
    readonly number: number;
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<
    { readonly state: PullRequestState; readonly isDraft: boolean },
    SourceControlProviderError
  >;
  readonly getIssueState: (input: {
    readonly number: number;
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<{ readonly state: IssueState }, SourceControlProviderError>;
  readonly listWorkflowRuns?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly pullRequestNumber?: number;
    readonly commitSha?: string;
    /** Branch scope when there is no pull request (e.g. the default branch). */
    readonly branch?: string;
    readonly limit?: number;
  }) => Effect.Effect<SourceControlWorkflowRunListResult, SourceControlProviderError>;
  readonly getWorkflowRunJobs?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly runId: string;
  }) => Effect.Effect<SourceControlWorkflowRunJobsResult, SourceControlProviderError>;
  readonly getWorkflowJobLog?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly runId: string;
    readonly jobId: string;
  }) => Effect.Effect<SourceControlWorkflowJobLogResult, SourceControlProviderError>;
  readonly rerunWorkflow?: (
    input: SourceControlWorkflowRerunInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<SourceControlWorkflowRerunResult, SourceControlProviderError>;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderShape
>()("ryco/source-control/SourceControlProvider") {}
