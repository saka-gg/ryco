/**
 * Pull request page operations for Azure DevOps, composed from `az repos`
 * commands, `az devops invoke` REST calls (Git REST 7.1) and local `git` for
 * diffs and file contents (Azure has no REST endpoint that returns hunks).
 * Mapping lives in `azureDevOpsPullRequestPage.ts`; this module only fetches,
 * sequences and guards.
 */
import { Clock, type DateTime, Effect, Result, Schema } from "effect";
import {
  CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
  type ChangeRequestActivity,
  type ChangeRequestFileContents,
  type ChangeRequestInvolvement,
  type ChangeRequestReviewThread,
  type ChangeRequestSetThreadResolvedResult,
  type ChangeRequestSubmitReviewInput,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateAction,
  type ChangeRequestUpdateCommentInput,
  type ChangeRequestUpdateCommentResult,
  type SourceControlAssigneeCandidate,
  type SourceControlChangeRequestCommit,
  type SourceControlChangeRequestMergeCapabilities,
  type SourceControlChangeRequestMergeMethod,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlChangeRequestReviewDecision,
  type SourceControlChangeRequestReviewer,
  type SourceControlChangeRequestAutoMerge,
  type SourceControlLabel,
  type SourceControlMergeChangeRequestResult,
} from "@ryco/contracts";

import { AzureDevOpsCliError, type AzureDevOpsCliShape } from "./AzureDevOpsCli.ts";
import {
  AZURE_DEVOPS_DESCRIPTION_MAX_CHARS,
  AZURE_DEVOPS_GIT_PERMISSION_GENERIC_CONTRIBUTE,
  AZURE_DEVOPS_GIT_PERMISSION_PULL_REQUEST_CONTRIBUTE,
  AZURE_DEVOPS_GIT_SECURITY_NAMESPACE,
  AZURE_DEVOPS_ITERATION_CHANGES_PAGE,
  AZURE_DEVOPS_PULL_REQUEST_COMMITS_PAGE,
  AzureDevOpsCommentSchema,
  AzureDevOpsConnectionDataSchema,
  AzureDevOpsIterationChangesSchema,
  AzureDevOpsIterationSchema,
  AzureDevOpsPermissionsSchema,
  AzureDevOpsPolicyEvaluationSchema,
  AzureDevOpsProfileSchema,
  AzureDevOpsRefUpdateResultSchema,
  AzureDevOpsTagSchema,
  AzureDevOpsTeamMemberSchema,
  AzureDevOpsThreadSchema,
  azureDevOpsAutoMerge,
  azureDevOpsChangeTrackingIds,
  azureDevOpsCollection,
  azureDevOpsMergeCapabilities,
  azureDevOpsMergeStateStatus,
  azureDevOpsMergeStrategy,
  azureDevOpsReviewDecision,
  azureDevOpsReviewerStates,
  azureDevOpsViewerFromConnectionData,
  azureDevOpsViewerFromProfile,
  buildAzureDevOpsCommentThreadBody,
  buildAzureDevOpsFileThreadBody,
  buildAzureDevOpsReplyBody,
  decodeAzureDevOpsCommentId,
  decodeAzureDevOpsJson,
  decodeAzureDevOpsThreadId,
  flattenAzureDevOpsThreadComments,
  isAzureDevOpsThreadResolved,
  isGitObjectId,
  latestAzureDevOpsIteration,
  toAzureDevOpsChangeRequestCommit,
  toAzureDevOpsReviewThread,
  toAzureDevOpsReviewThreads,
  toAzureDevOpsTimeline,
  toAzureDevOpsViewerCapabilities,
  type AzureDevOpsPolicyEvaluation,
  type AzureDevOpsThread,
  type AzureDevOpsViewerIdentity,
  type AzureDevOpsViewerPermissions,
} from "./azureDevOpsPullRequestPage.ts";
import {
  AzureDevOpsPullRequestSchema,
  azureDevOpsIdentityLogin,
  normalizeAzureDevOpsPullRequestRecord,
  type AzureDevOpsCommitRef,
  type AzureDevOpsPullRequest,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";

export const AZURE_DEVOPS_DIFF_MAX_BYTES = 8 * 1024 * 1024;
const VIEWER_CACHE_TTL_MS = 10 * 60 * 1000;
const ZERO_OBJECT_ID = "0".repeat(40);

export const AZURE_DEVOPS_HEAD_CHANGED_DETAIL =
  "The pull request's head changed since it was loaded. Refresh and review the new commits, then try again.";

/** Everything the page detail needs beyond the list record. */
export interface AzureDevOpsPullRequestDetail extends NormalizedAzureDevOpsPullRequestRecord {
  readonly body: string;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly author: string;
    readonly body: string;
    readonly createdAt: string;
  }>;
  readonly commits: ReadonlyArray<SourceControlChangeRequestCommit>;
  readonly reviewers: ReadonlyArray<string>;
  readonly reviewerStates: ReadonlyArray<SourceControlChangeRequestReviewer>;
  readonly reviewDecision: SourceControlChangeRequestReviewDecision | null;
  readonly mergeStateStatus?: SourceControlChangeRequestMergeStateStatus;
  readonly mergeCapabilities?: SourceControlChangeRequestMergeCapabilities;
  readonly autoMerge: SourceControlChangeRequestAutoMerge | null;
  readonly closedAt?: DateTime.Utc;
  readonly mergedAt?: DateTime.Utc;
  readonly mergedBy?: string;
}

interface Scope {
  readonly project: string;
  readonly projectId: string | null;
  readonly repositoryId: string;
  readonly pullRequestId: number;
}

