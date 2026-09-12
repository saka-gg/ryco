import { createHash } from "node:crypto";

import { DateTime, Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import {
  SourceControlProviderError,
  SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES,
  truncateSourceControlDetailContent,
  type ChangeRequest,
  type ChangeRequestState,
  type SourceControlChangeRequestDetail,
  type SourceControlChangeRequestStackSummary,
  type SourceControlIssueComment,
  type SourceControlIssueDetail,
  type SourceControlIssueSummary,
  type SourceControlWorkflowJob,
  type SourceControlWorkflowJobLogResult,
  type SourceControlWorkflowRerunResult,
  type SourceControlWorkflowRun,
  type SourceControlWorkflowRunJobsResult,
  type SourceControlWorkflowRunListResult,
  type SourceControlWorkflowStep,
} from "@ryco/contracts";
import {
  classifySourceControlCommentAuthorRole,
  parseGitHubRepositoryIdentityFromUrl,
  parseGitHubRepositoryOwnerFromUrl,
} from "@ryco/shared/sourceControl";

import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubIssues from "./gitHubIssues.ts";
import * as GitHubPullRequests from "./gitHubPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
export { githubDiscovery as discovery } from "./SourceControlProviderDiscoveryCatalog.ts";

function providerError(
  operation: string,
  cause: GitHubCli.GitHubCliError,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "github",
    operation,
    detail: cause.detail,
    cause,
  });
}

const RYCO_COMMENT_MARKER_PATTERN = /\n{0,2}<!-- ryco-comment-id:[a-f0-9]{64} -->\s*$/u;

function commentMutationMarker(clientMutationId: string): string {
  const hashed = createHash("sha256").update(clientMutationId).digest("hex");
  return `<!-- ryco-comment-id:${hashed} -->`;
}

function appendCommentMutationMarker(body: string, clientMutationId: string | undefined): string {
  if (clientMutationId === undefined) return body;
  return `${body.trimEnd()}\n\n${commentMutationMarker(clientMutationId)}`;
}

function stripCommentMutationMarker(body: string): string {
  return body.replace(RYCO_COMMENT_MARKER_PATTERN, "").trimEnd();
}

function hasCommentMutationMarker(
  comments: ReadonlyArray<{ readonly body: string }>,
  clientMutationId: string | undefined,
): boolean {
  if (clientMutationId === undefined) return false;
  const marker = commentMutationMarker(clientMutationId);
  return comments.some((comment) => comment.body.includes(marker));
}

function toChangeRequest(
  summary: GitHubCli.GitHubPullRequestSummary,
  stackSummary?: SourceControlChangeRequestStackSummary,
): ChangeRequest {
  return {
    provider: "github",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.isDraft !== undefined ? { isDraft: summary.isDraft } : {}),
    ...(summary.author ? { author: summary.author } : {}),
    ...(summary.assignees && summary.assignees.length > 0 ? { assignees: summary.assignees } : {}),
    ...(summary.labels && summary.labels.length > 0 ? { labels: summary.labels } : {}),
    ...(typeof summary.commentsCount === "number" ? { commentsCount: summary.commentsCount } : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
    ...(summary.headSha ? { headSha: summary.headSha } : {}),
    ...(summary.mergeability ? { mergeability: summary.mergeability } : {}),
    ...(summary.checkRollup ? { checkRollup: summary.checkRollup } : {}),
    ...(stackSummary ? { stackSummary } : {}),
  };
}

function toIssueSummary(raw: GitHubIssues.NormalizedGitHubIssueRecord): SourceControlIssueSummary {
  return {
    provider: "github",
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    ...(raw.author ? { author: raw.author } : {}),
    updatedAt: raw.updatedAt.pipe(Option.map((s) => DateTime.fromDateUnsafe(new Date(s)))),
    labels: raw.labels,
    ...(raw.assignees.length > 0 ? { assignees: raw.assignees } : {}),
    ...(typeof raw.commentsCount === "number" ? { commentsCount: raw.commentsCount } : {}),
  };
}

