import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Config, Context, Effect, FileSystem, Layer, Option, Result, Schema, Stream } from "effect";
import {
  TrimmedNonEmptyString,
  type ChangeRequestActivity,
  type ChangeRequestFileContents,
  type ChangeRequestFileContentsInput,
  type ChangeRequestInvolvement,
  type ChangeRequestReplyToThreadInput,
  type ChangeRequestReviewThread,
  type ChangeRequestSubmitReviewInput,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateAction,
  type ChangeRequestUpdateCommentInput,
  type ChangeRequestUpdateCommentResult,
  type SourceControlAddCommentReactionInput,
  type SourceControlAssigneeCandidate,
  type SourceControlLabel,
  type SourceControlMergeChangeRequestInput,
  type SourceControlMergeChangeRequestResult,
  type SourceControlProviderAuth,
  type SourceControlProviderInfo,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryVisibility,
} from "@ryco/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { sanitizeBranchFragment, WORKTREE_BRANCH_PREFIX } from "@ryco/shared/git";
import { detectSourceControlProviderFromRemoteUrl } from "@ryco/shared/sourceControl";
import { decodeJsonResult } from "@ryco/shared/schemaJson";

import { ForgejoApiError, forgejoErrorMessage, isForgejoApiError } from "./forgejoApiError.ts";
import * as ForgejoIssues from "./forgejoIssues.ts";
import { forgejoWorkInProgressTitle } from "./forgejoPullRequestMutations.ts";
import * as ForgejoPullRequests from "./forgejoPullRequests.ts";
import {
  forgejoPullRequestIndex,
  makeForgejoPullRequestPageApi,
  type ForgejoPageHttp,
  type ForgejoRequestSpec,
} from "./ForgejoPullRequestPageApi.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const DEFAULT_BASE_URL = "https://codeberg.org";
const DEFAULT_PAGE_LIMIT = 50;

const ForgejoApiEnvConfig = Config.all({
  baseUrl: Config.string("RYCO_FORGEJO_BASE_URL").pipe(Config.option),
  token: Config.string("RYCO_FORGEJO_TOKEN").pipe(Config.option),
  instances: Config.string("RYCO_FORGEJO_INSTANCES").pipe(Config.option),
  cliKeysFile: Config.string("RYCO_FORGEJO_CLI_KEYS_FILE").pipe(Config.option),
});

export { ForgejoApiError };

const ForgejoCurrentUserSchema = Schema.Struct({
  login: Schema.optional(TrimmedNonEmptyString),
  username: Schema.optional(TrimmedNonEmptyString),
  full_name: Schema.optional(Schema.String),
});

const ForgejoCliLoginSchema = Schema.Struct({
  type: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
  token: Schema.optional(TrimmedNonEmptyString),
});

const ForgejoCliKeysSchema = Schema.Struct({
  hosts: Schema.optional(Schema.Record(Schema.String, ForgejoCliLoginSchema)),
});

const decodeForgejoCliKeysJson = decodeJsonResult(ForgejoCliKeysSchema);

export interface ForgejoRepositoryLocator {
  readonly owner: string;
  readonly repo: string;
  readonly instance: ForgejoInstanceConfig;
}

interface ForgejoConfiguredInstanceInput {
  readonly baseUrl: string;
  readonly token?: string;
}

export interface ForgejoInstanceConfig {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly host: string;
  readonly token: Option.Option<string>;
}

interface ForgejoCliCredential {
  readonly host: string;
  readonly account: string;
  readonly token: string;
}

