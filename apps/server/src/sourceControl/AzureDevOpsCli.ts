import { Context, Effect, FileSystem, Layer, Result, Schema, SchemaIssue } from "effect";
import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsPullRequests from "./azureDevOpsPullRequests.ts";
import * as AzureDevOpsWorkItems from "./azureDevOpsWorkItems.ts";
import type {
  NormalizedAzureDevOpsWorkItemDetail,
  NormalizedAzureDevOpsWorkItemRecord,
} from "./azureDevOpsWorkItems.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;
/** Background git must never prompt for credentials. */
const GIT_ENV = Object.freeze({
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

export class AzureDevOpsCliError extends Schema.TaggedError<AzureDevOpsCliError>()(
  "AzureDevOpsCliError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export interface AzureDevOpsRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface AzureDevOpsCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, AzureDevOpsCliError>;

  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
    /** `--creator`: `me` resolves to the signed-in identity. */
    readonly creator?: string;
    /** `--reviewer`: `me` resolves to the signed-in identity. */
    readonly reviewer?: string;
  }) => Effect.Effect<
    ReadonlyArray<AzureDevOpsPullRequests.NormalizedAzureDevOpsPullRequestRecord>,
    AzureDevOpsCliError
  >;

  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<
    AzureDevOpsPullRequests.NormalizedAzureDevOpsPullRequestRecord,
    AzureDevOpsCliError
  >;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsCliError>;

  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsCliError>;

  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly target?: SourceControlProvider.SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
    readonly draft?: boolean;
  }) => Effect.Effect<void, AzureDevOpsCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, AzureDevOpsCliError>;

  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly remoteName?: string;
  }) => Effect.Effect<void, AzureDevOpsCliError>;

  readonly listWorkItems: (input: {
    readonly cwd: string;
    readonly state: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedAzureDevOpsWorkItemRecord>, AzureDevOpsCliError>;

  readonly getWorkItem: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<NormalizedAzureDevOpsWorkItemDetail, AzureDevOpsCliError>;

  readonly searchWorkItems: (input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedAzureDevOpsWorkItemRecord>, AzureDevOpsCliError>;

  readonly searchPullRequests: (input: {
    readonly cwd: string;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<AzureDevOpsPullRequests.NormalizedAzureDevOpsPullRequestRecord>,
    AzureDevOpsCliError
  >;

  /** The full `GitPullRequest` (`az repos pr show`): repository scope, reviewers, merge state. */
  readonly getRawPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<AzureDevOpsPullRequests.AzureDevOpsPullRequest, AzureDevOpsCliError>;

  /**
   * One REST call through `az devops invoke` (endpoints without an `az repos`
   * command). A body is staged in a temp JSON file for `--in-file`, never
   * passed on argv. Resolves to the raw JSON stdout.
   */
  readonly invoke: (input: AzureDevOpsInvokeInput) => Effect.Effect<string, AzureDevOpsCliError>;

  /**
   * Run a JSON-output `az` command whose argv references a temp file holding
   * `contents` (for example `--description @file`), removed afterwards.
   * Resolves to the trimmed stdout.
   */
  readonly executeWithFile: (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly contents: string;
    readonly suffix: ".json" | ".md";
    readonly args: (file: string) => ReadonlyArray<string>;
  }) => Effect.Effect<string, AzureDevOpsCliError>;

  /** Local `git` in the repository checkout (diffs and file contents have no REST hunk API). */
  readonly runGit: (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly allowNonZeroExit?: boolean;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcess.VcsProcessOutput, AzureDevOpsCliError>;
}

export interface AzureDevOpsInvokeInput {
  readonly cwd: string;
  readonly operation: string;
  readonly area: string;
  readonly resource: string;
  readonly routeParameters: Readonly<Record<string, string | number>>;
  readonly queryParameters?: Readonly<Record<string, string | number | boolean>>;
  readonly httpMethod?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: unknown;
  /** Defaults to `7.1`; `az devops invoke` cannot parse `-preview.N` suffixes (use `-preview`). */
  readonly apiVersion?: string;
  readonly timeoutMs?: number;
}

export class AzureDevOpsCli extends Context.Service<AzureDevOpsCli, AzureDevOpsCliShape>()(
  "ryco/source-control/AzureDevOpsCli",
) {}

function errorText(error: VcsError | unknown): string {
  if (typeof error === "object" && error !== null) {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "";
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return [tag, detail, message].filter(Boolean).join("\n");
  }

  return String(error);
}

function normalizeAzureDevOpsCliError(
  operation: "execute",
  error: VcsError | unknown,
): AzureDevOpsCliError {
  const text = errorText(error);
  const lower = text.toLowerCase();

  if (lower.includes("command not found: az") || lower.includes("enoent")) {
    return new AzureDevOpsCliError({
      operation,
      detail:
        "Azure CLI (`az`) with the Azure DevOps extension is required but not available on PATH.",
      cause: error,
    });
  }

  if (
    lower.includes("az devops login") ||
    lower.includes("please run az login") ||
    lower.includes("not logged in") ||
    lower.includes("authentication failed") ||
    lower.includes("unauthorized")
  ) {
    return new AzureDevOpsCliError({
      operation,
      detail: "Azure DevOps CLI is not authenticated. Run `az devops login` and retry.",
      cause: error,
    });
  }

  if (
    lower.includes("pull request") &&
    (lower.includes("not found") || lower.includes("does not exist"))
  ) {
    return new AzureDevOpsCliError({
      operation,
      detail: "Pull request not found. Check the PR number or URL and try again.",
      cause: error,
    });
  }

  return new AzureDevOpsCliError({
    operation,
    detail: text,
    cause: error,
  });
}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pullrequest|pull-request|pull|_pulls?)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function normalizeWorkItemId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:_workitems\/edit|workItems)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function toAzureStatus(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "active";
    case "closed":
      return "abandoned";
    case "merged":
      return "completed";
    case "all":
      return "all";
  }
}

const RawAzureDevOpsRepositorySchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  webUrl: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  project: Schema.optional(
    Schema.Struct({
      name: TrimmedNonEmptyString,
    }),
  ),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
});

function normalizeDefaultBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^refs\/heads\//, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawAzureDevOpsRepositorySchema>,
): AzureDevOpsRepositoryCloneUrls {
  const projectName = raw.project?.name.trim();
  return {
    nameWithOwner: projectName ? `${projectName}/${raw.name}` : raw.name,
    url: raw.remoteUrl,
    sshUrl: raw.sshUrl,
  };
}

function parseRepositorySpecifier(repository: string): {
  readonly project: string | null;
  readonly name: string;
} {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return {
    project: parts.length > 1 ? (parts.at(-2) ?? null) : null,
    name: parts.at(-1) ?? repository.trim(),
  };
}

function decodeAzureDevOpsJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "getRepositoryCloneUrls" | "getDefaultBranch" | "createRepository",
  invalidDetail: string,
): Effect.Effect<S["Type"], AzureDevOpsCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new AzureDevOpsCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

/** argv for `az devops invoke` (JSON output flags are appended by the caller). */
export function buildAzureDevOpsInvokeArgs(
  input: AzureDevOpsInvokeInput,
  bodyFile: string | null,
): ReadonlyArray<string> {
  const pairs = (values: Readonly<Record<string, string | number | boolean>>) =>
    Object.entries(values).map(([key, value]) => `${key}=${String(value)}`);
  const query = input.queryParameters ? pairs(input.queryParameters) : [];
  return [
    "devops",
    "invoke",
    "--detect",
    "true",
    "--area",
    input.area,
    "--resource",
    input.resource,
    ...(Object.keys(input.routeParameters).length > 0
      ? ["--route-parameters", ...pairs(input.routeParameters)]
      : []),
    ...(query.length > 0 ? ["--query-parameters", ...query] : []),
    "--http-method",
    input.httpMethod ?? "GET",
    "--api-version",
    input.apiVersion ?? "7.1",
    ...(bodyFile ? ["--in-file", bodyFile] : []),
  ];
}