function toSourceControlComment(
  raw: {
    readonly id?: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
    readonly authorAssociation?: string;
    readonly reviewState?: SourceControlIssueComment["reviewState"];
    readonly reactions?: SourceControlIssueComment["reactions"];
  },
  context: {
    readonly itemAuthor: string | null | undefined;
    readonly repositoryOwner: string | null;
  },
): SourceControlIssueComment {
  return {
    ...(raw.id ? { id: raw.id } : {}),
    author: raw.author,
    body: stripCommentMutationMarker(raw.body),
    createdAt: DateTime.fromDateUnsafe(new Date(raw.createdAt)),
    ...(raw.authorAssociation ? { authorAssociation: raw.authorAssociation } : {}),
    authorRole: classifySourceControlCommentAuthorRole({
      commentAuthor: raw.author,
      itemAuthor: context.itemAuthor,
      repositoryOwner: context.repositoryOwner,
      authorAssociation: raw.authorAssociation,
    }),
    ...(raw.reviewState ? { reviewState: raw.reviewState } : {}),
    ...(raw.reactions && raw.reactions.length > 0 ? { reactions: raw.reactions } : {}),
  };
}

function toIssueDetail(
  raw: GitHubIssues.NormalizedGitHubIssueDetail,
  options: { readonly fullContent: boolean },
): SourceControlIssueDetail {
  const comments = raw.comments.map((comment) => ({
    ...comment,
    body: stripCommentMutationMarker(comment.body),
  }));
  const content = options.fullContent
    ? { body: raw.body, comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments });
  const repositoryOwner = parseGitHubRepositoryOwnerFromUrl(raw.url);
  return {
    ...toIssueSummary(raw),
    body: content.body,
    comments: content.comments.map((c) =>
      toSourceControlComment(c, { itemAuthor: raw.author, repositoryOwner }),
    ),
    truncated: content.truncated,
  };
}

function toChangeRequestDetail(
  raw: GitHubCli.GitHubPullRequestDetail,
  options: { readonly fullContent: boolean },
): SourceControlChangeRequestDetail {
  const comments = raw.comments.map((comment) => ({
    ...comment,
    body: stripCommentMutationMarker(comment.body),
  }));
  const content = options.fullContent
    ? { body: raw.body, comments, truncated: false }
    : truncateSourceControlDetailContent({ body: raw.body, comments });
  const repositoryOwner = parseGitHubRepositoryOwnerFromUrl(raw.url);
  return {
    ...toChangeRequest(raw),
    body: content.body,
    comments: content.comments.map((c) =>
      toSourceControlComment(c, { itemAuthor: raw.author, repositoryOwner }),
    ),
    truncated: content.truncated,
    ...(raw.linkedIssueNumbers.length > 0 ? { linkedIssueNumbers: raw.linkedIssueNumbers } : {}),
    ...(raw.reviewers && raw.reviewers.length > 0 ? { reviewers: raw.reviewers } : {}),
    ...(raw.commits && raw.commits.length > 0 ? { commits: raw.commits } : {}),
    ...(typeof raw.additions === "number" ? { additions: raw.additions } : {}),
    ...(typeof raw.deletions === "number" ? { deletions: raw.deletions } : {}),
    ...(typeof raw.changedFiles === "number" ? { changedFiles: raw.changedFiles } : {}),
    ...(raw.files && raw.files.length > 0 ? { files: raw.files } : {}),
  };
}