function cliError(operation: string, detail: string, cause?: unknown): AzureDevOpsCliError {
  return new AzureDevOpsCliError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function scopeOf(
  operation: string,
  pullRequest: AzureDevOpsPullRequest,
): Effect.Effect<Scope, AzureDevOpsCliError> {
  const repositoryId = pullRequest.repository?.id?.trim();
  const projectId = pullRequest.repository?.project?.id?.trim() || null;
  const project = projectId ?? pullRequest.repository?.project?.name?.trim();
  return repositoryId && project
    ? Effect.succeed({
        project,
        projectId,
        repositoryId,
        pullRequestId: pullRequest.pullRequestId,
      })
    : Effect.fail(
        cliError(
          operation,
          "Azure DevOps did not report the pull request's project and repository.",
        ),
      );
}

function route(scope: Scope, extra: Readonly<Record<string, string | number>> = {}) {
  return {
    project: scope.project,
    repositoryId: scope.repositoryId,
    pullRequestId: scope.pullRequestId,
    ...extra,
  };
}

function decodeWith<S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
) {
  const decode = decodeAzureDevOpsJson(schema);
  return (raw: string): Effect.Effect<S["Type"], AzureDevOpsCliError> => {
    const decoded = decode(raw);
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.fail(
          cliError(
            operation,
            "Azure DevOps returned a response Ryco could not read.",
            decoded.failure,
          ),
        );
  };
}