export const make = Effect.fn("makeAzureDevOpsCli")(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;

  const execute: AzureDevOpsCliShape["execute"] = (input) =>
    process
      .run({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { LC_ALL: "C" },
      })
      .pipe(Effect.mapError((error) => normalizeAzureDevOpsCliError("execute", error)));

  const executeJson = (input: Parameters<AzureDevOpsCliShape["execute"]>[0]) =>
    execute({
      ...input,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  const runJson = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number | undefined;
  }) =>
    executeJson({
      cwd: input.cwd,
      args: input.args,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.mapError(
        (error) =>
          new AzureDevOpsCliError({
            operation: input.operation,
            detail: error.detail,
            cause: error,
          }),
      ),
    );

  const executeWithFile: AzureDevOpsCliShape["executeWithFile"] = (input) =>
    Effect.acquireUseRelease(
      fileSystem.makeTempFile({ prefix: "ryco-az-body-", suffix: input.suffix }).pipe(
        Effect.tap((file) => fileSystem.writeFileString(file, input.contents)),
        Effect.mapError(
          (cause) =>
            new AzureDevOpsCliError({
              operation: input.operation,
              detail: "Failed to stage the request body in a temp file.",
              cause,
            }),
        ),
      ),
      (file) => runJson({ cwd: input.cwd, operation: input.operation, args: input.args(file) }),
      (file) => fileSystem.remove(file).pipe(Effect.ignore),
    );

  const invoke: AzureDevOpsCliShape["invoke"] = (input) =>
    input.body === undefined
      ? runJson({
          cwd: input.cwd,
          operation: input.operation,
          args: buildAzureDevOpsInvokeArgs(input, null),
          timeoutMs: input.timeoutMs,
        })
      : executeWithFile({
          cwd: input.cwd,
          operation: input.operation,
          contents: JSON.stringify(input.body),
          suffix: ".json",
          args: (file) => buildAzureDevOpsInvokeArgs(input, file),
        });

  return AzureDevOpsCli.of({
    execute,
    listPullRequests: (input) => {
      const sourceBranch = SourceControlProvider.sourceBranch(input);
      return executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          ...(sourceBranch.length > 0 ? ["--source-branch", sourceBranch] : []),
          ...(input.creator ? ["--creator", input.creator] : []),
          ...(input.reviewer ? ["--reviewer", input.reviewer] : []),
          "--status",
          toAzureStatus(input.state),
          "--top",
          String(input.limit ?? 20),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() =>
                AzureDevOpsPullRequests.decodeAzureDevOpsPullRequestListJson(raw),
              ).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new AzureDevOpsCliError({
                        operation: "listPullRequests",
                        detail: `Azure DevOps CLI returned invalid PR list JSON: ${AzureDevOpsPullRequests.formatAzureDevOpsJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success);
                }),
              ),
        ),
      );
    },
    getPullRequest: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          normalizeChangeRequestId(input.reference),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => AzureDevOpsPullRequests.decodeAzureDevOpsPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new AzureDevOpsCliError({
                    operation: "getPullRequest",
                    detail: `Azure DevOps CLI returned invalid pull request JSON: ${AzureDevOpsPullRequests.formatAzureDevOpsJsonDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(decoded.success);
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "show", "--detect", "true", "--repository", input.repository],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(
            raw,
            RawAzureDevOpsRepositorySchema,
            "getRepositoryCloneUrls",
            "Azure DevOps CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) => {
      const repository = parseRepositorySpecifier(input.repository);
      // Azure Repos access is governed by project/organization permissions.
      // `az repos create` does not expose a per-repository visibility flag, so
      // the generic source-control visibility input is intentionally not
      // translated into CLI args for this provider.
      return executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "create",
          "--detect",
          "true",
          "--name",
          repository.name,
          ...(repository.project ? ["--project", repository.project] : []),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(
            raw,
            RawAzureDevOpsRepositorySchema,
            "createRepository",
            "Azure DevOps CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      );
    },
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "create",
          "--only-show-errors",
          "--detect",
          "true",
          "--target-branch",
          input.target?.refName ?? input.baseBranch,
          "--source-branch",
          SourceControlProvider.sourceBranch(input),
          "--title",
          input.title,
          "--description",
          `@${input.bodyFile}`,
          ...(input.draft ? ["--draft", "true"] : []),
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "show", "--detect", "true"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(
            raw,
            RawAzureDevOpsRepositorySchema,
            "getDefaultBranch",
            "Azure DevOps CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "checkout",
          "--only-show-errors",
          "--detect",
          "true",
          "--id",
          normalizeChangeRequestId(input.reference),
          "--remote-name",
          input.remoteName ?? "origin",
        ],
      }).pipe(Effect.asVoid),
    listWorkItems: (input) => {
      const stateClause =
        input.state === "open"
          ? " AND [System.State] NOT IN ('Closed', 'Resolved', 'Done', 'Completed', 'Removed', 'Cancelled', 'Rejected')"
          : input.state === "closed"
            ? " AND [System.State] IN ('Closed', 'Resolved', 'Done', 'Completed', 'Removed', 'Cancelled', 'Rejected')"
            : "";
      const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.Tags], [System.ChangedDate], [System.CreatedBy] FROM workItems WHERE [System.TeamProject] = @project${stateClause} ORDER BY [System.ChangedDate] DESC`;
      return executeJson({
        cwd: input.cwd,
        args: ["boards", "query", "--wiql", wiql, "--top", String(input.limit ?? 50)],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => AzureDevOpsWorkItems.decodeAzureDevOpsWorkItemListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new AzureDevOpsCliError({
                          operation: "listWorkItems",
                          detail: `Azure DevOps CLI returned invalid work item JSON: ${AzureDevOpsWorkItems.formatAzureDevOpsWorkItemDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      );
    },
    getWorkItem: (input) => {
      const id = normalizeWorkItemId(input.reference);
      return executeJson({
        cwd: input.cwd,
        args: ["boards", "work-item", "show", "--id", id],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => AzureDevOpsWorkItems.decodeAzureDevOpsWorkItemDetailJson(raw)).pipe(
            Effect.flatMap((decoded) =>
              Result.isSuccess(decoded)
                ? Effect.succeed(decoded.success)
                : Effect.fail(
                    new AzureDevOpsCliError({
                      operation: "getWorkItem",
                      detail: `Azure DevOps CLI returned invalid work item JSON: ${AzureDevOpsWorkItems.formatAzureDevOpsWorkItemDecodeError(decoded.failure)}`,
                      cause: decoded.failure,
                    }),
                  ),
            ),
          ),
        ),
      );
    },
    searchWorkItems: (input) => {
      const escapedQuery = input.query.replace(/'/g, "''");
      const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.Tags], [System.ChangedDate], [System.CreatedBy] FROM workItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS '${escapedQuery}' ORDER BY [System.ChangedDate] DESC`;
      return executeJson({
        cwd: input.cwd,
        args: ["boards", "query", "--wiql", wiql, "--top", String(input.limit ?? 20)],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => AzureDevOpsWorkItems.decodeAzureDevOpsWorkItemListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new AzureDevOpsCliError({
                          operation: "searchWorkItems",
                          detail: `Azure DevOps CLI returned invalid work item JSON: ${AzureDevOpsWorkItems.formatAzureDevOpsWorkItemDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      );
    },
    searchPullRequests: (input) => {
      const escaped = input.query.replace(/'/g, "\\'");
      const jmes = `[?contains(title, '${escaped}')] | [0:${input.limit ?? 20}]`;
      return executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--status",
          "all",
          "--top",
          String((input.limit ?? 20) * 4),
          "--query",
          jmes,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() =>
                AzureDevOpsPullRequests.decodeAzureDevOpsPullRequestListJson(raw),
              ).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new AzureDevOpsCliError({
                          operation: "searchPullRequests",
                          detail: `Azure DevOps CLI returned invalid PR list JSON: ${AzureDevOpsPullRequests.formatAzureDevOpsJsonDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      );
    },
    getRawPullRequest: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          normalizeChangeRequestId(input.reference),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => AzureDevOpsPullRequests.decodeAzureDevOpsRawPullRequestJson(raw)),
        ),
        Effect.flatMap((decoded) =>
          Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new AzureDevOpsCliError({
                  operation: "getRawPullRequest",
                  detail: `Azure DevOps CLI returned invalid pull request JSON: ${AzureDevOpsPullRequests.formatAzureDevOpsJsonDecodeError(decoded.failure)}`,
                  cause: decoded.failure,
                }),
              ),
        ),
      ),
    invoke,
    executeWithFile,
    runGit: (input) =>
      process
        .run({
          operation: `AzureDevOpsCli.git.${input.operation}`,
          command: "git",
          args: input.args,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? GIT_TIMEOUT_MS,
          ...(input.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
          ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
          env: GIT_ENV,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new AzureDevOpsCliError({
                operation: input.operation,
                detail: errorText(error) || "git failed.",
                cause: error,
              }),
          ),
        ),
  });
});

export const layer = Layer.effect(AzureDevOpsCli, make());