function optionFromString(value: string | null | undefined): Option.Option<string> {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

function dateTimeOption(value: string | null | undefined): Option.Option<DateTime.Utc> {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return Option.none();
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return Option.none();
  return Option.some(DateTime.fromDateUnsafe(date));
}

function durationMsOption(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): Option.Option<number> {
  const started = startedAt ? new Date(startedAt) : null;
  const finished = finishedAt ? new Date(finishedAt) : null;
  if (
    started === null ||
    finished === null ||
    !Number.isFinite(started.getTime()) ||
    !Number.isFinite(finished.getTime())
  ) {
    return Option.none();
  }
  return Option.some(Math.max(0, finished.getTime() - started.getTime()));
}

/**
 * Pick the commit oid of the most recent run in a branch-scoped result. GitHub
 * returns runs newest-first, but we compare start times defensively and fall
 * back to that ordering when timestamps are absent or tied. Returns null when
 * no usable oid is present (e.g. the placeholder "unknown").
 */
function newestWorkflowRunCommitOid(
  runs: ReadonlyArray<GitHubCli.GitHubWorkflowRun>,
): string | null {
  let newest: GitHubCli.GitHubWorkflowRun | null = null;
  for (const run of runs) {
    if (newest === null || (run.startedAt ?? "") > (newest.startedAt ?? "")) {
      newest = run;
    }
  }
  const oid = newest?.commit.oid.trim();
  return oid && oid !== "unknown" ? oid : null;
}

function toWorkflowRun(raw: GitHubCli.GitHubWorkflowRun): SourceControlWorkflowRun {
  return {
    provider: "github",
    runId: raw.runId,
    workflowName: raw.workflowName,
    ...(raw.displayTitle ? { displayTitle: raw.displayTitle } : {}),
    branch: optionFromString(raw.branch),
    ...(raw.event ? { event: raw.event } : {}),
    commit: raw.commit,
    actor: optionFromString(raw.actor),
    status: raw.status,
    conclusion: optionFromString(raw.conclusion),
    startedAt: dateTimeOption(raw.startedAt),
    updatedAt: dateTimeOption(raw.updatedAt),
    durationMs: durationMsOption(raw.startedAt, raw.updatedAt),
    url: raw.url,
  };
}

function toWorkflowStep(
  raw: GitHubCli.GitHubWorkflowJob["steps"][number],
): SourceControlWorkflowStep {
  return {
    number: Math.max(0, Math.trunc(raw.number)),
    name: raw.name,
    status: raw.status,
    conclusion: optionFromString(raw.conclusion),
    startedAt: dateTimeOption(raw.startedAt),
    completedAt: dateTimeOption(raw.completedAt),
    durationMs: durationMsOption(raw.startedAt, raw.completedAt),
  };
}

function toWorkflowJob(raw: GitHubCli.GitHubWorkflowJob): SourceControlWorkflowJob {
  return {
    jobId: raw.jobId,
    name: raw.name,
    status: raw.status,
    conclusion: optionFromString(raw.conclusion),
    startedAt: dateTimeOption(raw.startedAt),
    completedAt: dateTimeOption(raw.completedAt),
    durationMs: durationMsOption(raw.startedAt, raw.completedAt),
    url: optionFromString(raw.url),
    steps: raw.steps.map(toWorkflowStep),
  };
}

function truncateWorkflowLog(
  log: string,
): Pick<SourceControlWorkflowJobLogResult, "log" | "truncated"> {
  if (Buffer.byteLength(log, "utf8") <= SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES) {
    return { log, truncated: false };
  }
  const buffer = Buffer.from(log, "utf8").subarray(0, SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES);
  return { log: buffer.toString("utf8"), truncated: true };
}

export const make = Effect.fn("makeGitHubSourceControlProvider")(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const fileSystem = yield* FileSystem.FileSystem;
  const invokeGitHubEffect = <A>(
    operation: string,
    invoke: () => Effect.Effect<A, GitHubCli.GitHubCliError>,
  ): Effect.Effect<A, GitHubCli.GitHubCliError> =>
    Effect.try({
      try: invoke,
      catch: (cause) =>
        new GitHubCli.GitHubCliError({
          operation,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(Effect.flatten);

  const enrichChangeRequestsWithStacks = (input: {
    readonly cwd: string;
    readonly items: ReadonlyArray<ChangeRequest>;
  }): Effect.Effect<ReadonlyArray<ChangeRequest>> =>
    Effect.gen(function* () {
      const groups = new Map<
        string,
        {
          readonly host: string;
          readonly repository: string;
          readonly numbers: number[];
        }
      >();
      for (const item of input.items) {
        const identity = parseGitHubRepositoryIdentityFromUrl(item.url);
        if (!identity) continue;
        const key = `${identity.host}\u0000${identity.nameWithOwner.toLowerCase()}`;
        const existing = groups.get(key);
        if (existing) {
          existing.numbers.push(item.number);
        } else {
          groups.set(key, {
            host: identity.host,
            repository: identity.nameWithOwner,
            numbers: [item.number],
          });
        }
      }
      if (groups.size === 0) return input.items;

      const groupSummaries = yield* Effect.forEach(
        groups.entries(),
        ([key, group]) =>
          invokeGitHubEffect("getPullRequestStackSummaries", () =>
            github.getPullRequestStackSummaries({
              cwd: input.cwd,
              host: group.host,
              repository: group.repository,
              numbers: group.numbers,
            }),
          ).pipe(
            Effect.catch(() => Effect.succeed(new Map())),
            Effect.map((summaries) => ({ key, summaries })),
          ),
        { concurrency: 2 },
      );
      const summaries = new Map<string, SourceControlChangeRequestStackSummary>();
      for (const result of groupSummaries) {
        for (const [number, summary] of result.summaries) {
          summaries.set(`${result.key}\u0000${number}`, summary);
        }
      }
      if (summaries.size === 0) return input.items;
      return input.items.map((item) => {
        const identity = parseGitHubRepositoryIdentityFromUrl(item.url);
        if (!identity) return item;
        const key = `${identity.host}\u0000${identity.nameWithOwner.toLowerCase()}`;
        const stackSummary = summaries.get(`${key}\u0000${item.number}`);
        return stackSummary ? { ...item, stackSummary } : item;
      });
    }).pipe(Effect.catch(() => Effect.succeed(input.items)));

  const withTempBodyFile = <A>(
    input: {
      readonly operation: string;
      readonly prefix: string;
      readonly body: string;
    },
    useBodyFile: (bodyFile: string) => Effect.Effect<A, SourceControlProviderError>,
  ) =>
    Effect.gen(function* () {
      const bodyFile = yield* fileSystem.makeTempFile({ prefix: input.prefix, suffix: ".md" }).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: "github",
              operation: input.operation,
              detail: "Failed to create temp file for GitHub body.",
              cause,
            }),
        ),
      );
      const work = Effect.gen(function* () {
        yield* fileSystem.writeFileString(bodyFile, input.body).pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: "github",
                operation: input.operation,
                detail: "Failed to write GitHub body temp file.",
                cause,
              }),
          ),
        );
        return yield* useBodyFile(bodyFile);
      });
      return yield* work.pipe(
        Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))),
      );
    });

  const listChangeRequests: SourceControlProvider.SourceControlProviderShape["listChangeRequests"] =
    (input) => {
      const headSelector = input.headSelector.trim();
      if (input.state === "open" && headSelector.length > 0) {
        return github
          .listOpenPullRequests({
            cwd: input.cwd,
            headSelector,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map((item) => toChangeRequest(item))),
            Effect.flatMap((items) => enrichChangeRequestsWithStacks({ cwd: input.cwd, items })),
            Effect.mapError((error) => providerError("listChangeRequests", error)),
          );
      }

      const stateArg: ChangeRequestState | "all" = input.state;
      const executeListChangeRequests = (jsonFields: ReadonlyArray<string>) =>
        github.execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            ...(headSelector.length > 0 ? ["--head", headSelector] : []),
            "--state",
            stateArg,
            "--limit",
            String(input.limit ?? 20),
            "--json",
            GitHubCli.formatGitHubJsonFields(jsonFields),
          ],
        });

      return executeListChangeRequests(GitHubCli.GITHUB_PULL_REQUEST_LIST_JSON_FIELDS).pipe(
        Effect.catchIf(GitHubCli.isStatusCheckRollupAccessError, () =>
          executeListChangeRequests(
            GitHubCli.withoutStatusCheckRollupJsonField(
              GitHubCli.GITHUB_PULL_REQUEST_LIST_JSON_FIELDS,
            ),
          ),
        ),
        Effect.flatMap((result) => {
          const raw = result.stdout.trim();
          if (raw.length === 0) {
            return Effect.succeed([]);
          }
          return Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestListJson(raw)).pipe(
            Effect.flatMap((decoded) =>
              Result.isSuccess(decoded)
                ? Effect.succeed(
                    decoded.success.map((item) => ({
                      ...toChangeRequest(item),
                      updatedAt: item.updatedAt,
                    })),
                  )
                : Effect.fail(
                    new SourceControlProviderError({
                      provider: "github",
                      operation: "listChangeRequests",
                      detail: "GitHub CLI returned invalid change request JSON.",
                      cause: decoded.failure,
                    }),
                  ),
            ),
          );
        }),
        Effect.flatMap((items) => enrichChangeRequestsWithStacks({ cwd: input.cwd, items })),
        Effect.mapError((error) =>
          Schema.is(SourceControlProviderError)(error)
            ? error
            : providerError("listChangeRequests", error),
        ),
      );
    };

  return SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests,
    getChangeRequest: (input) =>
      github.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) =>
      github
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error))),
    getRepositoryCloneUrls: (input) =>
      github
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    createRepository: (input) =>
      github
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      github
        .getDefaultBranch(input)
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      github
        .checkoutPullRequest(input)
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
    listIssues: (input) =>
      github
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
      github.getIssue({ cwd: input.cwd, reference: input.reference }).pipe(
        Effect.map((raw) => toIssueDetail(raw, { fullContent: input.fullContent ?? false })),
        Effect.mapError((error) => providerError("getIssue", error)),
      ),
    addIssueComment: (input) =>
      Effect.gen(function* () {
        const existing = input.clientMutationId
          ? yield* github
              .getIssue({ cwd: input.cwd, reference: input.reference })
              .pipe(Effect.mapError((error) => providerError("addIssueComment", error)))
          : null;
        if (existing && hasCommentMutationMarker(existing.comments, input.clientMutationId)) {
          return toIssueDetail(existing, { fullContent: true });
        }

        yield* withTempBodyFile(
          {
            operation: "addIssueComment",
            prefix: "ryco-gh-comment-body-",
            body: appendCommentMutationMarker(input.body, input.clientMutationId),
          },
          (bodyFile) =>
            github
              .addIssueComment({
                cwd: input.cwd,
                reference: input.reference,
                bodyFile,
              })
              .pipe(Effect.mapError((error) => providerError("addIssueComment", error))),
        );
        const updated = yield* github
          .getIssue({ cwd: input.cwd, reference: input.reference })
          .pipe(Effect.mapError((error) => providerError("addIssueComment", error)));
        return toIssueDetail(updated, { fullContent: true });
      }),
    addIssueCommentReaction: (input) =>
      Effect.gen(function* () {
        const reactionGroups = yield* github
          .getCommentReactionGroups({ cwd: input.cwd, commentIds: [input.commentId] })
          .pipe(Effect.mapError((error) => providerError("addIssueCommentReaction", error)));
        const viewerHasReacted =
          reactionGroups
            .find((group) => group.id === input.commentId)
            ?.reactions.find((reaction) => reaction.content === input.content)?.viewerHasReacted ===
          true;
        const reactionMutation = viewerHasReacted ? github.removeReaction : github.addReaction;
        yield* reactionMutation({
          cwd: input.cwd,
          subjectId: input.commentId,
          content: input.content,
        }).pipe(Effect.mapError((error) => providerError("addIssueCommentReaction", error)));
        const updated = yield* github
          .getIssue({ cwd: input.cwd, reference: input.reference })
          .pipe(Effect.mapError((error) => providerError("addIssueCommentReaction", error)));
        return toIssueDetail(updated, { fullContent: true });
      }),
    searchIssues: (input) =>
      github
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
      github
        .searchPullRequests({
          cwd: input.cwd,
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map((item) => toChangeRequest(item))),
          Effect.flatMap((items) => enrichChangeRequestsWithStacks({ cwd: input.cwd, items })),
          Effect.mapError((error) => providerError("searchChangeRequests", error)),
        ),
    getChangeRequestDetail: (input) =>
      Effect.gen(function* () {
        const raw = yield* github
          .getPullRequestDetail({ cwd: input.cwd, reference: input.reference })
          .pipe(Effect.mapError((error) => providerError("getChangeRequestDetail", error)));
        const detail = toChangeRequestDetail(raw, { fullContent: input.fullContent ?? false });
        const identity = parseGitHubRepositoryIdentityFromUrl(raw.url);
        if (!identity) return { ...detail, stackMetadataIncomplete: true };

        const enhancements = yield* Effect.all(
          {
            stack: invokeGitHubEffect("getPullRequestStack", () =>
              github.getPullRequestStack({
                cwd: input.cwd,
                host: identity.host,
                repository: identity.nameWithOwner,
                number: raw.number,
              }),
            ).pipe(
              Effect.match({
                onSuccess: (value) => ({ ok: true as const, value }),
                onFailure: () => ({ ok: false as const }),
              }),
            ),
            capabilities: invokeGitHubEffect("getRepositoryMergeCapabilities", () =>
              github.getRepositoryMergeCapabilities({
                cwd: input.cwd,
                host: identity.host,
                repository: identity.nameWithOwner,
              }),
            ).pipe(
              Effect.match({
                onSuccess: (value) => ({ ok: true as const, value }),
                onFailure: () => ({ ok: false as const }),
              }),
            ),
          },
          { concurrency: 2 },
        );
        const stack = enhancements.stack.ok ? enhancements.stack.value : null;
        return {
          ...detail,
          ...(stack ? { stack } : {}),
          stackMetadataIncomplete: !enhancements.stack.ok,
          ...(enhancements.capabilities.ok
            ? { mergeCapabilities: enhancements.capabilities.value }
            : {}),
        };
      }),
    mergeChangeRequest: (input) =>
      Effect.gen(function* () {
        const pullRequest = yield* github.getPullRequest({
          cwd: input.cwd,
          reference: input.reference,
        });
        const identity = parseGitHubRepositoryIdentityFromUrl(pullRequest.url);
        if (!identity) {
          return yield* new SourceControlProviderError({
            provider: "github",
            operation: "mergeChangeRequest",
            detail: "Could not verify the pull request's base GitHub repository.",
          });
        }

        const { stack, capabilities } = yield* Effect.all(
          {
            stack: github.getPullRequestStack({
              cwd: input.cwd,
              host: identity.host,
              repository: identity.nameWithOwner,
              number: pullRequest.number,
            }),
            capabilities: github.getRepositoryMergeCapabilities({
              cwd: input.cwd,
              host: identity.host,
              repository: identity.nameWithOwner,
            }),
          },
          { concurrency: 2 },
        ).pipe(Effect.mapError((error) => providerError("mergeChangeRequest", error)));
        if (!capabilities[input.mergeMethod]) {
          return yield* new SourceControlProviderError({
            provider: "github",
            operation: "mergeChangeRequest",
            detail: `The ${input.mergeMethod} merge method is disabled for this repository.`,
          });
        }
        return yield* github
          .mergePullRequestAsync({
            cwd: input.cwd,
            host: identity.host,
            repository: identity.nameWithOwner,
            number: pullRequest.number,
            mergeMethod: input.mergeMethod,
            stackMembership: stack ? "stacked" : "standalone",
          })
          .pipe(Effect.mapError((error) => providerError("mergeChangeRequest", error)));
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(SourceControlProviderError)(error)
            ? error
            : providerError("mergeChangeRequest", error),
        ),
      ),
    addChangeRequestComment: (input) =>
      Effect.gen(function* () {
        const existing = input.clientMutationId
          ? yield* github
              .getPullRequestDetail({ cwd: input.cwd, reference: input.reference })
              .pipe(Effect.mapError((error) => providerError("addChangeRequestComment", error)))
          : null;
        if (existing && hasCommentMutationMarker(existing.comments, input.clientMutationId)) {
          return toChangeRequestDetail(existing, { fullContent: true });
        }

        yield* withTempBodyFile(
          {
            operation: "addChangeRequestComment",
            prefix: "ryco-gh-comment-body-",
            body: appendCommentMutationMarker(input.body, input.clientMutationId),
          },
          (bodyFile) =>
            github
              .addPullRequestComment({
                cwd: input.cwd,
                reference: input.reference,
                bodyFile,
              })
              .pipe(Effect.mapError((error) => providerError("addChangeRequestComment", error))),
        );
        const updated = yield* github
          .getPullRequestDetail({ cwd: input.cwd, reference: input.reference })
          .pipe(Effect.mapError((error) => providerError("addChangeRequestComment", error)));
        return toChangeRequestDetail(updated, { fullContent: true });
      }),
    addChangeRequestCommentReaction: (input) =>
      Effect.gen(function* () {
        const reactionGroups = yield* github
          .getCommentReactionGroups({ cwd: input.cwd, commentIds: [input.commentId] })
          .pipe(
            Effect.mapError((error) => providerError("addChangeRequestCommentReaction", error)),
          );
        const viewerHasReacted =
          reactionGroups
            .find((group) => group.id === input.commentId)
            ?.reactions.find((reaction) => reaction.content === input.content)?.viewerHasReacted ===
          true;
        const reactionMutation = viewerHasReacted ? github.removeReaction : github.addReaction;
        yield* reactionMutation({
          cwd: input.cwd,
          subjectId: input.commentId,
          content: input.content,
        }).pipe(
          Effect.mapError((error) => providerError("addChangeRequestCommentReaction", error)),
        );
        const updated = yield* github
          .getPullRequestDetail({ cwd: input.cwd, reference: input.reference })
          .pipe(
            Effect.mapError((error) => providerError("addChangeRequestCommentReaction", error)),
          );
        return toChangeRequestDetail(updated, { fullContent: true });
      }),
    getChangeRequestFilesViewed: (input) =>
      github
        .getPullRequestFilesViewed(input)
        .pipe(Effect.mapError((error) => providerError("getChangeRequestFilesViewed", error))),
    setChangeRequestFileViewed: (input) =>
      github
        .setPullRequestFileViewed(input)
        .pipe(Effect.mapError((error) => providerError("setChangeRequestFileViewed", error))),
    getChangeRequestDiff: (input) =>
      github
        .getPullRequestDiff(input)
        .pipe(Effect.mapError((error) => providerError("getChangeRequestDiff", error))),
    createIssue: (input) =>
      withTempBodyFile(
        {
          operation: "createIssue",
          prefix: "ryco-gh-issue-body-",
          body: input.body,
        },
        (bodyFile) =>
          Effect.gen(function* () {
            const created = yield* github
              .createIssue({
                cwd: input.cwd,
                title: input.title,
                bodyFile,
                ...(input.labels ? { labels: input.labels } : {}),
                ...(input.assignees ? { assignees: input.assignees } : {}),
              })
              .pipe(Effect.mapError((cause) => providerError("createIssue", cause)));
            const detail = yield* github
              .getIssue({ cwd: input.cwd, reference: String(created.number) })
              .pipe(
                Effect.mapError((cause) => providerError("createIssue", cause)),
                Effect.catch(() =>
                  Effect.succeed({
                    provider: "github",
                    number: created.number,
                    title: input.title,
                    url: created.url,
                    state: "open" as const,
                    updatedAt: Option.none(),
                  } satisfies SourceControlIssueSummary),
                ),
              );
            if ("body" in detail) {
              return toIssueSummary(detail);
            }
            return detail;
          }),
      ),
    listLabels: (input) =>
      github
        .listLabels({ cwd: input.cwd })
        .pipe(Effect.mapError((cause) => providerError("listLabels", cause))),
    listAssignees: (input) =>
      github.listAssignees({ cwd: input.cwd }).pipe(
        Effect.map((users) =>
          users.map((u) => ({
            login: u.login,
            ...(u.name ? { displayName: u.name } : {}),
            ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
          })),
        ),
        Effect.mapError((cause) => providerError("listAssignees", cause)),
      ),
    getPullRequestState: (input) =>
      github.getPullRequest({ cwd: input.cwd, reference: String(input.number) }).pipe(
        Effect.map((summary) => ({
          state: summary.state ?? "open",
          isDraft: summary.isDraft ?? false,
        })),
        Effect.mapError((cause) => providerError("getPullRequestState", cause)),
      ),
    getIssueState: (input) =>
      github.getIssue({ cwd: input.cwd, reference: String(input.number) }).pipe(
        Effect.map((detail) => ({ state: detail.state })),
        Effect.mapError((cause) => providerError("getIssueState", cause)),
      ),
    listWorkflowRuns: (input) =>
      Effect.gen(function* () {
        let repositoryNameWithOwner: string | null = null;
        let headSha: string | null = input.commitSha?.trim() || null;

        if (input.pullRequestNumber !== undefined && headSha === null) {
          const context = yield* github.getPullRequestWorkflowContext({
            cwd: input.cwd,
            reference: String(input.pullRequestNumber),
          });
          repositoryNameWithOwner =
            context.baseRepositoryNameWithOwner ?? context.headRepositoryNameWithOwner;
          headSha = context.headSha;
        }

        // With neither a pull request nor an explicit commit, fall back to a
        // branch scope (the default branch has no PR head to filter on). GitHub
        // returns runs across every commit on the branch, so we narrow to the
        // newest commit below to mirror the single-commit view a PR head gives.
        const branch =
          headSha === null && input.pullRequestNumber === undefined
            ? input.branch?.trim() || null
            : null;

        const fetched = yield* github.listWorkflowRuns({
          cwd: input.cwd,
          ...(headSha ? { headSha } : {}),
          ...(branch ? { branch } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });

        let runs = fetched;
        let resolvedHeadSha = headSha;
        if (branch !== null && fetched.length > 0) {
          const oid = newestWorkflowRunCommitOid(fetched);
          if (oid !== null) {
            resolvedHeadSha = oid;
            runs = fetched.filter((run) => run.commit.oid === oid);
          }
        }

        repositoryNameWithOwner =
          repositoryNameWithOwner ??
          runs.find((run) => run.repositoryNameWithOwner !== null)?.repositoryNameWithOwner ??
          null;

        return {
          provider: "github",
          repository: optionFromString(repositoryNameWithOwner),
          pullRequestNumber:
            input.pullRequestNumber !== undefined
              ? Option.some(input.pullRequestNumber)
              : Option.none(),
          headSha: optionFromString(resolvedHeadSha),
          runs: runs.map(toWorkflowRun),
        } satisfies SourceControlWorkflowRunListResult;
      }).pipe(Effect.mapError((cause) => providerError("listWorkflowRuns", cause))),
    getWorkflowRunJobs: (input) =>
      github.listWorkflowRunJobs({ cwd: input.cwd, runId: input.runId }).pipe(
        Effect.map(
          (jobs) =>
            ({
              provider: "github",
              runId: input.runId,
              jobs: jobs.map(toWorkflowJob),
            }) satisfies SourceControlWorkflowRunJobsResult,
        ),
        Effect.mapError((cause) => providerError("getWorkflowRunJobs", cause)),
      ),
    getWorkflowJobLog: (input) =>
      github.getWorkflowJobLog(input).pipe(
        Effect.map((log) => {
          const truncated = truncateWorkflowLog(log);
          return {
            provider: "github",
            runId: input.runId,
            jobId: input.jobId,
            ...truncated,
          } satisfies SourceControlWorkflowJobLogResult;
        }),
        Effect.mapError((cause) => providerError("getWorkflowJobLog", cause)),
      ),
    rerunWorkflow: (input) =>
      Effect.gen(function* () {
        if (input.target === "job") {
          yield* github.rerunWorkflowJob({ cwd: input.cwd, jobId: input.jobId });
          return {
            provider: "github",
            runId: input.runId,
            target: "job",
            jobId: input.jobId,
          } satisfies SourceControlWorkflowRerunResult;
        }

        yield* github.rerunFailedWorkflowJobs({ cwd: input.cwd, runId: input.runId });
        return {
          provider: "github",
          runId: input.runId,
          target: "failed-jobs",
        } satisfies SourceControlWorkflowRerunResult;
      }).pipe(Effect.mapError((cause) => providerError("rerunWorkflow", cause))),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());
