import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  SchemaIssue,
  type DateTime,
} from "effect";

import {
  TrimmedNonEmptyString,
  type SourceControlChangeRequestMergeability,
  type SourceControlChangeRequestMergeStateStatus,
  type SourceControlLabel,
  type SourceControlRepositoryVisibility,
} from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  buildGlabApiInvocation,
  describeGitLabApiFailure,
  parseGitLabApiFailure,
  type GitLabApiRequest,
} from "./gitLabApi.ts";
import * as GitLabIssues from "./gitLabIssues.ts";
import type { NormalizedGitLabIssueDetail, NormalizedGitLabIssueRecord } from "./gitLabIssues.ts";
import * as GitLabMergeRequests from "./gitLabMergeRequests.ts";
import type { NormalizedGitLabMergeRequestDetail } from "./gitLabMergeRequests.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export class GitLabCliError extends Schema.TaggedError<GitLabCliError>()("GitLabCliError", {
  operation: Schema.String,
  detail: Schema.String,
  /** HTTP status of a failed `glab api` call, when the request reached GitLab. */
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export interface GitLabMergeRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly updatedAt?: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly isDraft?: boolean;
  readonly author?: string;
  readonly assignees?: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<SourceControlLabel>;
  readonly commentsCount?: number;
  readonly headSha?: string;
  readonly mergeability?: SourceControlChangeRequestMergeability;
  readonly mergeStateStatus?: SourceControlChangeRequestMergeStateStatus;
  readonly reviewDecision?: "review_required" | "changes_requested";
  readonly createdAt?: DateTime.Utc;
}

export interface GitLabApiOutput {
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}