function normalizeReference(reference: string): string {
  const trimmed = reference.trim().replace(/^#/u, "");
  const urlMatch = /(?:pullrequest|pull-request|pull|_pulls?)\/(\d+)(?:\D.*)?$/iu.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function stripHeads(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//u, "");
}

function headOf(pullRequest: AzureDevOpsPullRequest): string | null {
  return pullRequest.lastMergeSourceCommit?.commitId?.trim() || null;
}

const ThreadCollection = azureDevOpsCollection(AzureDevOpsThreadSchema);
const IterationCollection = azureDevOpsCollection(AzureDevOpsIterationSchema);
const CommitCollection = azureDevOpsCollection(
  Schema.Struct({
    commitId: Schema.String,
    comment: Schema.optional(Schema.NullOr(Schema.String)),
    author: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
          email: Schema.optional(Schema.NullOr(Schema.String)),
          date: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
    committer: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
          email: Schema.optional(Schema.NullOr(Schema.String)),
          date: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);
const PolicyEvaluationList = Schema.Array(AzureDevOpsPolicyEvaluationSchema);
const TeamMemberList = Schema.Array(AzureDevOpsTeamMemberSchema);
const TagCollection = azureDevOpsCollection(AzureDevOpsTagSchema);
const RefUpdateCollection = azureDevOpsCollection(AzureDevOpsRefUpdateResultSchema);
const ReviewerVoteSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  vote: Schema.optional(Schema.NullOr(Schema.Number)),
});
const RepositorySchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  project: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const ProjectSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  defaultTeam: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

export type AzureDevOpsPullRequestOperations = ReturnType<
  typeof makeAzureDevOpsPullRequestOperations
>;

export function makeAzureDevOpsPullRequestOperations(azure: AzureDevOpsCliShape) {
  const viewerCache = new Map<
    string,
    { readonly viewer: AzureDevOpsViewerIdentity | null; readonly expiresAt: number }
  >();

  const executeJson = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    azure.execute({ cwd, args: [...args, "--only-show-errors", "--output", "json"] }).pipe(
      Effect.map((output) => output.stdout.trim()),
      Effect.mapError((error) => cliError(operation, error.detail, error)),
    );

  const readPullRequest = (cwd: string, reference: string) =>
    azure.getRawPullRequest({ cwd, reference: normalizeReference(reference) });

  const listIterations = (cwd: string, scope: Scope) =>
    azure
      .invoke({
        cwd,
        operation: "listPullRequestIterations",
        area: "git",
        resource: "pullRequestIterations",
        routeParameters: route(scope),
      })
      .pipe(
        Effect.flatMap(decodeWith("listPullRequestIterations", IterationCollection)),
        Effect.map((collection) => collection.value),
      );

  const listThreads = (cwd: string, scope: Scope, iterationId: number | null) =>
    azure
      .invoke({
        cwd,
        operation: "listPullRequestThreads",
        area: "git",
        resource: "pullRequestThreads",
        routeParameters: route(scope),
        ...(iterationId !== null ? { queryParameters: { $iteration: iterationId } } : {}),
      })
      .pipe(
        Effect.flatMap(decodeWith("listPullRequestThreads", ThreadCollection)),
        Effect.map((collection) => collection.value),
      );

  const getThread = (cwd: string, scope: Scope, threadId: number, iterationId: number | null) =>
    azure
      .invoke({
        cwd,
        operation: "getPullRequestThread",
        area: "git",
        resource: "pullRequestThreads",
        routeParameters: route(scope, { threadId }),
        ...(iterationId !== null ? { queryParameters: { $iteration: iterationId } } : {}),
      })
      .pipe(Effect.flatMap(decodeWith("getPullRequestThread", AzureDevOpsThreadSchema)));

  const listCommits = (cwd: string, scope: Scope) =>
    azure
      .invoke({
        cwd,
        operation: "listPullRequestCommits",
        area: "git",
        resource: "pullRequestCommits",
        routeParameters: route(scope),
        queryParameters: { $top: AZURE_DEVOPS_PULL_REQUEST_COMMITS_PAGE },
      })
      .pipe(
        Effect.flatMap(decodeWith("listPullRequestCommits", CommitCollection)),
        Effect.map((collection) => ({
          commits: collection.value.filter((commit) => commit.commitId.trim().length > 0),
          truncated:
            Boolean(collection.continuation_token) ||
            collection.value.length >= AZURE_DEVOPS_PULL_REQUEST_COMMITS_PAGE,
        })),
      );

  const listPolicyEvaluations = (cwd: string, pullRequestId: number) =>
    executeJson(cwd, "listPolicyEvaluations", [
      "repos",
      "pr",
      "policy",
      "list",
      "--detect",
      "true",
      "--id",
      String(pullRequestId),
    ]).pipe(
      Effect.flatMap((raw) =>
        raw.length === 0
          ? Effect.succeed([] as ReadonlyArray<AzureDevOpsPolicyEvaluation>)
          : decodeWith("listPolicyEvaluations", PolicyEvaluationList)(raw),
      ),
      Effect.map((evaluations): ReadonlyArray<AzureDevOpsPolicyEvaluation> | null => evaluations),
      Effect.catch((error) =>
        Effect.logWarning("Azure DevOps: could not read pull request policies.", {
          pullRequestId,
          detail: error.detail,
        }).pipe(Effect.as(null)),
      ),
    );

  /** The signed-in identity: connection data, else the profile; cached per checkout. */
  const resolveViewer = (cwd: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = viewerCache.get(cwd);
      if (cached && cached.expiresAt > now) return cached.viewer;
      const fromConnection = azure
        .invoke({
          cwd,
          operation: "getConnectionData",
          area: "Location",
          resource: "connectionData",
          routeParameters: {},
          apiVersion: "7.1-preview",
        })
        .pipe(
          Effect.flatMap(decodeWith("getConnectionData", AzureDevOpsConnectionDataSchema)),
          Effect.map(azureDevOpsViewerFromConnectionData),
        );
      const fromProfile = azure
        .invoke({
          cwd,
          operation: "getProfile",
          area: "Profile",
          resource: "Profiles",
          routeParameters: { id: "me" },
        })
        .pipe(
          Effect.flatMap(decodeWith("getProfile", AzureDevOpsProfileSchema)),
          Effect.map(azureDevOpsViewerFromProfile),
        );
      const viewer = yield* fromConnection.pipe(
        Effect.flatMap((found) => (found ? Effect.succeed(found) : fromProfile)),
        Effect.catch(() => fromProfile),
        Effect.catch((error) =>
          Effect.logWarning("Azure DevOps: could not resolve the signed-in identity.", {
            detail: error.detail,
          }).pipe(Effect.as(null)),
        ),
      );
      viewerCache.set(cwd, { viewer, expiresAt: now + VIEWER_CACHE_TTL_MS });
      return viewer;
    });

  /** Repository-level Git permissions of the caller (Security - Has Permissions). */
  const readPermissions = (cwd: string, scope: Scope) => {
    if (!scope.projectId) return Effect.succeed(null);
    const has = (permission: number) =>
      azure
        .invoke({
          cwd,
          operation: "hasPermissions",
          area: "Security",
          resource: "Permissions",
          routeParameters: {
            securityNamespaceId: AZURE_DEVOPS_GIT_SECURITY_NAMESPACE,
            permissions: permission,
          },
          queryParameters: {
            tokens: `repoV2/${scope.projectId}/${scope.repositoryId}`,
            alwaysAllowAdministrators: true,
          },
        })
        .pipe(
          Effect.flatMap(decodeWith("hasPermissions", AzureDevOpsPermissionsSchema)),
          Effect.map((result) => result.value[0] === true),
        );
    return Effect.all(
      {
        pullRequestContribute: has(AZURE_DEVOPS_GIT_PERMISSION_PULL_REQUEST_CONTRIBUTE),
        genericContribute: has(AZURE_DEVOPS_GIT_PERMISSION_GENERIC_CONTRIBUTE),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map((permissions): AzureDevOpsViewerPermissions | null => permissions),
      Effect.catch((error) =>
        Effect.logWarning("Azure DevOps: could not read repository permissions.", {
          detail: error.detail,
        }).pipe(Effect.as(null)),
      ),
    );
  };

  const viewerCapabilities = (cwd: string, scope: Scope, pullRequest: AzureDevOpsPullRequest) =>
    Effect.all([resolveViewer(cwd), readPermissions(cwd, scope)], { concurrency: 2 }).pipe(
      Effect.map(([viewer, permissions]) => ({
        viewerId: viewer?.id ?? null,
        viewer: viewer
          ? toAzureDevOpsViewerCapabilities({ viewer, permissions, pullRequest })
          : null,
      })),
    );

  // ── Local git ──────────────────────────────────────────────────────

  const hasCommit = (cwd: string, sha: string) =>
    azure
      .runGit({
        cwd,
        operation: "hasCommit",
        args: ["cat-file", "-e", `${sha}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((output) => output.exitCode === 0));

  /**
   * Make `shas` available in the checkout: fetch them by id, then fall back
   * to the pull request's refs (`refs/pull/<id>/merge` carries the last test
   * merge's parents) for servers that refuse unadvertised objects.
   */
  const ensureCommits = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly remoteName: string;
    readonly shas: ReadonlyArray<string>;
    readonly pullRequest: AzureDevOpsPullRequest | null;
  }) =>
    Effect.gen(function* () {
      for (const sha of input.shas) {
        if (!isGitObjectId(sha)) {
          return yield* cliError(input.operation, `Invalid commit id: ${sha}`);
        }
      }
      const missing = yield* Effect.filter(input.shas, (sha) =>
        hasCommit(input.cwd, sha).pipe(Effect.map((present) => !present)),
      );
      if (missing.length === 0) return;
      yield* azure.runGit({
        cwd: input.cwd,
        operation: input.operation,
        args: ["fetch", "--quiet", "--no-tags", input.remoteName, ...missing],
        allowNonZeroExit: true,
        timeoutMs: 120_000,
      });
      const stillMissing = yield* Effect.filter(missing, (sha) =>
        hasCommit(input.cwd, sha).pipe(Effect.map((present) => !present)),
      );
      if (stillMissing.length === 0) return;
      const pullRequest = input.pullRequest;
      if (pullRequest) {
        for (const ref of [
          `refs/pull/${pullRequest.pullRequestId}/merge`,
          pullRequest.sourceRefName,
          pullRequest.targetRefName,
        ]) {
          yield* azure.runGit({
            cwd: input.cwd,
            operation: input.operation,
            args: ["fetch", "--quiet", "--no-tags", input.remoteName, ref],
            allowNonZeroExit: true,
            timeoutMs: 120_000,
          });
        }
      }
      const unavailable = yield* Effect.filter(stillMissing, (sha) =>
        hasCommit(input.cwd, sha).pipe(Effect.map((present) => !present)),
      );
      if (unavailable.length > 0) {
        return yield* cliError(
          input.operation,
          `Could not fetch commit ${unavailable[0]!.slice(0, 7)} from ${input.remoteName}.`,
        );
      }
    });

  // The page parses `a/` / `b/` headers, so the user's diff config (`diff.noprefix`,
  // `diff.srcPrefix`, `diff.relative`, textconv drivers, `diff.submodule`) must not apply.
  const gitDiff = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    azure
      .runGit({
        cwd,
        operation,
        args: [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--no-relative",
          "--submodule=short",
          ...args,
        ],
        maxOutputBytes: AZURE_DEVOPS_DIFF_MAX_BYTES,
        timeoutMs: 120_000,
      })
      .pipe(
        Effect.flatMap((output) =>
          output.stdoutTruncated
            ? Effect.fail(cliError(operation, "This diff is too large to display."))
            : Effect.succeed(output.stdout),
        ),
      );

  const readBlob = (cwd: string, revision: string, path: string) =>
    azure
      .runGit({
        cwd,
        operation: "getChangeRequestFileContents",
        args: ["cat-file", "blob", `${revision}:${path}`],
        allowNonZeroExit: true,
        maxOutputBytes: CHANGE_REQUEST_FILE_CONTENTS_MAX_BYTES,
      })
      .pipe(
        Effect.map((output) => {
          // Absent on this side (added or deleted), or binary: nothing to expand.
          if (output.exitCode !== 0 || output.stdout.includes("\u0000")) {
            return { contents: null, truncated: false };
          }
          return { contents: output.stdout, truncated: output.stdoutTruncated };
        }),
      );

  const verifyHead = (
    operation: string,
    pullRequest: AzureDevOpsPullRequest,
    expected: string,
  ): Effect.Effect<void, AzureDevOpsCliError> => {
    const head = headOf(pullRequest);
    return head !== null && head.toLowerCase() === expected.trim().toLowerCase()
      ? Effect.void
      : Effect.fail(cliError(operation, AZURE_DEVOPS_HEAD_CHANGED_DETAIL));
  };

  const findPullRequestCommit = (
    operation: string,
    commits: ReadonlyArray<AzureDevOpsCommitRef>,
    commitSha: string,
    pullRequestId: number,
  ): Effect.Effect<string, AzureDevOpsCliError> => {
    const wanted = commitSha.trim().toLowerCase();
    const matches = commits.filter((commit) =>
      wanted.length >= 7
        ? commit.commitId.toLowerCase().startsWith(wanted)
        : commit.commitId.toLowerCase() === wanted,
    );
    return matches.length === 1
      ? Effect.succeed(matches[0]!.commitId)
      : Effect.fail(
          cliError(operation, `Commit ${commitSha} is not part of pull request #${pullRequestId}.`),
        );
  };

  // ── Reads ──────────────────────────────────────────────────────────

  const getDetail = (input: { readonly cwd: string; readonly reference: string }) =>
    Effect.gen(function* () {
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf("getChangeRequestDetail", pullRequest);
      const [threads, commits, evaluations] = yield* Effect.all(
        [
          listThreads(input.cwd, scope, null).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Azure DevOps: could not read pull request threads.", {
                pullRequestId: scope.pullRequestId,
                detail: error.detail,
              }).pipe(Effect.as([] as ReadonlyArray<AzureDevOpsThread>)),
            ),
          ),
          listCommits(input.cwd, scope).pipe(
            Effect.map((page) => page.commits),
            Effect.catch((error) =>
              Effect.logWarning("Azure DevOps: could not read pull request commits.", {
                pullRequestId: scope.pullRequestId,
                detail: error.detail,
              }).pipe(Effect.as([] as ReadonlyArray<AzureDevOpsCommitRef>)),
            ),
          ),
          listPolicyEvaluations(input.cwd, scope.pullRequestId),
        ],
        { concurrency: 3 },
      );
      return toDetail({ pullRequest, threads, commits, evaluations });
    });

  const getActivity = (input: { readonly cwd: string; readonly reference: string }) =>
    Effect.gen(function* () {
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf("getChangeRequestActivity", pullRequest);
      const [iterations, commitPage, access] = yield* Effect.all(
        [
          listIterations(input.cwd, scope),
          listCommits(input.cwd, scope),
          viewerCapabilities(input.cwd, scope, pullRequest),
        ],
        { concurrency: 3 },
      );
      const latest = latestAzureDevOpsIteration(iterations);
      const threads = yield* listThreads(input.cwd, scope, latest?.id ?? null);
      const timeline = toAzureDevOpsTimeline({
        pullRequest,
        threads,
        iterations,
        commits: commitPage.commits,
        commitsTruncated: commitPage.truncated,
        viewerId: access.viewerId,
      });
      const reviewThreads = toAzureDevOpsReviewThreads({
        threads,
        iterations,
        viewer: access.viewer,
        viewerId: access.viewerId,
      });
      const headSha = headOf(pullRequest) ?? latest?.sourceRefCommit?.commitId?.trim() ?? null;
      return {
        provider: "azure-devops",
        number: pullRequest.pullRequestId,
        headSha: headSha && headSha.length > 0 ? headSha : null,
        viewer: access.viewer,
        timeline: timeline.timeline,
        timelineTruncated: timeline.truncated,
        reviewThreads: reviewThreads.threads,
        reviewThreadsTruncated: reviewThreads.truncated,
        pendingReview: null,
      } satisfies ChangeRequestActivity;
    });

  const getDiff = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly remoteName: string;
    readonly expectedHeadSha?: string | undefined;
    readonly commitSha?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const operation = "getChangeRequestDiff";
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      if (input.expectedHeadSha) {
        yield* verifyHead(operation, pullRequest, input.expectedHeadSha).pipe(
          Effect.mapError(() =>
            cliError(
              operation,
              "Pull request changed while loading the diff. Refresh and try again.",
            ),
          ),
        );
      }
      const commitSha = input.commitSha?.trim();
      if (commitSha) {
        const scope = yield* scopeOf(operation, pullRequest);
        const page = yield* listCommits(input.cwd, scope);
        const sha = yield* findPullRequestCommit(
          operation,
          page.commits,
          commitSha,
          pullRequest.pullRequestId,
        );
        yield* ensureCommits({
          cwd: input.cwd,
          operation,
          remoteName: input.remoteName,
          shas: [sha],
          pullRequest,
        });
        return yield* gitDiff(input.cwd, operation, [`${sha}^1`, sha]);
      }
      const head = headOf(pullRequest);
      const target = pullRequest.lastMergeTargetCommit?.commitId?.trim();
      if (!head || !target) {
        return yield* cliError(
          operation,
          "Azure DevOps has not prepared this pull request's merge yet. Try again shortly.",
        );
      }
      yield* ensureCommits({
        cwd: input.cwd,
        operation,
        remoteName: input.remoteName,
        shas: [target, head],
        pullRequest,
      });
      return yield* gitDiff(input.cwd, operation, [`${target}...${head}`]);
    });

  const getFileContents = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly remoteName: string;
    readonly path: string;
    readonly previousPath?: string | undefined;
    readonly baseSha?: string | undefined;
    readonly headSha: string;
  }) =>
    Effect.gen(function* () {
      const operation = "getChangeRequestFileContents";
      for (const path of [input.path, input.previousPath]) {
        if (path !== undefined && !isRepositoryPath(path)) {
          return yield* cliError(operation, `Invalid repository file path: ${path}`);
        }
      }
      for (const sha of [input.headSha, input.baseSha]) {
        if (sha !== undefined && !isGitObjectId(sha)) {
          return yield* cliError(operation, `Invalid commit id: ${sha}`);
        }
      }
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const target = pullRequest.lastMergeTargetCommit?.commitId?.trim();
      const baseRevision = input.baseSha ?? target;
      if (!baseRevision) {
        return yield* cliError(
          operation,
          "Azure DevOps has not prepared this pull request's merge yet. Try again shortly.",
        );
      }
      yield* ensureCommits({
        cwd: input.cwd,
        operation,
        remoteName: input.remoteName,
        shas: [input.headSha, baseRevision],
        pullRequest,
      });
      // The whole change request diffs against merge-base(target, head), like the diff.
      const baseSha = input.baseSha
        ? input.baseSha
        : yield* azure
            .runGit({
              cwd: input.cwd,
              operation,
              args: ["merge-base", baseRevision, input.headSha],
            })
            .pipe(
              Effect.flatMap((output) => {
                const sha = output.stdout.trim();
                return isGitObjectId(sha)
                  ? Effect.succeed(sha)
                  : Effect.fail(cliError(operation, "No merge base for this pull request."));
              }),
            );
      const [oldSide, newSide] = yield* Effect.all(
        [
          readBlob(input.cwd, baseSha, input.previousPath ?? input.path),
          readBlob(input.cwd, input.headSha, input.path),
        ],
        { concurrency: 2 },
      );
      return {
        path: input.path,
        oldContents: oldSide.contents,
        newContents: newSide.contents,
        truncated: oldSide.truncated || newSide.truncated,
      } satisfies ChangeRequestFileContents;
    });

  const listChangeRequests = (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly source?: { readonly refName: string } | undefined;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number | undefined;
    readonly involvement?: ChangeRequestInvolvement | undefined;
    readonly query?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 20;
      const query = input.query?.trim().toLowerCase() ?? "";
      // Free text has no server-side filter: read a wider page and match titles here.
      const top = query.length > 0 ? Math.max(limit * 5, 100) : limit;
      const base = {
        cwd: input.cwd,
        headSelector: input.headSelector,
        ...(input.source ? { source: input.source } : {}),
        state: input.state,
        limit: top,
      };
      let rows: ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>;
      switch (input.involvement) {
        case undefined:
          rows = yield* azure.listPullRequests(base);
          break;
        case "authored":
          rows = yield* azure.listPullRequests({ ...base, creator: "me" });
          break;
        case "review-requested":
          rows = yield* azure.listPullRequests({ ...base, reviewer: "me" });
          break;
        case "involved": {
          const [authored, reviewing] = yield* Effect.all(
            [
              azure.listPullRequests({ ...base, creator: "me" }),
              azure.listPullRequests({ ...base, reviewer: "me" }),
            ],
            { concurrency: 2 },
          );
          const seen = new Set<number>();
          rows = [...authored, ...reviewing]
            .filter((row) => (seen.has(row.number) ? false : (seen.add(row.number), true)))
            .toSorted((left, right) => right.number - left.number);
          break;
        }
        case "assigned":
        case "mentioned":
          return yield* cliError(
            "listChangeRequests",
            `Azure DevOps has no ${input.involvement === "assigned" ? "assignees" : "mentions"} on pull requests to filter by.`,
          );
      }
      const matching =
        query.length === 0
          ? rows
          : rows.filter(
              (row) =>
                row.title.toLowerCase().includes(query) ||
                `#${row.number}` === query ||
                String(row.number) === query,
            );
      return matching.slice(0, limit);
    });

  // ── Conversation ───────────────────────────────────────────────────

  const addComment = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly body: string;
  }) =>
    Effect.gen(function* () {
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf("addChangeRequestComment", pullRequest);
      yield* azure.invoke({
        cwd: input.cwd,
        operation: "addChangeRequestComment",
        area: "git",
        resource: "pullRequestThreads",
        routeParameters: route(scope),
        httpMethod: "POST",
        body: buildAzureDevOpsCommentThreadBody(input.body),
      });
    });

  const readReviewThread = (
    cwd: string,
    scope: Scope,
    pullRequest: AzureDevOpsPullRequest,
    threadId: number,
  ) =>
    Effect.gen(function* () {
      const [iterations, access] = yield* Effect.all(
        [listIterations(cwd, scope), viewerCapabilities(cwd, scope, pullRequest)],
        { concurrency: 2 },
      );
      const latest = latestAzureDevOpsIteration(iterations);
      const thread = yield* getThread(cwd, scope, threadId, latest?.id ?? null);
      return toAzureDevOpsReviewThread({
        thread,
        iterations,
        viewer: access.viewer,
        viewerId: access.viewerId,
      });
    });

  const replyToThread = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly threadId: string;
    readonly body: string;
  }) =>
    Effect.gen(function* () {
      const operation = "replyToReviewThread";
      const threadId = decodeAzureDevOpsThreadId(input.threadId);
      if (threadId === null) {
        return yield* cliError(operation, `Invalid review thread id: ${input.threadId}`);
      }
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf(operation, pullRequest);
      const thread = yield* getThread(input.cwd, scope, threadId, null);
      const parent =
        (thread.comments ?? []).find(
          (comment) => comment.isDeleted !== true && (comment.parentCommentId ?? 0) === 0,
        )?.id ?? 1;
      yield* azure
        .invoke({
          cwd: input.cwd,
          operation,
          area: "git",
          resource: "pullRequestThreadComments",
          routeParameters: route(scope, { threadId }),
          httpMethod: "POST",
          body: buildAzureDevOpsReplyBody({ content: input.body, parentCommentId: parent }),
        })
        .pipe(Effect.flatMap(decodeWith(operation, AzureDevOpsCommentSchema)));
      const updated = yield* readReviewThread(input.cwd, scope, pullRequest, threadId);
      if (!updated) {
        return yield* cliError(operation, `Thread ${threadId} is not a review thread on a file.`);
      }
      return updated satisfies ChangeRequestReviewThread;
    });

  const setThreadResolved = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly threadId: string;
    readonly resolved: boolean;
  }) =>
    Effect.gen(function* () {
      const operation = "setReviewThreadResolved";
      const threadId = decodeAzureDevOpsThreadId(input.threadId);
      if (threadId === null) {
        return yield* cliError(operation, `Invalid review thread id: ${input.threadId}`);
      }
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf(operation, pullRequest);
      const thread = yield* azure
        .invoke({
          cwd: input.cwd,
          operation,
          area: "git",
          resource: "pullRequestThreads",
          routeParameters: route(scope, { threadId }),
          httpMethod: "PATCH",
          body: { status: input.resolved ? "fixed" : "active" },
        })
        .pipe(Effect.flatMap(decodeWith(operation, AzureDevOpsThreadSchema)));
      return {
        threadId: String(thread.id),
        isResolved: isAzureDevOpsThreadResolved(thread.status),
      } satisfies ChangeRequestSetThreadResolvedResult;
    });

  const updateComment = (input: ChangeRequestUpdateCommentInput) =>
    Effect.gen(function* () {
      const operation = "updateChangeRequestComment";
      if (input.commentKind === "review") {
        return yield* cliError(operation, "Azure DevOps votes have no body to edit.");
      }
      const ids = decodeAzureDevOpsCommentId(input.commentId);
      if (!ids) return yield* cliError(operation, `Invalid comment id: ${input.commentId}`);
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf(operation, pullRequest);
      const routeParameters = route(scope, { threadId: ids.threadId, commentId: ids.commentId });
      if (input.action === "delete") {
        yield* azure.invoke({
          cwd: input.cwd,
          operation,
          area: "git",
          resource: "pullRequestThreadComments",
          routeParameters,
          httpMethod: "DELETE",
        });
        return {
          commentId: input.commentId,
          deleted: true,
        } satisfies ChangeRequestUpdateCommentResult;
      }
      yield* azure
        .invoke({
          cwd: input.cwd,
          operation,
          area: "git",
          resource: "pullRequestThreadComments",
          routeParameters,
          httpMethod: "PATCH",
          body: { content: input.body },
        })
        .pipe(Effect.flatMap(decodeWith(operation, AzureDevOpsCommentSchema)));
      return {
        commentId: input.commentId,
        deleted: false,
      } satisfies ChangeRequestUpdateCommentResult;
    });

  // ── Review ─────────────────────────────────────────────────────────

  const submitReview = (input: ChangeRequestSubmitReviewInput & { readonly webUrl?: string }) =>
    Effect.gen(function* () {
      const operation = "submitChangeRequestReview";
      const body = input.body?.trim() ?? "";
      if (input.event === "comment" && body.length === 0 && input.comments.length === 0) {
        return yield* cliError(
          operation,
          "Write a comment or add line comments before submitting.",
        );
      }
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf(operation, pullRequest);
      const iterations = yield* listIterations(input.cwd, scope);
      const latest = latestAzureDevOpsIteration(iterations);
      const iterationHead = latest?.sourceRefCommit?.commitId?.trim().toLowerCase();
      // Line comments anchor to the latest iteration: it must be the head the user reviewed.
      if (!latest || iterationHead !== input.expectedHeadSha.trim().toLowerCase()) {
        return yield* cliError(operation, AZURE_DEVOPS_HEAD_CHANGED_DETAIL);
      }
      const trackingIds =
        input.comments.length > 0
          ? yield* azure
              .invoke({
                cwd: input.cwd,
                operation,
                area: "git",
                resource: "pullRequestIterationChanges",
                routeParameters: route(scope, { iterationId: latest.id }),
                queryParameters: { $top: AZURE_DEVOPS_ITERATION_CHANGES_PAGE, $compareTo: 0 },
              })
              .pipe(
                Effect.flatMap(decodeWith(operation, AzureDevOpsIterationChangesSchema)),
                Effect.map(azureDevOpsChangeTrackingIds),
              )
          : new Map<string, number>();
      const createdThreadIds: number[] = [];
      const postThread = (threadBody: unknown) =>
        azure
          .invoke({
            cwd: input.cwd,
            operation,
            area: "git",
            resource: "pullRequestThreads",
            routeParameters: route(scope),
            httpMethod: "POST",
            body: threadBody,
          })
          .pipe(
            Effect.flatMap(decodeWith(operation, AzureDevOpsThreadSchema)),
            Effect.tap((thread) => Effect.sync(() => createdThreadIds.push(thread.id))),
          );
      if (body.length > 0) yield* postThread(buildAzureDevOpsCommentThreadBody(body));
      for (const comment of input.comments) {
        yield* postThread(
          buildAzureDevOpsFileThreadBody({
            comment,
            iterationId: latest.id,
            changeTrackingId: trackingIds.get(comment.path.replace(/^\/+/u, "")) ?? null,
          }),
        );
      }
      const vote =
        input.event === "approve"
          ? "approve"
          : input.event === "request_changes"
            ? "wait-for-author"
            : null;
      const url = input.webUrl ?? "";
      if (vote === null) {
        return {
          reviewId: `thread:${createdThreadIds[0] ?? 0}`,
          state: "commented",
          ...(url ? { url } : {}),
        } satisfies ChangeRequestSubmitReviewResult;
      }
      const reviewer = yield* executeJson(input.cwd, operation, [
        "repos",
        "pr",
        "set-vote",
        "--detect",
        "true",
        "--id",
        String(scope.pullRequestId),
        "--vote",
        vote,
      ]).pipe(Effect.flatMap(decodeWith(operation, ReviewerVoteSchema)));
      return {
        reviewId: `vote:${reviewer.id ?? "me"}:${reviewer.vote ?? (vote === "approve" ? 10 : -5)}`,
        state: input.event === "approve" ? "approved" : "changes_requested",
        ...(url ? { url } : {}),
      } satisfies ChangeRequestSubmitReviewResult;
    });

  // ── Lifecycle and merge ────────────────────────────────────────────

  const patchPullRequest = (cwd: string, operation: string, scope: Scope, body: unknown) =>
    azure
      .invoke({
        cwd,
        operation,
        area: "git",
        resource: "pullRequests",
        routeParameters: route(scope),
        httpMethod: "PATCH",
        body,
      })
      .pipe(Effect.flatMap(decodeWith(operation, AzureDevOpsPullRequestSchema)));

  const updatePullRequestCli = (cwd: string, pullRequestId: number, args: ReadonlyArray<string>) =>
    executeJson(cwd, "updateChangeRequest", [
      "repos",
      "pr",
      "update",
      "--detect",
      "true",
      "--id",
      String(pullRequestId),
      ...args,
    ]);

  const deleteSourceBranch = (cwd: string, scope: Scope, pullRequest: AzureDevOpsPullRequest) =>
    Effect.gen(function* () {
      const operation = "deleteSourceBranch";
      const head = headOf(pullRequest);
      if (!head) return yield* cliError(operation, "The head branch's commit is unknown.");
      // `oldObjectId` makes the delete conditional: a branch that moved is left alone.
      const results = yield* azure
        .invoke({
          cwd,
          operation,
          area: "git",
          resource: "refs",
          routeParameters: { project: scope.project, repositoryId: scope.repositoryId },
          httpMethod: "POST",
          body: [
            { name: pullRequest.sourceRefName, oldObjectId: head, newObjectId: ZERO_OBJECT_ID },
          ],
        })
        .pipe(Effect.flatMap(decodeWith(operation, RefUpdateCollection)));
      const result = results.value[0];
      if (result?.success !== true) {
        return yield* cliError(
          operation,
          result?.customMessage?.trim() ||
            `Could not delete ${stripHeads(pullRequest.sourceRefName)} (${result?.updateStatus ?? "unknown status"}).`,
        );
      }
    });

  const updatePullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly action: ChangeRequestUpdateAction;
  }) =>
    Effect.gen(function* () {
      const operation = "updateChangeRequest";
      const action = input.action;
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf(operation, pullRequest);
      const id = scope.pullRequestId;
      switch (action.kind) {
        case "edit": {
          if (
            action.body !== undefined &&
            action.body.length > AZURE_DEVOPS_DESCRIPTION_MAX_CHARS
          ) {
            return yield* cliError(
              operation,
              `Azure DevOps descriptions are limited to ${AZURE_DEVOPS_DESCRIPTION_MAX_CHARS} characters.`,
            );
          }
          if (action.title !== undefined || action.body !== undefined) {
            const titleArgs = action.title !== undefined ? ["--title", action.title] : [];
            if (action.body !== undefined) {
              yield* azure.executeWithFile({
                cwd: input.cwd,
                operation,
                contents: action.body,
                suffix: ".md",
                args: (file) => [
                  "repos",
                  "pr",
                  "update",
                  "--detect",
                  "true",
                  "--id",
                  String(id),
                  ...titleArgs,
                  "--description",
                  `@${file}`,
                ],
              });
            } else {
              yield* updatePullRequestCli(input.cwd, id, titleArgs);
            }
          }
          if (action.baseRefName !== undefined) {
            yield* patchPullRequest(input.cwd, operation, scope, {
              targetRefName: `refs/heads/${stripHeads(action.baseRefName)}`,
            });
          }
          return;
        }
        case "set-draft":
          yield* updatePullRequestCli(input.cwd, id, ["--draft", action.draft ? "true" : "false"]);
          return;
        case "close":
          yield* updatePullRequestCli(input.cwd, id, ["--status", "abandoned"]);
          if (action.deleteBranch === true) {
            yield* deleteSourceBranch(input.cwd, scope, pullRequest);
          }
          return;
        case "reopen":
          yield* updatePullRequestCli(input.cwd, id, ["--status", "active"]);
          return;
        case "reviewers":
          for (const [verb, reviewers] of [
            ["add", action.add],
            ["remove", action.remove],
          ] as const) {
            if (reviewers.length === 0) continue;
            yield* executeJson(input.cwd, operation, [
              "repos",
              "pr",
              "reviewer",
              verb,
              "--detect",
              "true",
              "--id",
              String(id),
              "--reviewers",
              ...reviewers,
            ]);
          }
          return;
        case "labels":
          for (const name of action.add) {
            yield* azure.invoke({
              cwd: input.cwd,
              operation,
              area: "git",
              resource: "pullRequestLabels",
              routeParameters: route(scope),
              httpMethod: "POST",
              body: { name },
            });
          }
          for (const name of action.remove) {
            yield* azure.invoke({
              cwd: input.cwd,
              operation,
              area: "git",
              resource: "pullRequestLabels",
              routeParameters: route(scope, { labelIdOrName: name }),
              httpMethod: "DELETE",
            });
          }
          return;
        case "auto-merge": {
          if (!action.enabled) {
            yield* updatePullRequestCli(input.cwd, id, ["--auto-complete", "false"]);
            return;
          }
          if (action.expectedHeadSha) {
            yield* verifyHead(operation, pullRequest, action.expectedHeadSha);
          }
          const viewer = yield* resolveViewer(input.cwd);
          if (!viewer) {
            return yield* cliError(operation, "Could not resolve your Azure DevOps identity.");
          }
          const deleteSourceBranchOption = pullRequest.completionOptions?.deleteSourceBranch;
          yield* patchPullRequest(input.cwd, operation, scope, {
            autoCompleteSetBy: { id: viewer.id },
            completionOptions: {
              mergeStrategy: azureDevOpsMergeStrategy(action.mergeMethod ?? "merge"),
              ...(deleteSourceBranchOption === true || deleteSourceBranchOption === "true"
                ? { deleteSourceBranch: true }
                : {}),
            },
          });
          return;
        }
        case "delete-branch":
          yield* deleteSourceBranch(input.cwd, scope, pullRequest);
          return;
        case "assignees":
        case "update-branch":
          return yield* cliError(
            operation,
            action.kind === "assignees"
              ? "Azure DevOps pull requests have no assignees."
              : "Azure DevOps cannot update a branch from its base.",
          );
      }
    });

  const merge = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly mergeMethod: SourceControlChangeRequestMergeMethod;
    readonly deleteBranch?: boolean | undefined;
    readonly expectedHeadSha?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const operation = "mergeChangeRequest";
      const pullRequest = yield* readPullRequest(input.cwd, input.reference);
      const scope = yield* scopeOf(operation, pullRequest);
      if (pullRequest.status.trim().toLowerCase() !== "active") {
        return yield* cliError(operation, "Only active pull requests can be completed.");
      }
      if (input.expectedHeadSha) yield* verifyHead(operation, pullRequest, input.expectedHeadSha);
      const head = input.expectedHeadSha?.trim() ?? headOf(pullRequest);
      if (!head) {
        return yield* cliError(
          operation,
          "Azure DevOps has not prepared this pull request's merge yet. Try again shortly.",
        );
      }
      // `lastMergeSourceCommit` is the host-side precondition: completion fails if the head moved.
      const completed = yield* patchPullRequest(input.cwd, operation, scope, {
        status: "completed",
        lastMergeSourceCommit: { commitId: head },
        completionOptions: {
          mergeStrategy: azureDevOpsMergeStrategy(input.mergeMethod),
          deleteSourceBranch: input.deleteBranch === true,
        },
      });
      return {
        outcome: completed.status.trim().toLowerCase() === "completed" ? "merged" : "enqueued",
      } satisfies SourceControlMergeChangeRequestResult;
    });

  // ── Pickers ────────────────────────────────────────────────────────

  const readRepositoryProject = (cwd: string, operation: string) =>
    executeJson(cwd, operation, ["repos", "show", "--detect", "true"]).pipe(
      Effect.flatMap(decodeWith(operation, RepositorySchema)),
      Effect.flatMap((repository) => {
        const project = repository.project?.id?.trim() || repository.project?.name?.trim();
        return project
          ? Effect.succeed(project)
          : Effect.fail(
              cliError(operation, "Azure DevOps did not report the repository's project."),
            );
      }),
    );

  /** Members of the project's default team: the reviewer picker's candidates. */
  const listAssignees = (input: { readonly cwd: string }) =>
    Effect.gen(function* () {
      const operation = "listAssignees";
      const project = yield* readRepositoryProject(input.cwd, operation);
      const projectInfo = yield* executeJson(input.cwd, operation, [
        "devops",
        "project",
        "show",
        "--detect",
        "true",
        "--project",
        project,
      ]).pipe(Effect.flatMap(decodeWith(operation, ProjectSchema)));
      const team = projectInfo.defaultTeam?.id;
      if (!team) return [] as ReadonlyArray<SourceControlAssigneeCandidate>;
      const members = yield* executeJson(input.cwd, operation, [
        "devops",
        "team",
        "list-member",
        "--detect",
        "true",
        "--project",
        project,
        "--team",
        team,
        "--top",
        "500",
      ]).pipe(Effect.flatMap(decodeWith(operation, TeamMemberList)));
      return members.flatMap((member) => {
        const login = azureDevOpsIdentityLogin(member.identity);
        if (!login || member.identity.isContainer === true) return [];
        const displayName = member.identity.displayName?.trim();
        const avatarUrl = member.identity.imageUrl?.trim();
        return [
          {
            login,
            ...(displayName && displayName !== login ? { displayName } : {}),
            ...(avatarUrl ? { avatarUrl } : {}),
          } satisfies SourceControlAssigneeCandidate,
        ];
      });
    });

  /** Active project tags (pull request labels share the project's tag definitions). */
  const listLabels = (input: { readonly cwd: string }) =>
    Effect.gen(function* () {
      const operation = "listLabels";
      const project = yield* readRepositoryProject(input.cwd, operation);
      const tags = yield* azure
        .invoke({
          cwd: input.cwd,
          operation,
          area: "wit",
          resource: "tags",
          routeParameters: { project },
        })
        .pipe(Effect.flatMap(decodeWith(operation, TagCollection)));
      return tags.value
        .filter((tag) => tag.active !== false && tag.name.trim().length > 0)
        .map((tag) => ({ name: tag.name.trim() }) satisfies SourceControlLabel);
    });

  return {
    getDetail,
    getActivity,
    getDiff,
    getFileContents,
    listChangeRequests,
    addComment,
    replyToThread,
    setThreadResolved,
    updateComment,
    submitReview,
    updatePullRequest,
    merge,
    listAssignees,
    listLabels,
  };
}