export interface ForgejoApiShape {
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
  readonly detectProviderFromRemoteUrl: (remoteUrl: string) => SourceControlProviderInfo | null;
  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<ForgejoPullRequests.NormalizedForgejoPullRequestRecord>,
    ForgejoApiError
  >;
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ForgejoPullRequests.NormalizedForgejoPullRequestRecord, ForgejoApiError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, ForgejoApiError>;
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly target?: SourceControlProvider.SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
    /** Open as a draft (Forgejo: a `WIP:` title prefix). */
    readonly draft?: boolean | undefined;
  }) => Effect.Effect<void, ForgejoApiError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<string | null, ForgejoApiError>;
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, ForgejoApiError>;
  readonly listIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly state: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ForgejoIssues.NormalizedForgejoIssueRecord>, ForgejoApiError>;
  readonly getIssue: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ForgejoIssues.NormalizedForgejoIssueDetail, ForgejoApiError>;
  readonly searchIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ForgejoIssues.NormalizedForgejoIssueRecord>, ForgejoApiError>;
  readonly searchPullRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<ForgejoPullRequests.NormalizedForgejoPullRequestRecord>,
    ForgejoApiError
  >;
  readonly getPullRequestDetail: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ForgejoPullRequests.NormalizedForgejoPullRequestDetail, ForgejoApiError>;
  readonly getPullRequestDiff: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
    /** Refuse when the head moved while the diff loaded. */
    readonly expectedHeadSha?: string | undefined;
    /** One commit of the pull request instead of the whole change. */
    readonly commitSha?: string | undefined;
  }) => Effect.Effect<string, ForgejoApiError>;
  /** Page lists: pull requests involving the authenticated user, with readiness. */
  readonly listInvolvedPullRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly involvement: ChangeRequestInvolvement;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<
    ReadonlyArray<ForgejoPullRequests.NormalizedForgejoPullRequestRecord>,
    ForgejoApiError
  >;
  readonly getPullRequestActivity: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ChangeRequestActivity, ForgejoApiError>;
  readonly getPullRequestFileContents: (
    input: ChangeRequestFileContentsInput & {
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    },
  ) => Effect.Effect<ChangeRequestFileContents, ForgejoApiError>;
  readonly addPullRequestComment: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
    readonly body: string;
    readonly clientMutationId?: string | undefined;
  }) => Effect.Effect<void, ForgejoApiError>;
  /** Add the viewer's reaction, or remove it when present. */
  readonly togglePullRequestCommentReaction: (
    input: SourceControlAddCommentReactionInput & {
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    },
  ) => Effect.Effect<void, ForgejoApiError>;
  readonly updatePullRequestComment: (
    input: ChangeRequestUpdateCommentInput & {
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    },
  ) => Effect.Effect<ChangeRequestUpdateCommentResult, ForgejoApiError>;
  readonly submitPullRequestReview: (
    input: ChangeRequestSubmitReviewInput & {
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    },
  ) => Effect.Effect<ChangeRequestSubmitReviewResult, ForgejoApiError>;
  readonly replyToPullRequestReviewThread: (
    input: ChangeRequestReplyToThreadInput & {
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    },
  ) => Effect.Effect<ChangeRequestReviewThread, ForgejoApiError>;
  readonly updatePullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
    readonly action: ChangeRequestUpdateAction;
  }) => Effect.Effect<void, ForgejoApiError>;
  readonly mergePullRequest: (
    input: SourceControlMergeChangeRequestInput & {
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlMergeChangeRequestResult, ForgejoApiError>;
  readonly listLabels: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<ReadonlyArray<SourceControlLabel>, ForgejoApiError>;
  readonly listAssignees: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<ReadonlyArray<SourceControlAssigneeCandidate>, ForgejoApiError>;
}

export class ForgejoApi extends Context.Service<ForgejoApi, ForgejoApiShape>()(
  "ryco/source-control/ForgejoApi",
) {}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

function hostFromBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).host.toLowerCase();
}

function apiBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/api/v1`;
}

function apiUrl(instance: ForgejoInstanceConfig, path: string): string {
  return `${instance.apiBaseUrl.replace(/\/+$/u, "")}${path}`;
}

function repositoryPath(repository: ForgejoRepositoryLocator): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

function toInstance(input: ForgejoConfiguredInstanceInput): ForgejoInstanceConfig | null {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiBaseUrl: apiBaseUrl(baseUrl),
    host: hostFromBaseUrl(baseUrl),
    token: nonEmpty(input.token),
  };
}

function configuredInstanceInputs(
  config: Config.Success<typeof ForgejoApiEnvConfig>,
): ReadonlyArray<ForgejoConfiguredInstanceInput> {
  const inputs: ForgejoConfiguredInstanceInput[] = [];
  if (Option.isSome(config.instances)) {
    try {
      const parsed = JSON.parse(config.instances.value) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as Record<string, unknown>;
          if (typeof record.baseUrl !== "string") continue;
          inputs.push({
            baseUrl: record.baseUrl,
            ...(typeof record.token === "string" ? { token: record.token } : {}),
          });
        }
      }
    } catch {
      // Invalid instance JSON is surfaced through unauthenticated auth detail,
      // but it must not make public Codeberg reads unusable.
    }
  }

  if (Option.isSome(config.baseUrl)) {
    inputs.push({
      baseUrl: config.baseUrl.value,
      ...(Option.isSome(config.token) ? { token: config.token.value } : {}),
    });
  } else if (Option.isSome(config.token)) {
    inputs.push({
      baseUrl: DEFAULT_BASE_URL,
      token: config.token.value,
    });
  }

  return inputs;
}

function baseUrlFromCliCredentialHost(host: string): string | null {
  const trimmed = host.trim();
  if (trimmed.length === 0) return null;
  if (/^https?:\/\//iu.test(trimmed)) {
    return normalizeBaseUrl(trimmed);
  }
  return normalizeBaseUrl(`https://${trimmed}`);
}

function cliCredentialInstanceInputs(
  credentials: ReadonlyArray<ForgejoCliCredential>,
): ReadonlyArray<ForgejoConfiguredInstanceInput> {
  return credentials.flatMap((credential) => {
    const baseUrl = baseUrlFromCliCredentialHost(credential.host);
    return baseUrl ? [{ baseUrl }] : [];
  });
}

function dedupeInstances(
  inputs: ReadonlyArray<ForgejoConfiguredInstanceInput>,
): ReadonlyArray<ForgejoInstanceConfig> {
  const byBaseUrl = new Map<string, ForgejoInstanceConfig>();
  for (const input of inputs) {
    const instance = toInstance(input);
    if (!instance) continue;
    const existing = byBaseUrl.get(instance.baseUrl);
    if (!existing || Option.isNone(existing.token)) {
      byBaseUrl.set(instance.baseUrl, instance);
    }
  }
  return [...byBaseUrl.values()];
}

function defaultInstance(instances: ReadonlyArray<ForgejoInstanceConfig>): ForgejoInstanceConfig {
  return instances[0] ?? toInstance({ baseUrl: DEFAULT_BASE_URL })!;
}