export interface GitLabRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface GitLabCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitLabCliError>;

  /**
   * One REST v4 call through `glab api`. JSON bodies go over stdin; a
   * non-2xx response fails with the HTTP status on the error.
   */
  readonly api: (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly request: GitLabApiRequest;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    /** Keep the first `maxOutputBytes` instead of failing on larger output. */
    readonly truncateOutputAtMaxBytes?: boolean;
    /** Keep the last `maxOutputBytes` instead (logs); `stdoutTruncated` reports the cut. */
    readonly keepOutputTail?: boolean;
  }) => Effect.Effect<GitLabApiOutput, GitLabCliError>;

  readonly listMergeRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitLabMergeRequestSummary>, GitLabCliError>;

  readonly getMergeRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<GitLabMergeRequestSummary, GitLabCliError>;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;

  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;

  readonly createMergeRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly target?: SourceControlProvider.SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
    /** GitLab marks drafts by title (`Draft: …`); the create API has no draft field. */
    readonly draft?: boolean;
  }) => Effect.Effect<void, GitLabCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitLabCliError>;

  readonly checkoutMergeRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitLabCliError>;

  readonly listIssues: (input: {
    readonly cwd: string;
    readonly state: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedGitLabIssueRecord>, GitLabCliError>;

  readonly getIssue: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<NormalizedGitLabIssueDetail, GitLabCliError>;

  readonly searchIssues: (input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedGitLabIssueRecord>, GitLabCliError>;

  readonly searchMergeRequests: (input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitLabMergeRequestSummary>, GitLabCliError>;

  readonly getMergeRequestDetail: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<NormalizedGitLabMergeRequestDetail, GitLabCliError>;
}

export class GitLabCli extends Context.Service<GitLabCli, GitLabCliShape>()(
  "ryco/source-control/GitLabCli",
) {}

function isVcsProcessSpawnError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "VcsProcessSpawnError"
  );
}

function normalizeGitLabCliError(operation: "execute" | "stdout", error: unknown): GitLabCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: glab") || isVcsProcessSpawnError(error)) {
      return new GitLabCliError({
        operation,
        detail: "GitLab CLI (`glab`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("glab auth login") ||
      lower.includes("token")
    ) {
      return new GitLabCliError({
        operation,
        detail: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("merge request not found") ||
      lower.includes("not found") ||
      lower.includes("404")
    ) {
      return new GitLabCliError({
        operation,
        detail: "Merge request not found. Check the MR number or URL and try again.",
        cause: error,
      });
    }

    return new GitLabCliError({
      operation,
      detail: `GitLab CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitLabCliError({
    operation,
    detail: "GitLab CLI command failed.",
    cause: error,
  });
}

const RawGitLabRepositoryCloneUrlsSchema = Schema.Struct({
  path_with_namespace: TrimmedNonEmptyString,
  web_url: TrimmedNonEmptyString,
  http_url_to_repo: TrimmedNonEmptyString,
  ssh_url_to_repo: TrimmedNonEmptyString,
});

const RawGitLabDefaultBranchSchema = Schema.Struct({
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const RawGitLabNamespaceSchema = Schema.Struct({
  id: Schema.Number,
});

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitLabRepositoryCloneUrlsSchema>,
): GitLabRepositoryCloneUrls {
  return {
    nameWithOwner: raw.path_with_namespace,
    url: raw.web_url,
    sshUrl: raw.ssh_url_to_repo,
  };
}

function decodeGitLabJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "getRepositoryCloneUrls" | "getDefaultBranch" | "createRepository",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitLabCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitLabCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

function runAndDecode<T>(input: {
  readonly operation: string;
  readonly exec: Effect.Effect<VcsProcess.VcsProcessOutput, GitLabCliError>;
  readonly decode: (raw: string) => Result.Result<T, Cause.Cause<Schema.SchemaError>>;
  readonly formatError: (cause: Cause.Cause<Schema.SchemaError>) => string;
  readonly emptyValue?: T;
  readonly invalidDetail: string;
}): Effect.Effect<T, GitLabCliError> {
  return input.exec.pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.flatMap((raw) => {
      if (raw.length === 0 && input.emptyValue !== undefined) {
        return Effect.succeed(input.emptyValue);
      }
      const decoded = input.decode(raw);
      return Result.isSuccess(decoded)
        ? Effect.succeed(decoded.success)
        : Effect.fail(
            new GitLabCliError({
              operation: input.operation,
              detail: `${input.invalidDetail}: ${input.formatError(decoded.failure)}`,
              cause: decoded.failure,
            }),
          );
    }),
  );
}

function stateArgs(state: "open" | "closed" | "merged" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return [];
    case "closed":
      return ["--closed"];
    case "merged":
      return ["--merged"];
    case "all":
      return ["--all"];
  }
}

function normalizeHeadSelector(headSelector: string): string {
  const trimmed = headSelector.trim();
  const ownerBranch = /^[^:]+:(.+)$/.exec(trimmed);
  return ownerBranch?.[1]?.trim() || trimmed;
}

function sourceRefName(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeHeadSelector(input.headSelector);
}

function sourceProjectIdentifier(
  source: SourceControlProvider.SourceControlRefSelector | undefined,
): string | null {
  return source?.repository ?? source?.owner ?? null;
}

function toSummaryWithOptionalUpdatedAt(
  record: GitLabMergeRequestSummary & {
    readonly updatedAt: Option.Option<DateTime.Utc>;
  },
): GitLabMergeRequestSummary {
  const { updatedAt, ...summary } = record;
  return Option.isSome(updatedAt) ? { ...summary, updatedAt } : summary;
}

function parseRepositoryPath(repository: string): {
  readonly namespacePath: string | null;
  readonly projectPath: string;
} {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const projectPath = parts.at(-1) ?? repository.trim();
  const namespacePath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
  return { namespacePath, projectPath };
}

export const make = Effect.fn("makeGitLabCli")(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitLabCliShape["execute"] = (input) =>
    process
      .run({
        operation: "GitLabCli.execute",
        command: "glab",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { LC_ALL: "C" },
      })
      .pipe(Effect.mapError((error) => normalizeGitLabCliError("execute", error)));

  const api: GitLabCliShape["api"] = (input) => {
    const invocation = buildGlabApiInvocation(input.request);
    return process
      .run({
        operation: "GitLabCli.api",
        command: "glab",
        args: invocation.args,
        cwd: input.cwd,
        ...(invocation.stdin !== undefined ? { stdin: invocation.stdin } : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        allowNonZeroExit: true,
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        ...(input.truncateOutputAtMaxBytes !== undefined
          ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
          : {}),
        ...(input.keepOutputTail !== undefined ? { keepOutputTail: input.keepOutputTail } : {}),
        env: { LC_ALL: "C" },
      })
      .pipe(
        Effect.mapError((error) => normalizeGitLabCliError("execute", error)),
        Effect.flatMap((output) => {
          if (output.exitCode === 0) {
            return Effect.succeed({
              stdout: output.stdout,
              stdoutTruncated: output.stdoutTruncated,
            });
          }
          const failure = parseGitLabApiFailure(output);
          return Effect.fail(
            new GitLabCliError({
              operation: input.operation,
              detail: describeGitLabApiFailure(failure),
              ...(failure.status !== null ? { status: failure.status } : {}),
            }),
          );
        }),
      );
  };

  return GitLabCli.of({
    execute,
    api,
    listMergeRequests: (input) => {
      const sourceBranch = sourceRefName(input);
      return runAndDecode({
        operation: "listMergeRequests",
        exec: execute({
          cwd: input.cwd,
          args: [
            "mr",
            "list",
            ...(sourceBranch.length > 0 ? ["--source-branch", sourceBranch] : []),
            ...stateArgs(input.state),
            "--per-page",
            String(input.limit ?? 20),
            "--output",
            "json",
          ],
        }),
        decode: GitLabMergeRequests.decodeGitLabMergeRequestListJson,
        formatError: GitLabMergeRequests.formatGitLabJsonDecodeError,
        emptyValue: [],
        invalidDetail: "GitLab CLI returned invalid MR list JSON",
      }).pipe(Effect.map((records) => records.map(toSummaryWithOptionalUpdatedAt)));
    },
    getMergeRequest: (input) =>
      runAndDecode({
        operation: "getMergeRequest",
        exec: execute({
          cwd: input.cwd,
          args: ["mr", "view", input.reference, "--output", "json"],
        }),
        decode: GitLabMergeRequests.decodeGitLabMergeRequestJson,
        formatError: GitLabMergeRequests.formatGitLabJsonDecodeError,
        invalidDetail: "GitLab CLI returned invalid merge request JSON",
      }).pipe(Effect.map(toSummaryWithOptionalUpdatedAt)),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", `projects/${encodeURIComponent(input.repository)}`],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabJson(
            raw,
            RawGitLabRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) => {
      const { namespacePath, projectPath } = parseRepositoryPath(input.repository);
      const namespaceId: Effect.Effect<number | null, GitLabCliError> = namespacePath
        ? execute({
            cwd: input.cwd,
            args: ["api", `namespaces/${encodeURIComponent(namespacePath)}`],
          }).pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.flatMap((raw) =>
              decodeGitLabJson(
                raw,
                RawGitLabNamespaceSchema,
                "createRepository",
                "GitLab CLI returned invalid namespace JSON.",
              ),
            ),
            Effect.map((namespace) => namespace.id),
          )
        : Effect.succeed(null);

      return namespaceId.pipe(
        Effect.flatMap((resolvedNamespaceId) =>
          execute({
            cwd: input.cwd,
            args: [
              "api",
              "--method",
              "POST",
              "projects",
              "--raw-field",
              `path=${projectPath}`,
              "--raw-field",
              `name=${projectPath}`,
              "--raw-field",
              `visibility=${input.visibility}`,
              ...(resolvedNamespaceId === null
                ? []
                : ["--raw-field", `namespace_id=${resolvedNamespaceId}`]),
            ],
          }),
        ),
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabJson(
            raw,
            RawGitLabRepositoryCloneUrlsSchema,
            "createRepository",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      );
    },
    createMergeRequest: (input) => {
      const sourceProject = sourceProjectIdentifier(input.source);
      return execute({
        cwd: input.cwd,
        args: [
          "api",
          "--method",
          "POST",
          "projects/:fullpath/merge_requests",
          "--raw-field",
          `source_branch=${sourceRefName(input)}`,
          "--raw-field",
          `target_branch=${input.target?.refName ?? input.baseBranch}`,
          ...(sourceProject ? ["--raw-field", `source_project_id=${sourceProject}`] : []),
          "--raw-field",
          `title=${input.draft === true ? GitLabMergeRequests.gitLabDraftTitle(input.title, true) : input.title}`,
          "--field",
          `description=@${input.bodyFile}`,
        ],
      }).pipe(Effect.asVoid);
    },
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", "projects/:fullpath"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabJson(
            raw,
            RawGitLabDefaultBranchSchema,
            "getDefaultBranch",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map((value) => value.default_branch ?? null),
      ),
    checkoutMergeRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["mr", "checkout", input.reference],
      }).pipe(Effect.asVoid),
    listIssues: (input) => {
      const stateFlags =
        input.state === "open" ? [] : input.state === "closed" ? ["--closed"] : ["--all"];
      return runAndDecode({
        operation: "listIssues",
        exec: execute({
          cwd: input.cwd,
          args: [
            "issue",
            "list",
            ...stateFlags,
            "--per-page",
            String(input.limit ?? 50),
            "--output",
            "json",
          ],
        }),
        decode: GitLabIssues.decodeGitLabIssueListJson,
        formatError: GitLabIssues.formatGitLabIssueDecodeError,
        emptyValue: [],
        invalidDetail: "GitLab CLI returned invalid issue list JSON",
      });
    },
    getIssue: (input) =>
      runAndDecode({
        operation: "getIssue",
        exec: execute({
          cwd: input.cwd,
          args: ["issue", "view", input.reference, "--comments", "--output", "json"],
        }),
        decode: GitLabIssues.decodeGitLabIssueDetailJson,
        formatError: GitLabIssues.formatGitLabIssueDecodeError,
        invalidDetail: "GitLab CLI returned invalid issue JSON",
      }),
    searchIssues: (input) =>
      runAndDecode({
        operation: "searchIssues",
        exec: execute({
          cwd: input.cwd,
          args: [
            "issue",
            "list",
            "--search",
            input.query,
            "--per-page",
            String(input.limit ?? 20),
            "--output",
            "json",
          ],
        }),
        decode: GitLabIssues.decodeGitLabIssueListJson,
        formatError: GitLabIssues.formatGitLabIssueDecodeError,
        emptyValue: [],
        invalidDetail: "GitLab CLI returned invalid issue list JSON",
      }),
    searchMergeRequests: (input) =>
      runAndDecode({
        operation: "searchMergeRequests",
        exec: execute({
          cwd: input.cwd,
          args: [
            "mr",
            "list",
            "--search",
            input.query,
            "--per-page",
            String(input.limit ?? 20),
            "--output",
            "json",
          ],
        }),
        decode: GitLabMergeRequests.decodeGitLabMergeRequestListJson,
        formatError: GitLabMergeRequests.formatGitLabJsonDecodeError,
        emptyValue: [],
        invalidDetail: "GitLab CLI returned invalid MR list JSON",
      }).pipe(Effect.map((records) => records.map(toSummaryWithOptionalUpdatedAt))),
    getMergeRequestDetail: (input) =>
      runAndDecode({
        operation: "getMergeRequestDetail",
        exec: execute({
          cwd: input.cwd,
          args: ["mr", "view", input.reference, "--comments", "--output", "json"],
        }),
        decode: GitLabMergeRequests.decodeGitLabMergeRequestDetailJson,
        formatError: GitLabMergeRequests.formatGitLabJsonDecodeError,
        invalidDetail: "GitLab CLI returned invalid merge request JSON",
      }),
  });
});

export const layer = Layer.effect(GitLabCli, make());