/** Repository-relative path Ryco may read from git (no option or traversal injection). */
function isRepositoryPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\u0000")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function toDetail(input: {
  readonly pullRequest: AzureDevOpsPullRequest;
  readonly threads: ReadonlyArray<AzureDevOpsThread>;
  readonly commits: ReadonlyArray<AzureDevOpsCommitRef>;
  readonly evaluations: ReadonlyArray<AzureDevOpsPolicyEvaluation> | null;
}): AzureDevOpsPullRequestDetail {
  const pullRequest = input.pullRequest;
  const record = normalizeAzureDevOpsPullRequestRecord(pullRequest);
  const reviewers = pullRequest.reviewers ?? [];
  const closedAt =
    pullRequest.closedDate && pullRequest.closedDate._tag === "Some"
      ? pullRequest.closedDate.value
      : null;
  const merged = record.state === "merged";
  const mergedBy = merged ? azureDevOpsIdentityLogin(pullRequest.closedBy) : null;
  const mergeStateStatus = azureDevOpsMergeStateStatus({
    pullRequest,
    evaluations: input.evaluations,
  });
  const reviewerStates = azureDevOpsReviewerStates(reviewers);
  return {
    ...record,
    body: pullRequest.description ?? "",
    comments: flattenAzureDevOpsThreadComments(input.threads),
    commits: input.commits
      .map(toAzureDevOpsChangeRequestCommit)
      // The REST list is newest first; the page reads commits oldest first.
      .toReversed(),
    reviewers: reviewerStates.map((reviewer) => reviewer.login),
    reviewerStates,
    reviewDecision:
      record.state === "open"
        ? azureDevOpsReviewDecision({ reviewers, evaluations: input.evaluations })
        : null,
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    ...(record.state === "open"
      ? { mergeCapabilities: azureDevOpsMergeCapabilities(input.evaluations) }
      : {}),
    autoMerge: record.state === "open" ? azureDevOpsAutoMerge(pullRequest) : null,
    ...(closedAt && record.state === "closed" ? { closedAt } : {}),
    ...(closedAt && merged ? { mergedAt: closedAt, closedAt } : {}),
    ...(mergedBy ? { mergedBy } : {}),
  };
}