function findInstanceByHost(
  instances: ReadonlyArray<ForgejoInstanceConfig>,
  host: string,
): ForgejoInstanceConfig | null {
  const normalizedHost = host.toLowerCase();
  return instances.find((instance) => instance.host === normalizedHost) ?? null;
}

function adHocInstance(baseUrl: string): ForgejoInstanceConfig | null {
  return toInstance({ baseUrl });
}

function normalizeCliCredentialHost(host: string): string | null {
  const trimmed = host.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) return null;
  try {
    return /^https?:\/\//iu.test(trimmed)
      ? new URL(trimmed).host.toLowerCase()
      : new URL(`https://${trimmed}`).host.toLowerCase();
  } catch {
    return null;
  }
}

function parseForgejoCliCredentials(raw: string): ReadonlyArray<ForgejoCliCredential> {
  const decoded = decodeForgejoCliKeysJson(raw);
  if (!Result.isSuccess(decoded)) return [];

  const credentials: ForgejoCliCredential[] = [];
  for (const [host, login] of Object.entries(decoded.success.hosts ?? {})) {
    const normalizedHost = normalizeCliCredentialHost(host);
    const token = login.token?.trim() ?? "";
    const account = login.name?.trim() ?? "";
    if (!normalizedHost || token.length === 0 || account.length === 0) continue;
    credentials.push({
      host: normalizedHost,
      account,
      token,
    });
  }
  return credentials;
}

function forgejoCliKeysFileCandidates(
  config: Config.Success<typeof ForgejoApiEnvConfig>,
): ReadonlyArray<string> {
  const paths = new Set<string>();
  if (Option.isSome(config.cliKeysFile)) {
    paths.add(config.cliKeysFile.value);
  }

  const home = NodeOS.homedir();
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    paths.add(NodePath.join(xdgDataHome, "forgejo-cli", "keys.json"));
  }
  if (home.length > 0) {
    paths.add(NodePath.join(home, ".local", "share", "forgejo-cli", "keys.json"));
    paths.add(
      NodePath.join(home, "Library", "Application Support", "Cyborus.forgejo-cli", "keys.json"),
    );
    paths.add(
      NodePath.join(home, "Library", "Application Support", "org.Cyborus.forgejo-cli", "keys.json"),
    );
    paths.add(NodePath.join(home, "Library", "Application Support", "forgejo-cli", "keys.json"));
  }

  const appData = process.env.APPDATA?.trim();
  if (appData) {
    paths.add(NodePath.join(appData, "Cyborus", "forgejo-cli", "data", "keys.json"));
    paths.add(NodePath.join(appData, "forgejo-cli", "keys.json"));
  }

  return [...paths];
}

const readForgejoCliCredentials = Effect.fn("ForgejoApi.readForgejoCliCredentials")(function* (
  fileSystem: FileSystem.FileSystem,
  config: Config.Success<typeof ForgejoApiEnvConfig>,
) {
  const byHost = new Map<string, ForgejoCliCredential>();
  for (const path of forgejoCliKeysFileCandidates(config)) {
    const raw = yield* fileSystem
      .readFileString(path)
      .pipe(Effect.catch(() => Effect.succeed<string | null>(null)));
    if (raw === null) continue;
    for (const credential of parseForgejoCliCredentials(raw)) {
      if (!byHost.has(credential.host)) {
        byHost.set(credential.host, credential);
      }
    }
  }
  return [...byHost.values()];
});

function parseForgejoRepositoryPath(value: string): { owner: string; repo: string } | null {
  const normalized = value
    .trim()
    .replace(/\.git$/u, "")
    .replace(/^\/+/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const owner = parts.at(-2);
  const repo = parts.at(-1);
  return owner && repo ? { owner, repo } : null;
}

function parseForgejoRemoteUrl(
  remoteUrl: string,
  instances: ReadonlyArray<ForgejoInstanceConfig>,
): ForgejoRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/u);
    if (separatorIndex <= 0) return null;
    const host = hostWithPath.slice(0, separatorIndex).toLowerCase();
    const repository = parseForgejoRepositoryPath(hostWithPath.slice(separatorIndex + 1));
    const detected = detectSourceControlProviderFromRemoteUrl(trimmed);
    const instance =
      findInstanceByHost(instances, host) ??
      (detected?.kind === "forgejo" ? adHocInstance(detected.baseUrl) : null);
    return repository && instance ? { ...repository, instance } : null;
  }

  try {
    const url = new URL(trimmed);
    const repository = parseForgejoRepositoryPath(url.pathname);
    const detected = detectSourceControlProviderFromRemoteUrl(trimmed);
    const instance =
      findInstanceByHost(instances, url.host) ??
      (detected?.kind === "forgejo" ? adHocInstance(detected.baseUrl) : null);
    return repository && instance ? { ...repository, instance } : null;
  } catch {
    return null;
  }
}

function providerInfoForInstance(instance: ForgejoInstanceConfig): SourceControlProviderInfo {
  return {
    kind: "forgejo",
    name: instance.host === "codeberg.org" ? "Codeberg" : "Forgejo",
    baseUrl: instance.baseUrl,
  };
}

const normalizeChangeRequestId = forgejoPullRequestIndex;

function normalizeIssueId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:issues?)\/(\d+)(?:\D.*)?$/iu.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function sourceOwner(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

function toForgejoPullRequestState(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    case "merged":
      return "closed";
    case "all":
      return "all";
  }
}

function toForgejoIssueState(state: "open" | "closed" | "all"): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    case "all":
      return "all";
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_LIMIT));
}

function shouldPreferSshRemote(originRemoteUrl: string | null): boolean {
  const trimmed = originRemoteUrl?.trim() ?? "";
  return trimmed.startsWith("git@") || trimmed.startsWith("ssh://");
}

function selectCloneUrl(input: {
  readonly cloneUrls: SourceControlRepositoryCloneUrls;
  readonly originRemoteUrl: string | null;
}): string {
  return shouldPreferSshRemote(input.originRemoteUrl)
    ? input.cloneUrls.sshUrl
    : input.cloneUrls.url;
}

function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  if (!input.isCrossRepository) {
    return input.headBranch;
  }

  return `${WORKTREE_BRANCH_PREFIX}/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`;
}

function repositoryOwnerName(repositoryName: string): string {
  return repositoryName.split("/")[0]?.trim() || "forgejo";
}

function requestError(operation: string, cause: unknown): ForgejoApiError {
  return new ForgejoApiError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function responseError(
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, ForgejoApiError> {
  return response.text.pipe(
    Effect.catch(() => Effect.succeed("")),
    Effect.flatMap((body) =>
      Effect.fail(
        new ForgejoApiError({
          operation,
          status: response.status,
          detail:
            forgejoErrorMessage(body).length > 0
              ? `Forgejo returned HTTP ${response.status}: ${forgejoErrorMessage(body)}`
              : `Forgejo returned HTTP ${response.status}.`,
        }),
      ),
    ),
  );
}

export const make = Effect.fn("makeForgejoApi")(function* () {
  const config = yield* ForgejoApiEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const cliCredentials = yield* readForgejoCliCredentials(fileSystem, config);
  const instances = dedupeInstances([
    ...configuredInstanceInputs(config),
    ...cliCredentialInstanceInputs(cliCredentials),
    { baseUrl: DEFAULT_BASE_URL },
  ]);
  const firstInstance = defaultInstance(instances);

  const cliCredentialForHost = (host: string): ForgejoCliCredential | null =>
    cliCredentials.find((credential) => credential.host === host.toLowerCase()) ?? null;

  const tokenForInstance = (instance: ForgejoInstanceConfig): Option.Option<string> =>
    Option.isSome(instance.token)
      ? instance.token
      : nonEmpty(cliCredentialForHost(instance.host)?.token);

  const withAuth = (
    instance: ForgejoInstanceConfig,
    request: HttpClientRequest.HttpClientRequest,
  ) => {
    const token = tokenForInstance(instance);
    return Option.isSome(token)
      ? request.pipe(HttpClientRequest.setHeader("Authorization", `token ${token.value}`))
      : request;
  };

  const decodeResponse = <S extends Schema.Top>(
    operation: string,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoApiError({
                operation,
                detail: "Forgejo returned invalid JSON for the requested resource.",
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: string,
    instance: ForgejoInstanceConfig,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], ForgejoApiError, S["DecodingServices"]> =>
    httpClient.execute(withAuth(instance, request.pipe(HttpClientRequest.acceptJson))).pipe(
      Effect.mapError((cause) => requestError(operation, cause)),
      Effect.flatMap((response) => decodeResponse(operation, schema, response)),
    );

  const executeText = (
    operation: string,
    instance: ForgejoInstanceConfig,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<string, ForgejoApiError> =>
    httpClient.execute(withAuth(instance, request)).pipe(
      Effect.mapError((cause) => requestError(operation, cause)),
      Effect.flatMap((response) =>
        HttpClientResponse.matchStatus({
          "2xx": (success) =>
            success.text.pipe(Effect.mapError((cause) => requestError(operation, cause))),
          orElse: (failed) => responseError(operation, failed),
        })(response),
      ),
    );

  // ── Pull request page transport ────────────────────────────────────

  const pageRequest = (
    repository: ForgejoRepositoryLocator,
    spec: ForgejoRequestSpec,
  ): HttpClientRequest.HttpClientRequest => {
    const url = apiUrl(
      repository.instance,
      spec.absolute ? spec.path : `${repositoryPath(repository)}${spec.path}`,
    );
    const request = HttpClientRequest.make(spec.method ?? "GET")(
      url,
      spec.urlParams ? { urlParams: spec.urlParams } : undefined,
    );
    return spec.body === undefined
      ? request
      : request.pipe(HttpClientRequest.bodyJsonUnsafe(spec.body));
  };

  const executePage = <A>(
    operation: string,
    repository: ForgejoRepositoryLocator,
    spec: ForgejoRequestSpec,
    onSuccess: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, ForgejoApiError>,
  ): Effect.Effect<A, ForgejoApiError> =>
    httpClient
      .execute(
        withAuth(
          repository.instance,
          pageRequest(repository, spec).pipe(HttpClientRequest.acceptJson),
        ),
      )
      .pipe(
        Effect.mapError((cause) => requestError(operation, cause)),
        Effect.flatMap((response) =>
          HttpClientResponse.matchStatus({
            "2xx": onSuccess,
            orElse: (failed) => responseError(operation, failed),
          })(response),
        ),
      );

  /** The response body up to `maxBytes`; stops reading (and drops the connection) past it. */
  const readBoundedBody = (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
    maxBytes: number,
  ) =>
    Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      yield* response.stream.pipe(
        Stream.runForEachWhile((chunk) =>
          Effect.sync(() => {
            const remaining = maxBytes - size;
            if (chunk.byteLength > remaining) {
              chunks.push(chunk.subarray(0, Math.max(0, remaining)));
              size = maxBytes;
              truncated = true;
              return false;
            }
            chunks.push(chunk);
            size += chunk.byteLength;
            return true;
          }),
        ),
        Effect.mapError((cause) => requestError(operation, cause)),
      );
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, truncated };
    });

  /** Logins are stable for a token, so each instance's is read once. */
  const viewerLogins = new Map<string, string>();
  const viewerLogin = (instance: ForgejoInstanceConfig) => {
    if (Option.isNone(tokenForInstance(instance))) return Effect.succeed<string | null>(null);
    const cached = viewerLogins.get(instance.baseUrl);
    if (cached) return Effect.succeed<string | null>(cached);
    return currentUser(instance).pipe(
      Effect.map((user) => {
        const login = (user.login ?? user.username ?? "").trim();
        if (login.length === 0) return null;
        viewerLogins.set(instance.baseUrl, login);
        return login;
      }),
    );
  };

  const pageHttp: ForgejoPageHttp<ForgejoRepositoryLocator> = {
    json: (operation, repository, spec, schema) =>
      executeJson(operation, repository.instance, pageRequest(repository, spec), schema),
    jsonOrEmpty: (operation, repository, spec, schema) =>
      executePage(operation, repository, spec, (response) =>
        response.text.pipe(Effect.mapError((cause) => requestError(operation, cause))),
      ).pipe(
        Effect.flatMap((text) =>
          text.trim().length === 0
            ? Effect.succeed(null)
            : Effect.try({
                try: () => JSON.parse(text) as unknown,
                catch: (cause) =>
                  new ForgejoApiError({
                    operation,
                    detail: "Forgejo returned invalid JSON for the requested resource.",
                    cause,
                  }),
              }).pipe(
                Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json)),
                Effect.mapError((cause) =>
                  isForgejoApiError(cause)
                    ? cause
                    : new ForgejoApiError({
                        operation,
                        detail: "Forgejo returned invalid JSON for the requested resource.",
                        cause,
                      }),
                ),
              ),
        ),
      ),
    text: (operation, repository, spec) =>
      executeText(operation, repository.instance, pageRequest(repository, spec)),
    send: (operation, repository, spec) =>
      executePage(operation, repository, spec, () => Effect.void),
    bytes: (operation, repository, spec, maxBytes) =>
      executePage(operation, repository, spec, (response) =>
        readBoundedBody(operation, response, maxBytes),
      ),
    viewerLogin: (repository) => viewerLogin(repository.instance),
  };

  const detectProviderFromRemoteUrl: ForgejoApiShape["detectProviderFromRemoteUrl"] = (
    remoteUrl,
  ) => {
    const staticProvider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
    if (staticProvider?.kind === "forgejo") {
      return staticProvider;
    }

    try {
      const host = remoteUrl.startsWith("git@")
        ? remoteUrl.slice("git@".length).split(/[:/]/u)[0]?.toLowerCase()
        : new URL(remoteUrl).host.toLowerCase();
      if (!host) return null;
      const instance = findInstanceByHost(instances, host);
      return instance ? providerInfoForInstance(instance) : null;
    } catch {
      return null;
    }
  };

  const resolveRepository = Effect.fn("ForgejoApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    if (input.repository !== undefined) {
      const parsed = parseForgejoRepositoryPath(input.repository);
      if (parsed) {
        return {
          ...parsed,
          instance:
            input.context?.provider.kind === "forgejo"
              ? (findInstanceByHost(instances, new URL(input.context.provider.baseUrl).host) ??
                adHocInstance(input.context.provider.baseUrl) ??
                firstInstance)
              : firstInstance,
        };
      }
    }

    if (input.context?.provider.kind === "forgejo") {
      const fromContext = parseForgejoRemoteUrl(input.context.remoteUrl, instances);
      if (fromContext) return fromContext;
    }

    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoApiError({
            operation: "resolveRepository",
            detail: `Failed to resolve VCS repository for ${input.cwd}.`,
            cause,
          }),
      ),
    );
    const remotes = yield* handle.driver.listRemotes(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new ForgejoApiError({
            operation: "resolveRepository",
            detail: `Failed to list remotes for ${input.cwd}.`,
            cause,
          }),
      ),
    );

    for (const remote of remotes.remotes) {
      if (detectProviderFromRemoteUrl(remote.url)?.kind !== "forgejo") continue;
      const parsed = parseForgejoRemoteUrl(remote.url, instances);
      if (parsed) return parsed;
    }

    return yield* new ForgejoApiError({
      operation: "resolveRepository",
      detail: `No Forgejo repository remote was detected for ${input.cwd}.`,
    });
  });

  const getRepositoryFromLocator = (repository: ForgejoRepositoryLocator) =>
    executeJson(
      "getRepository",
      repository.instance,
      HttpClientRequest.get(apiUrl(repository.instance, repositoryPath(repository))),
      ForgejoPullRequests.ForgejoRepositorySchema,
    );

  const getRepository = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) => resolveRepository(input).pipe(Effect.flatMap(getRepositoryFromLocator));

  const getRawPullRequestFromRepository = (
    repository: ForgejoRepositoryLocator,
    reference: string,
  ) =>
    executeJson(
      "getPullRequest",
      repository.instance,
      HttpClientRequest.get(
        apiUrl(
          repository.instance,
          `${repositoryPath(repository)}/pulls/${encodeURIComponent(normalizeChangeRequestId(reference))}`,
        ),
      ),
      ForgejoPullRequests.ForgejoPullRequestSchema,
    );

  const getRawPullRequest = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) =>
    resolveRepository(input).pipe(
      Effect.flatMap((repository) => getRawPullRequestFromRepository(repository, input.reference)),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    git.readConfigValue(cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveCheckoutRemote = Effect.fn("ForgejoApi.resolveCheckoutRemote")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly destinationRepository: ForgejoRepositoryLocator;
    readonly sourceRepositoryName: string;
    readonly sourceCloneUrls: SourceControlRepositoryCloneUrls;
    readonly isCrossRepository: boolean;
  }) {
    if (
      input.context?.provider.kind === "forgejo" &&
      !input.isCrossRepository &&
      parseForgejoRemoteUrl(input.context.remoteUrl, instances) !== null
    ) {
      return input.context.remoteName;
    }

    if (!input.isCrossRepository) {
      const remoteName = yield* git
        .resolvePrimaryRemoteName(input.cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (remoteName) return remoteName;
    }

    const originRemoteUrl = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
    return yield* git.ensureRemote({
      cwd: input.cwd,
      preferredName: input.isCrossRepository
        ? repositoryOwnerName(input.sourceRepositoryName)
        : input.destinationRepository.owner,
      url: selectCloneUrl({ cloneUrls: input.sourceCloneUrls, originRemoteUrl }),
    });
  });

  const currentUser = (instance: ForgejoInstanceConfig) =>
    executeJson(
      "getCurrentUser",
      instance,
      HttpClientRequest.get(apiUrl(instance, "/user")),
      ForgejoCurrentUserSchema,
    );

  const page = makeForgejoPullRequestPageApi({
    http: pageHttp,
    resolveRepository: (request) =>
      resolveRepository({
        cwd: request.cwd,
        ...(request.context ? { context: request.context } : {}),
      }),
  });

  return ForgejoApi.of({
    probeAuth: Effect.gen(function* () {
      const authedInstance = instances.find((instance) =>
        Option.isSome(tokenForInstance(instance)),
      );
      if (!authedInstance) {
        return {
          status: "unauthenticated" as const,
          account: Option.none(),
          host: Option.some(firstInstance.host),
          detail: Option.some(
            "Run `fj auth login` on the server and verify with `fj -H codeberg.org whoami`, set RYCO_FORGEJO_BASE_URL and RYCO_FORGEJO_TOKEN, or set RYCO_FORGEJO_CLI_KEYS_FILE to the fj keys.json path.",
          ),
        };
      }

      const cliCredential = cliCredentialForHost(authedInstance.host);
      return yield* currentUser(authedInstance).pipe(
        Effect.map((user) => ({
          status: "authenticated" as const,
          account: nonEmpty(user.login ?? user.username ?? user.full_name),
          host: Option.some(authedInstance.host),
          detail: Option.none<string>(),
        })),
        Effect.catch(() =>
          Effect.succeed({
            status: "unknown" as const,
            account: cliCredential ? Option.some(cliCredential.account) : Option.none(),
            host: Option.some(authedInstance.host),
            detail: Option.some(
              Option.isSome(authedInstance.token)
                ? "Forgejo token is configured, but auth status could not be read."
                : "`fj` credentials were found, but auth status could not be read.",
            ),
          }),
        ),
      );
    }),
    detectProviderFromRemoteUrl,
    listPullRequests: (input) => {
      // An empty head selector is the pull requests page's list: every head,
      // with merge readiness on open rows.
      const expectedHead = SourceControlProvider.sourceBranch(input);
      const pageList = expectedHead.length === 0;
      return resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "listPullRequests",
            repository.instance,
            HttpClientRequest.get(
              apiUrl(repository.instance, `${repositoryPath(repository)}/pulls`),
              {
                urlParams: {
                  state: toForgejoPullRequestState(input.state),
                  sort: "recentupdate",
                  limit: String(clampLimit(input.limit)),
                },
              },
            ),
            ForgejoPullRequests.ForgejoPullRequestListSchema,
          ).pipe(
            Effect.map((list) => list.map(ForgejoPullRequests.normalizeForgejoPullRequestRecord)),
            Effect.map((list) =>
              list.filter((pr) => {
                if (!pageList && pr.headRefName !== expectedHead) return false;
                return input.state === "merged" ? pr.state === "merged" : true;
              }),
            ),
            Effect.flatMap((list) =>
              pageList ? page.withRowReadiness(input, list) : Effect.succeed(list),
            ),
          ),
        ),
      );
    },
    getPullRequest: (input) =>
      getRawPullRequest(input).pipe(
        Effect.map(ForgejoPullRequests.normalizeForgejoPullRequestRecord),
      ),
    getRepositoryCloneUrls: (input) =>
      getRepository(input).pipe(
        Effect.map(ForgejoPullRequests.normalizeForgejoRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      Effect.gen(function* () {
        const parsed = parseForgejoRepositoryPath(input.repository);
        if (!parsed) {
          return yield* new ForgejoApiError({
            operation: "createRepository",
            detail: "Forgejo repositories must be specified as owner/repository.",
          });
        }

        const instance = firstInstance;
        const user = yield* currentUser(instance).pipe(Effect.catch(() => Effect.succeed(null)));
        const currentLogin = (user?.login ?? user?.username ?? "").trim();
        const targetPath =
          currentLogin.length > 0 && currentLogin.toLowerCase() === parsed.owner.toLowerCase()
            ? "/user/repos"
            : `/orgs/${encodeURIComponent(parsed.owner)}/repos`;
        return yield* executeJson(
          "createRepository",
          instance,
          HttpClientRequest.post(apiUrl(instance, targetPath)).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name: parsed.repo,
              private: input.visibility === "private",
              auto_init: false,
            }),
          ),
          ForgejoPullRequests.ForgejoRepositorySchema,
        );
      }).pipe(Effect.map(ForgejoPullRequests.normalizeForgejoRepositoryCloneUrls)),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const body = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoApiError({
                operation: "createPullRequest",
                detail: `Failed to read pull request body file ${input.bodyFile}.`,
                cause,
              }),
          ),
        );
        const owner = sourceOwner(input);
        const headBranch = SourceControlProvider.sourceBranch(input);
        const head = owner ? `${owner}:${headBranch}` : headBranch;

        const created = yield* executeJson(
          "createPullRequest",
          repository.instance,
          HttpClientRequest.post(
            apiUrl(repository.instance, `${repositoryPath(repository)}/pulls`),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              // Forgejo drafts are work-in-progress title prefixes.
              title:
                input.draft === true ? forgejoWorkInProgressTitle(input.title, true) : input.title,
              body,
              head,
              base: input.target?.refName ?? input.baseBranch,
            }),
          ),
          ForgejoPullRequests.ForgejoPullRequestSchema,
        );
        if (input.draft === true) yield* page.verifyCreatedDraft("createPullRequest", created);
      }),
    getDefaultBranch: (input) =>
      getRepository(input).pipe(
        Effect.map((repository) => repository.default_branch?.trim() || null),
      ),
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const destinationRepository = yield* resolveRepository(input);
        const pullRequest = yield* getRawPullRequestFromRepository(
          destinationRepository,
          input.reference,
        );
        const summary = ForgejoPullRequests.normalizeForgejoPullRequestRecord(pullRequest);
        const destinationRepositoryName =
          pullRequest.base.repo?.full_name ??
          `${destinationRepository.owner}/${destinationRepository.repo}`;
        const sourceRepositoryName =
          summary.headRepositoryNameWithOwner ?? destinationRepositoryName;
        const isCrossRepository = sourceRepositoryName !== destinationRepositoryName;
        const sourceCloneUrls =
          pullRequest.head.repo !== undefined && pullRequest.head.repo !== null
            ? ForgejoPullRequests.normalizeForgejoRepositoryCloneUrls(pullRequest.head.repo)
            : {
                nameWithOwner: sourceRepositoryName,
                url: summary.headRepositoryCloneUrl ?? sourceRepositoryName,
                sshUrl:
                  summary.headRepositorySshUrl ??
                  summary.headRepositoryCloneUrl ??
                  sourceRepositoryName,
              };
        const remoteName = yield* resolveCheckoutRemote({
          cwd: input.cwd,
          destinationRepository,
          sourceRepositoryName,
          sourceCloneUrls,
          isCrossRepository,
          ...(input.context ? { context: input.context } : {}),
        });
        const remoteBranch = summary.headRefName;
        const localBranch = checkoutBranchName({
          pullRequestId: summary.number,
          headBranch: remoteBranch,
          isCrossRepository,
        });
        const localBranchNames = yield* git.listLocalBranchNames(input.cwd);
        const localBranchExists = localBranchNames.includes(localBranch);

        if (input.force === true || !localBranchExists) {
          yield* git.fetchRemoteBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
            localBranch,
          });
        } else {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch,
          });
        }

        yield* git.setBranchUpstream({
          cwd: input.cwd,
          branch: localBranch,
          remoteName,
          remoteBranch,
        });
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isForgejoApiError(cause)
            ? cause
            : new ForgejoApiError({
                operation: "checkoutPullRequest",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
        ),
      ),
    listIssues: (input) =>
      resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) =>
          executeJson(
            "listIssues",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, `${repositoryPath(repo)}/issues`), {
              urlParams: {
                state: toForgejoIssueState(input.state),
                type: "issues",
                sort: "recentupdate",
                limit: String(clampLimit(input.limit)),
              },
            }),
            ForgejoIssues.ForgejoIssueListSchema,
          ).pipe(
            Effect.map((list) =>
              list
                .map(ForgejoIssues.normalizeForgejoIssueRecord)
                .filter(
                  (issue): issue is ForgejoIssues.NormalizedForgejoIssueRecord => issue !== null,
                ),
            ),
            Effect.catch((err) =>
              isForgejoApiError(err) && err.status === 404 ? Effect.succeed([]) : Effect.fail(err),
            ),
          ),
        ),
      ),
    getIssue: (input) => {
      const referenceId = normalizeIssueId(input.reference);
      return resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) => {
          const issuePath = `${repositoryPath(repo)}/issues/${encodeURIComponent(referenceId)}`;
          const issue = executeJson(
            "getIssue",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, issuePath)),
            ForgejoIssues.ForgejoIssueSchema,
          );
          const comments = executeJson(
            "getIssueComments",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, `${issuePath}/comments`), {
              urlParams: { limit: "6" },
            }),
            ForgejoIssues.ForgejoCommentListSchema,
          ).pipe(
            Effect.catch((err) =>
              isForgejoApiError(err) && err.status === 404
                ? Effect.succeed<typeof ForgejoIssues.ForgejoCommentListSchema.Type>([])
                : Effect.fail(err),
            ),
          );
          return Effect.all([issue, comments], { concurrency: 2 }).pipe(
            Effect.map(([rawIssue, rawComments]) =>
              ForgejoIssues.normalizeForgejoIssueDetail({
                issue: rawIssue,
                comments: rawComments,
              }),
            ),
          );
        }),
      );
    },
    searchIssues: (input) =>
      resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) =>
          executeJson(
            "searchIssues",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, `${repositoryPath(repo)}/issues`), {
              urlParams: {
                state: "all",
                type: "issues",
                q: input.query,
                sort: "recentupdate",
                limit: String(clampLimit(input.limit)),
              },
            }),
            ForgejoIssues.ForgejoIssueListSchema,
          ).pipe(
            Effect.map((list) =>
              list
                .map(ForgejoIssues.normalizeForgejoIssueRecord)
                .filter(
                  (issue): issue is ForgejoIssues.NormalizedForgejoIssueRecord => issue !== null,
                ),
            ),
            Effect.map((list) => {
              const query = input.query.trim().toLowerCase();
              return query.length === 0
                ? list
                : list.filter(
                    (issue) =>
                      issue.title.toLowerCase().includes(query) || String(issue.number) === query,
                  );
            }),
            Effect.catch((err) =>
              isForgejoApiError(err) && err.status === 404 ? Effect.succeed([]) : Effect.fail(err),
            ),
          ),
        ),
      ),
    searchPullRequests: (input) =>
      page
        .searchPullRequests({ ...input, limit: clampLimit(input.limit) })
        .pipe(Effect.catch((err) => (err.status === 404 ? Effect.succeed([]) : Effect.fail(err)))),
    getPullRequestDetail: (input) => {
      const referenceId = normalizeChangeRequestId(input.reference);
      return resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) => {
          const prPath = `${repositoryPath(repo)}/pulls/${encodeURIComponent(referenceId)}`;
          const issuePath = `${repositoryPath(repo)}/issues/${encodeURIComponent(referenceId)}`;
          const pullRequest = executeJson(
            "getPullRequestDetail",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, prPath)),
            ForgejoPullRequests.ForgejoPullRequestSchema,
          );
          const comments = executeJson(
            "getPullRequestComments",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, `${issuePath}/comments`), {
              urlParams: { limit: "6" },
            }),
            ForgejoIssues.ForgejoCommentListSchema,
          ).pipe(
            Effect.catch((err) =>
              isForgejoApiError(err) && err.status === 404
                ? Effect.succeed<typeof ForgejoIssues.ForgejoCommentListSchema.Type>([])
                : Effect.fail(err),
            ),
          );
          const commits = executeJson(
            "getPullRequestCommits",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, `${prPath}/commits`), {
              urlParams: { limit: "50" },
            }),
            ForgejoPullRequests.ForgejoCommitListSchema,
          ).pipe(
            Effect.catch((err) =>
              isForgejoApiError(err) && err.status === 404
                ? Effect.succeed<typeof ForgejoPullRequests.ForgejoCommitListSchema.Type>([])
                : Effect.fail(err),
            ),
          );
          const files = executeJson(
            "getPullRequestFiles",
            repo.instance,
            HttpClientRequest.get(apiUrl(repo.instance, `${prPath}/files`), {
              urlParams: { limit: "50" },
            }),
            ForgejoPullRequests.ForgejoChangedFileListSchema,
          ).pipe(
            Effect.catch((err) =>
              isForgejoApiError(err) && err.status === 404
                ? Effect.succeed<typeof ForgejoPullRequests.ForgejoChangedFileListSchema.Type>([])
                : Effect.fail(err),
            ),
          );
          return Effect.all(
            {
              pullRequest,
              comments,
              commits,
              files,
            },
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(ForgejoPullRequests.normalizeForgejoPullRequestDetail),
            Effect.flatMap((detail) => page.withDetailReadiness(input, detail)),
          );
        }),
      );
    },
    getPullRequestDiff: (input) => page.getPullRequestDiff(input),
    listInvolvedPullRequests: (input) =>
      page.listInvolvedPullRequests({ ...input, limit: clampLimit(input.limit) }),
    getPullRequestActivity: (input) => page.getPullRequestActivity(input),
    getPullRequestFileContents: (input) => page.getPullRequestFileContents(input),
    addPullRequestComment: (input) => page.addPullRequestComment(input),
    togglePullRequestCommentReaction: (input) => page.togglePullRequestCommentReaction(input),
    updatePullRequestComment: (input) => page.updatePullRequestComment(input),
    submitPullRequestReview: (input) => page.submitPullRequestReview(input),
    replyToPullRequestReviewThread: (input) => page.replyToPullRequestReviewThread(input),
    updatePullRequest: (input) => page.updatePullRequest(input),
    mergePullRequest: (input) => page.mergePullRequest(input),
    listLabels: (input) => page.listLabels(input),
    listAssignees: (input) => page.listAssignees(input),
  });
});

export const layer = Layer.effect(ForgejoApi, make());
