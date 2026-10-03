import { Config, Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  TrimmedNonEmptyString,
  type ChangeRequestInvolvement,
  type SourceControlAssigneeCandidate,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryVisibility,
} from "@ryco/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { sanitizeBranchFragment, WORKTREE_BRANCH_PREFIX } from "@ryco/shared/git";
import { detectSourceControlProviderFromRemoteUrl } from "@ryco/shared/sourceControl";

import { BitbucketApiError, isBitbucketApiError } from "./bitbucketApiError.ts";
import * as BitbucketIssues from "./bitbucketIssues.ts";
import * as BitbucketPullRequests from "./bitbucketPullRequests.ts";
import { makeBitbucketPullRequestPageApi } from "./bitbucketPullRequestPageApi.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { manualBitbucketTokenSecretName } from "../atlassian/AtlassianConnectionService.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { AtlassianConnectionRepository } from "../persistence/Services/AtlassianConnections.ts";
import type { AtlassianConnectionRecord } from "../persistence/Services/AtlassianConnections.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const DEFAULT_API_BASE_URL = "https://api.bitbucket.org/2.0";
const textDecoder = new TextDecoder();

const BitbucketApiEnvConfig = Config.all({
  baseUrl: Config.string("RYCO_BITBUCKET_API_BASE_URL").pipe(
    Config.withDefault(DEFAULT_API_BASE_URL),
  ),
  accessToken: Config.string("RYCO_BITBUCKET_ACCESS_TOKEN").pipe(Config.option),
  email: Config.string("RYCO_BITBUCKET_EMAIL").pipe(Config.option),
  apiToken: Config.string("RYCO_BITBUCKET_API_TOKEN").pipe(Config.option),
});

export { BitbucketApiError };

const RawBitbucketRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  links: Schema.Struct({
    html: Schema.optional(
      Schema.Struct({
        href: TrimmedNonEmptyString,
      }),
    ),
    clone: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
  }),
  mainbranch: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(TrimmedNonEmptyString),
      }),
    ),
  ),
});

const RawBitbucketRepositoryListSchema = Schema.Struct({
  values: Schema.Array(RawBitbucketRepositorySchema),
  next: Schema.optional(TrimmedNonEmptyString),
});

const RawBitbucketWorkspaceAccessListSchema = Schema.Struct({
  values: Schema.Array(
    Schema.Struct({
      workspace: Schema.Struct({
        slug: TrimmedNonEmptyString,
      }),
    }),
  ),
  next: Schema.optional(TrimmedNonEmptyString),
});

const RawBitbucketBranchingModelSchema = Schema.Struct({
  development: Schema.optional(
    Schema.Struct({
      branch: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            name: Schema.optional(TrimmedNonEmptyString),
          }),
        ),
      ),
      is_valid: Schema.optional(Schema.Boolean),
      name: Schema.optional(Schema.NullOr(Schema.String)),
      use_mainbranch: Schema.optional(Schema.Boolean),
    }),
  ),
});

const BitbucketUserSchema = Schema.Struct({
  username: Schema.optional(TrimmedNonEmptyString),
  display_name: Schema.optional(TrimmedNonEmptyString),
  account_id: Schema.optional(TrimmedNonEmptyString),
});

export interface BitbucketRepositoryLocator {
  readonly workspace: string;
  readonly repoSlug: string;
}

interface BitbucketCredential {
  readonly source: "stored" | "env";
  readonly kind: "basic" | "bearer";
  readonly email: Option.Option<string>;
  readonly token: string;
  readonly detail: string;
}

const DEFAULT_REPOSITORY_SEARCH_LIMIT = 25;
const MAX_REPOSITORY_SEARCH_LIMIT = 50;
const BITBUCKET_WORKSPACE_PAGE_LIMIT = 10;
const BITBUCKET_REPOSITORY_PAGE_LIMIT = 2;

export interface BitbucketApiShape {
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
    /** Authored / review-requested by the viewer (other kinds fail). */
    readonly involvement?: ChangeRequestInvolvement;
    /** Title search combined with the other filters. */
    readonly query?: string;
  }) => Effect.Effect<
    ReadonlyArray<BitbucketPullRequests.NormalizedBitbucketPullRequestRecord>,
    BitbucketApiError
  >;
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<
    BitbucketPullRequests.NormalizedBitbucketPullRequestRecord,
    BitbucketApiError
  >;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketApiError>;
  readonly searchRepositories: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly query?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlRepositoryCloneUrls>, BitbucketApiError>;
  readonly cloneAuthentication: (input: {
    readonly remoteUrl: string;
  }) => Effect.Effect<
    SourceControlProvider.SourceControlCloneAuthentication | null,
    BitbucketApiError
  >;
  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketApiError>;
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlProvider.SourceControlRefSelector;
    readonly target?: SourceControlProvider.SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
    readonly draft?: boolean;
  }) => Effect.Effect<void, BitbucketApiError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<string | null, BitbucketApiError>;
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, BitbucketApiError>;
  readonly listIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly state: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<BitbucketIssues.NormalizedBitbucketIssueRecord>,
    BitbucketApiError
  >;
  readonly getIssue: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<BitbucketIssues.NormalizedBitbucketIssueDetail, BitbucketApiError>;
  readonly searchIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<BitbucketIssues.NormalizedBitbucketIssueRecord>,
    BitbucketApiError
  >;
  readonly searchPullRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<
    ReadonlyArray<BitbucketPullRequests.NormalizedBitbucketPullRequestRecord>,
    BitbucketApiError
  >;
  readonly getPullRequestDetail: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<
    BitbucketPullRequests.NormalizedBitbucketPullRequestDetail,
    BitbucketApiError
  >;
  readonly getPullRequestDiff: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
    /** Fail when the head is not (or no longer) this commit. */
    readonly expectedHeadSha?: string | undefined;
    /** One commit of the pull request against its first parent. */
    readonly commitSha?: string | undefined;
  }) => Effect.Effect<string, BitbucketApiError>;
  readonly getPullRequestState: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<
    { readonly state: "open" | "closed" | "merged"; readonly isDraft: boolean },
    BitbucketApiError
  >;
  readonly listAssignees: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<ReadonlyArray<SourceControlAssigneeCandidate>, BitbucketApiError>;
  readonly getPullRequestActivity: BitbucketPullRequestPageApi["getPullRequestActivity"];
  readonly getPullRequestFileContents: BitbucketPullRequestPageApi["getPullRequestFileContents"];
  readonly addPullRequestComment: (
    input: Parameters<BitbucketPullRequestPageApi["addPullRequestComment"]>[0],
  ) => Effect.Effect<void, BitbucketApiError>;
  readonly updatePullRequestComment: BitbucketPullRequestPageApi["updatePullRequestComment"];
  readonly replyToPullRequestThread: BitbucketPullRequestPageApi["replyToPullRequestThread"];
  readonly setPullRequestThreadResolved: BitbucketPullRequestPageApi["setPullRequestThreadResolved"];
  readonly submitPullRequestReview: BitbucketPullRequestPageApi["submitPullRequestReview"];
  readonly updatePullRequest: (
    input: Parameters<BitbucketPullRequestPageApi["updatePullRequest"]>[0],
  ) => Effect.Effect<void, BitbucketApiError>;
  readonly mergePullRequest: BitbucketPullRequestPageApi["mergePullRequest"];
}

type BitbucketPullRequestPageApi = ReturnType<typeof makeBitbucketPullRequestPageApi>;

export class BitbucketApi extends Context.Service<BitbucketApi, BitbucketApiShape>()(
  "ryco/source-control/BitbucketApi",
) {}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function normalizeIssueId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:issues?)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function sourceWorkspace(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

function toBitbucketStates(state: "open" | "closed" | "merged" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["OPEN"];
    case "closed":
      return ["DECLINED", "SUPERSEDED"];
    case "merged":
      return ["MERGED"];
    case "all":
      return ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"];
  }
}

function toBitbucketIssueStates(state: "open" | "closed" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["new", "open", "submitted"];
    case "closed":
      return ["resolved", "closed", "on hold", "invalid", "duplicate", "wontfix"];
    case "all":
      return [];
  }
}

function bitbucketQueryString(filters: ReadonlyArray<string>): string {
  return filters.join(" AND ");
}

function bitbucketStateFilter(states: ReadonlyArray<string>): string {
  return states.length === 1
    ? `state = "${states[0]}"`
    : `(${states.map((state) => `state = "${state}"`).join(" OR ")})`;
}

function parseBitbucketRepositorySlug(value: string): BitbucketRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const workspace = parts.at(-2);
  const repoSlug = parts.at(-1);
  return workspace && repoSlug ? { workspace, repoSlug } : null;
}

function requireRepositoryLocator(
  operation: string,
  repository: string,
): Effect.Effect<BitbucketRepositoryLocator, BitbucketApiError> {
  const locator = parseBitbucketRepositorySlug(repository);
  return locator
    ? Effect.succeed(locator)
    : Effect.fail(
        new BitbucketApiError({
          operation,
          detail: "Bitbucket repositories must be specified as workspace/repository.",
        }),
      );
}

function parseBitbucketRemoteUrl(remoteUrl: string): BitbucketRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.startsWith("git@")) {
    const pathStart = trimmed.indexOf(":");
    return pathStart < 0 ? null : parseBitbucketRepositorySlug(trimmed.slice(pathStart + 1));
  }

  try {
    return parseBitbucketRepositorySlug(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

function normalizeRepositoryCloneUrls(
  raw: typeof RawBitbucketRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  const httpClone =
    raw.links.clone?.find((entry) => entry.name.toLowerCase() === "https")?.href ??
    raw.links.html?.href;
  const sshClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "ssh")?.href;

  return {
    nameWithOwner: raw.full_name,
    url: httpClone ?? raw.links.html?.href ?? raw.full_name,
    sshUrl: sshClone ?? httpClone ?? raw.full_name,
  };
}

function repositorySearchLimit(limit: number | undefined): number {
  return Math.max(
    1,
    Math.min(
      Number.isFinite(limit)
        ? Math.floor(limit ?? DEFAULT_REPOSITORY_SEARCH_LIMIT)
        : DEFAULT_REPOSITORY_SEARCH_LIMIT,
      MAX_REPOSITORY_SEARCH_LIMIT,
    ),
  );
}

function escapeBitbucketQueryValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function bitbucketRepositorySearchFilter(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  const escaped = escapeBitbucketQueryValue(trimmed);
  return `(name ~ "${escaped}" OR full_name ~ "${escaped}")`;
}

function repositorySlugFromNameWithOwner(nameWithOwner: string): string {
  return nameWithOwner.split("/").at(-1)?.trim() ?? nameWithOwner;
}

function repositoryMatchesQuery(
  repository: SourceControlRepositoryCloneUrls,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return [
    repository.nameWithOwner,
    repositorySlugFromNameWithOwner(repository.nameWithOwner),
    repository.url,
    repository.sshUrl,
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

function repositorySearchRank(
  repository: SourceControlRepositoryCloneUrls,
  normalizedQuery: string,
): number {
  if (normalizedQuery.length === 0) return 0;
  const nameWithOwner = repository.nameWithOwner.toLowerCase();
  const repoSlug = repositorySlugFromNameWithOwner(repository.nameWithOwner).toLowerCase();
  if (nameWithOwner === normalizedQuery) return 0;
  if (repoSlug === normalizedQuery) return 1;
  if (nameWithOwner.startsWith(normalizedQuery)) return 2;
  if (repoSlug.startsWith(normalizedQuery)) return 3;
  return 4;
}

function uniqueRankedRepositories(input: {
  readonly repositories: ReadonlyArray<SourceControlRepositoryCloneUrls>;
  readonly query: string;
  readonly limit: number;
}): ReadonlyArray<SourceControlRepositoryCloneUrls> {
  const seen = new Set<string>();
  const normalizedQuery = input.query.trim().toLowerCase();
  return input.repositories
    .filter((repository) => {
      if (!repositoryMatchesQuery(repository, input.query)) return false;
      const key = repository.nameWithOwner.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((repository, index) => ({ repository, index }))
    .toSorted((left, right) => {
      const leftRank = repositorySearchRank(left.repository, normalizedQuery);
      const rightRank = repositorySearchRank(right.repository, normalizedQuery);
      if (leftRank !== rightRank) return leftRank - rightRank;
      if (normalizedQuery.length === 0) return left.index - right.index;
      return left.repository.nameWithOwner.localeCompare(right.repository.nameWithOwner);
    })
    .slice(0, input.limit)
    .map((entry) => entry.repository);
}

function isBitbucketHttpsRemoteUrl(remoteUrl: string): boolean {
  try {
    const url = new URL(remoteUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "bitbucket.org";
  } catch {
    return false;
  }
}

function gitCloneAuthenticationFromCredential(
  credential: BitbucketCredential,
): SourceControlProvider.SourceControlCloneAuthentication {
  return {
    kind: "http-basic",
    username: credential.kind === "bearer" ? "x-token-auth" : "x-bitbucket-api-token-auth",
    password: credential.token,
  };
}

function defaultChangeRequestTargetBranch(input: {
  readonly repository: typeof RawBitbucketRepositorySchema.Type;
  readonly branchingModel: typeof RawBitbucketBranchingModelSchema.Type | null;
}): string | null {
  const repositoryMainBranch = input.repository.mainbranch?.name ?? null;
  const development = input.branchingModel?.development;
  if (!development || development.use_mainbranch === true || development.is_valid === false) {
    return repositoryMainBranch;
  }

  const developmentBranch = development.branch?.name?.trim() ?? development.name?.trim() ?? "";
  if (developmentBranch.length === 0 || developmentBranch === "null") {
    return repositoryMainBranch;
  }

  return developmentBranch;
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

function repositoryNameWithOwner(
  repository: Schema.Schema.Type<
    typeof BitbucketPullRequests.BitbucketPullRequestSchema
  >["source"]["repository"],
): string | null {
  const fullName = repository?.full_name?.trim() ?? "";
  return fullName.length > 0 ? fullName : null;
}

function repositoryOwnerName(repositoryName: string): string {
  return repositoryName.split("/")[0]?.trim() || "bitbucket";
}

function authFromConfig(
  config: Config.Success<typeof BitbucketApiEnvConfig>,
): SourceControlProviderAuth {
  if (Option.isSome(config.accessToken)) {
    return {
      status: "unknown",
      account: Option.none(),
      host: Option.some("bitbucket.org"),
      detail: Option.some("Bitbucket access token is configured."),
    };
  }

  if (Option.isSome(config.email) && Option.isSome(config.apiToken)) {
    return {
      status: "unknown",
      account: config.email,
      host: Option.some("bitbucket.org"),
      detail: Option.some("Bitbucket API token is configured."),
    };
  }

  return {
    status: "unauthenticated",
    account: Option.none(),
    host: Option.some("bitbucket.org"),
    detail: Option.some(
      "Set RYCO_BITBUCKET_EMAIL and RYCO_BITBUCKET_API_TOKEN, or RYCO_BITBUCKET_ACCESS_TOKEN.",
    ),
  };
}

function credentialFromConfig(
  config: Config.Success<typeof BitbucketApiEnvConfig>,
): BitbucketCredential | null {
  if (Option.isSome(config.accessToken)) {
    return {
      source: "env",
      kind: "bearer",
      email: Option.none(),
      token: config.accessToken.value,
      detail: "Bitbucket access token is configured.",
    };
  }

  if (Option.isSome(config.email) && Option.isSome(config.apiToken)) {
    return {
      source: "env",
      kind: "basic",
      email: config.email,
      token: config.apiToken.value,
      detail: "Bitbucket API token is configured.",
    };
  }

  return null;
}

function unauthenticatedAuth(): SourceControlProviderAuth {
  return {
    status: "unauthenticated",
    account: Option.none(),
    host: Option.some("bitbucket.org"),
    detail: Option.some(
      "Save a Bitbucket app password in Settings -> Source Control -> Atlassian, or set RYCO_BITBUCKET_EMAIL and RYCO_BITBUCKET_API_TOKEN on the server.",
    ),
  };
}

function credentialAuthStatus(credential: BitbucketCredential): SourceControlProviderAuth {
  return {
    status: "unknown",
    account: credential.email,
    host: Option.some("bitbucket.org"),
    detail: Option.some(
      credential.source === "stored"
        ? "Saved Bitbucket app password is configured, but auth status could not be verified."
        : credential.detail,
    ),
  };
}

function failedCredentialAuthStatus(
  credential: BitbucketCredential,
  error: BitbucketApiError,
): SourceControlProviderAuth {
  const invalid = error.status === 401 || error.status === 403;
  return {
    status: invalid ? "unauthenticated" : "unknown",
    account: credential.email,
    host: Option.some("bitbucket.org"),
    detail: Option.some(
      credential.source === "stored"
        ? `Saved Bitbucket app password could not be verified. ${error.detail}`
        : `${credential.detail} ${error.detail}`,
    ),
  };
}

function isConnectedBitbucketTokenConnection(record: AtlassianConnectionRecord): boolean {
  return (
    record.status === "connected" &&
    record.kind === "bitbucket_token" &&
    record.products.includes("bitbucket") &&
    record.capabilities.includes("bitbucket:read")
  );
}

function requestError(operation: string, cause: unknown): BitbucketApiError {
  return new BitbucketApiError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function responseError(
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, BitbucketApiError> {
  return response.text.pipe(
    Effect.catch(() => Effect.succeed("")),
    Effect.flatMap((body) =>
      Effect.fail(
        new BitbucketApiError({
          operation,
          status: response.status,
          detail:
            body.trim().length > 0
              ? `Bitbucket returned HTTP ${response.status}: ${body.trim()}`
              : `Bitbucket returned HTTP ${response.status}.`,
        }),
      ),
    ),
  );
}

export const make = Effect.fn("makeBitbucketApi")(function* () {
  const config = yield* BitbucketApiEnvConfig;
  const atlassianConnections = yield* AtlassianConnectionRepository;
  const secretStore = yield* ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const apiUrl = (path: string) => `${config.baseUrl.replace(/\/+$/u, "")}${path}`;

  const envCredential = credentialFromConfig(config);

  const resolveStoredCredential = Effect.fn("BitbucketApi.resolveStoredCredential")(function* (
    operation: string,
  ) {
    const candidates = yield* atlassianConnections.list({ status: "connected" }).pipe(
      Effect.map((items) => items.filter(isConnectedBitbucketTokenConnection)),
      Effect.mapError(
        (cause) =>
          new BitbucketApiError({
            operation,
            detail: "Failed to read saved Bitbucket connections.",
            cause,
          }),
      ),
    );

    for (const connection of candidates) {
      const email = connection.accountEmail?.trim();
      if (!email) continue;
      const tokenBytes = yield* secretStore
        .get(manualBitbucketTokenSecretName(connection.connectionId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketApiError({
                operation,
                detail: `Failed to read saved Bitbucket token for ${connection.label}.`,
                cause,
              }),
          ),
        );
      if (!tokenBytes || tokenBytes.length === 0) continue;
      const token = textDecoder.decode(tokenBytes).trim();
      if (!token) continue;

      return {
        source: "stored" as const,
        kind: "basic" as const,
        email: Option.some(email),
        token,
        detail: `Saved Bitbucket app password ${connection.label} is configured.`,
      };
    }

    return null;
  });

  const resolveCredential = (operation: string) =>
    resolveStoredCredential(operation).pipe(Effect.map((stored) => stored ?? envCredential));

  const applyAuth = (
    request: HttpClientRequest.HttpClientRequest,
    credential: BitbucketCredential | null,
  ) => {
    if (!credential) return request;
    if (credential.kind === "bearer") {
      return request.pipe(HttpClientRequest.bearerToken(credential.token));
    }
    const email = Option.getOrUndefined(credential.email);
    if (email) return request.pipe(HttpClientRequest.basicAuth(email, credential.token));
    return request;
  };

  const decodeResponse = <S extends Schema.Top>(
    operation: string,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketApiError({
                operation,
                detail: "Bitbucket returned invalid JSON for the requested resource.",
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]> =>
    resolveCredential(operation).pipe(
      Effect.flatMap((credential) =>
        httpClient.execute(applyAuth(request.pipe(HttpClientRequest.acceptJson), credential)),
      ),
      Effect.mapError((cause) =>
        isBitbucketApiError(cause) ? cause : requestError(operation, cause),
      ),
      Effect.flatMap((response) => decodeResponse(operation, schema, response)),
    );

  const executeJsonWithCredential = <S extends Schema.Top>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
    credential: BitbucketCredential,
  ): Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]> =>
    httpClient.execute(applyAuth(request.pipe(HttpClientRequest.acceptJson), credential)).pipe(
      Effect.mapError((cause) => requestError(operation, cause)),
      Effect.flatMap((response) => decodeResponse(operation, schema, response)),
    );

  const executeText = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<string, BitbucketApiError> =>
    resolveCredential(operation).pipe(
      Effect.flatMap((credential) => httpClient.execute(applyAuth(request, credential))),
      Effect.mapError((cause) =>
        isBitbucketApiError(cause) ? cause : requestError(operation, cause),
      ),
      Effect.flatMap((response) =>
        HttpClientResponse.matchStatus({
          "2xx": (success) =>
            success.text.pipe(Effect.mapError((cause) => requestError(operation, cause))),
          orElse: (failed) => responseError(operation, failed),
        })(response),
      ),
    );

  const executeResponse = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, BitbucketApiError> =>
    resolveCredential(operation).pipe(
      Effect.flatMap((credential) => httpClient.execute(applyAuth(request, credential))),
      Effect.mapError((cause) =>
        isBitbucketApiError(cause) ? cause : requestError(operation, cause),
      ),
    );

  const apiBase = (() => {
    try {
      return new URL(`${config.baseUrl.replace(/\/+$/u, "")}/`);
    } catch {
      return null;
    }
  })();
  /** Credentials only follow links that stay on the configured API. */
  const isApiUrl = (url: string): boolean => {
    if (!apiBase) return false;
    try {
      const parsed = new URL(url);
      return parsed.origin === apiBase.origin && parsed.pathname.startsWith(apiBase.pathname);
    } catch {
      return false;
    }
  };

  const resolveRepository = Effect.fn("BitbucketApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    if (input.repository !== undefined) {
      const fromRepository = parseBitbucketRepositorySlug(input.repository);
      if (fromRepository) return fromRepository;
      return yield* new BitbucketApiError({
        operation: "resolveRepository",
        detail:
          "Bitbucket repositories must be specified as workspace/repository, or selected from repository search.",
      });
    }

    const fromContext =
      input.context?.provider.kind === "bitbucket"
        ? parseBitbucketRemoteUrl(input.context.remoteUrl)
        : null;
    if (fromContext) return fromContext;

    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketApiError({
            operation: "resolveRepository",
            detail: `Failed to resolve VCS repository for ${input.cwd}.`,
            cause,
          }),
      ),
    );
    const remotes = yield* handle.driver.listRemotes(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketApiError({
            operation: "resolveRepository",
            detail: `Failed to list remotes for ${input.cwd}.`,
            cause,
          }),
      ),
    );

    for (const remote of remotes.remotes) {
      if (detectSourceControlProviderFromRemoteUrl(remote.url)?.kind !== "bitbucket") continue;
      const parsed = parseBitbucketRemoteUrl(remote.url);
      if (parsed) return parsed;
    }

    return yield* new BitbucketApiError({
      operation: "resolveRepository",
      detail: `No Bitbucket repository remote was detected for ${input.cwd}.`,
    });
  });

  const getRepositoryFromLocator = (repository: BitbucketRepositoryLocator) =>
    executeJson(
      "getRepository",
      HttpClientRequest.get(
        apiUrl(
          `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}`,
        ),
      ),
      RawBitbucketRepositorySchema,
    );

  const getRepository = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) => resolveRepository(input).pipe(Effect.flatMap(getRepositoryFromLocator));

  const listAccessibleWorkspaces = Effect.fn("BitbucketApi.listAccessibleWorkspaces")(function* () {
    const workspaces = new Set<string>();
    let nextUrl: string | null = apiUrl("/user/workspaces");

    for (let page = 0; nextUrl && page < BITBUCKET_WORKSPACE_PAGE_LIMIT; page += 1) {
      const response: Schema.Schema.Type<typeof RawBitbucketWorkspaceAccessListSchema> =
        yield* executeJson(
          "listAccessibleWorkspaces",
          HttpClientRequest.get(nextUrl, page === 0 ? { urlParams: { pagelen: "50" } } : {}),
          RawBitbucketWorkspaceAccessListSchema,
        );

      for (const item of response.values) {
        workspaces.add(item.workspace.slug);
      }
      nextUrl = response.next ?? null;
    }

    return [...workspaces];
  });

  const listWorkspaceRepositories = Effect.fn("BitbucketApi.listWorkspaceRepositories")(
    function* (input: {
      readonly workspace: string;
      readonly query: string;
      readonly limit: number;
    }) {
      const repositories: Array<SourceControlRepositoryCloneUrls> = [];
      const filter = bitbucketRepositorySearchFilter(input.query);
      let nextUrl: string | null = apiUrl(`/repositories/${encodeURIComponent(input.workspace)}`);

      for (let page = 0; nextUrl && page < BITBUCKET_REPOSITORY_PAGE_LIMIT; page += 1) {
        const response: Schema.Schema.Type<typeof RawBitbucketRepositoryListSchema> =
          yield* executeJson(
            "listWorkspaceRepositories",
            HttpClientRequest.get(
              nextUrl,
              page === 0
                ? {
                    urlParams: {
                      pagelen: String(Math.min(100, Math.max(input.limit, 25))),
                      sort: "-updated_on",
                      ...(filter ? { q: filter } : {}),
                    },
                  }
                : {},
            ),
            RawBitbucketRepositoryListSchema,
          );

        repositories.push(...response.values.map(normalizeRepositoryCloneUrls));
        nextUrl = response.next ?? null;
      }

      return repositories;
    },
  );

  const searchRepositories = Effect.fn("BitbucketApi.searchRepositories")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly query?: string;
    readonly limit?: number;
  }) {
    const query = input.query?.trim() ?? "";
    const limit = repositorySearchLimit(input.limit);
    const workspaces = yield* listAccessibleWorkspaces();
    const repositoryLists = yield* Effect.all(
      workspaces.map((workspace) => listWorkspaceRepositories({ workspace, query, limit })),
      { concurrency: 4 },
    );

    return uniqueRankedRepositories({
      repositories: repositoryLists.flat(),
      query,
      limit,
    });
  });

  const cloneAuthentication = Effect.fn("BitbucketApi.cloneAuthentication")(function* (input: {
    readonly remoteUrl: string;
  }) {
    if (!isBitbucketHttpsRemoteUrl(input.remoteUrl)) return null;
    const credential = yield* resolveCredential("cloneAuthentication");
    return credential ? gitCloneAuthenticationFromCredential(credential) : null;
  });

  const getBranchingModelFromLocator = (repository: BitbucketRepositoryLocator) =>
    executeJson(
      "getBranchingModel",
      HttpClientRequest.get(
        apiUrl(
          `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/branching-model`,
        ),
      ),
      RawBitbucketBranchingModelSchema,
    );

  const getRawPullRequestFromRepository = (
    repository: BitbucketRepositoryLocator,
    reference: string,
  ) =>
    executeJson(
      "getPullRequest",
      HttpClientRequest.get(
        apiUrl(
          `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests/${encodeURIComponent(BitbucketPullRequests.normalizeBitbucketChangeRequestId(reference))}`,
        ),
      ),
      BitbucketPullRequests.BitbucketPullRequestSchema,
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

  const resolveCheckoutRemote = Effect.fn("BitbucketApi.resolveCheckoutRemote")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly destinationRepository: BitbucketRepositoryLocator;
    readonly sourceRepositoryName: string;
    readonly isCrossRepository: boolean;
  }) {
    if (
      input.context?.provider.kind === "bitbucket" &&
      !input.isCrossRepository &&
      parseBitbucketRemoteUrl(input.context.remoteUrl) !== null
    ) {
      return input.context.remoteName;
    }

    if (!input.isCrossRepository) {
      const remoteName = yield* git
        .resolvePrimaryRemoteName(input.cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (remoteName) return remoteName;
    }

    const cloneUrls = yield* getRepository({
      cwd: input.cwd,
      repository: input.sourceRepositoryName,
      ...(input.context ? { context: input.context } : {}),
    }).pipe(Effect.map(normalizeRepositoryCloneUrls));
    const originRemoteUrl = yield* readConfigValueNullable(input.cwd, "remote.origin.url");
    return yield* git.ensureRemote({
      cwd: input.cwd,
      preferredName: input.isCrossRepository
        ? repositoryOwnerName(input.sourceRepositoryName)
        : input.destinationRepository.workspace,
      url: selectCloneUrl({ cloneUrls, originRemoteUrl }),
    });
  });

  const page = makeBitbucketPullRequestPageApi({
    apiUrl,
    isApiUrl,
    executeJson,
    executeText,
    executeResponse,
    responseError,
    resolveRepository,
  });

  return BitbucketApi.of({
    probeAuth: resolveCredential("probeAuth").pipe(
      Effect.flatMap((credential) => {
        if (!credential) return Effect.succeed(unauthenticatedAuth());
        return executeJsonWithCredential(
          "probeAuth",
          HttpClientRequest.get(apiUrl("/user")),
          BitbucketUserSchema,
          credential,
        ).pipe(
          Effect.map((user) => ({
            status: "authenticated" as const,
            account: nonEmpty(user.username ?? user.display_name ?? user.account_id).pipe(
              Option.orElse(() => credential.email),
            ),
            host: Option.some("bitbucket.org"),
            detail: Option.none<string>(),
          })),
          Effect.catch((error) => Effect.succeed(failedCredentialAuthStatus(credential, error))),
        );
      }),
      Effect.catch(() =>
        Effect.succeed(
          envCredential ? credentialAuthStatus(envCredential) : authFromConfig(config),
        ),
      ),
    ),
    listPullRequests: (input) =>
      Effect.all({
        repository: resolveRepository(input),
        involvementFilters: page.involvementFilters({
          involvement: input.involvement,
          query: input.query,
        }),
      }).pipe(
        Effect.flatMap(({ repository, involvementFilters }) => {
          const states = toBitbucketStates(input.state);
          const sourceBranch = SourceControlProvider.sourceBranch(input).replaceAll('"', '\\"');
          const filters = [
            ...(sourceBranch.length > 0 ? [`source.branch.name = "${sourceBranch}"`] : []),
            bitbucketStateFilter(states),
            ...involvementFilters,
          ];
          const query: Record<string, string | ReadonlyArray<string>> = {
            pagelen: String(Math.max(1, Math.min(input.limit ?? 20, 50))),
            sort: "-updated_on",
            q: bitbucketQueryString(filters),
            state: states,
          };

          return executeJson(
            "listPullRequests",
            HttpClientRequest.get(
              apiUrl(
                `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests`,
              ),
              { urlParams: query },
            ),
            BitbucketPullRequests.BitbucketPullRequestListSchema,
          );
        }),
        Effect.map((list) =>
          list.values.map(BitbucketPullRequests.normalizeBitbucketPullRequestRecord),
        ),
      ),
    getPullRequest: (input) =>
      getRawPullRequest(input).pipe(
        Effect.map(BitbucketPullRequests.normalizeBitbucketPullRequestRecord),
      ),
    getRepositoryCloneUrls: (input) =>
      getRepository(input).pipe(Effect.map(normalizeRepositoryCloneUrls)),
    searchRepositories: (input) => searchRepositories(input),
    cloneAuthentication: (input) => cloneAuthentication(input),
    createRepository: (input) =>
      requireRepositoryLocator("createRepository", input.repository).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "createRepository",
            HttpClientRequest.post(
              apiUrl(
                `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}`,
              ),
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                scm: "git",
                is_private: input.visibility === "private",
              }),
            ),
            RawBitbucketRepositorySchema,
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketApiError({
                operation: "createPullRequest",
                detail: `Failed to read pull request body file ${input.bodyFile}.`,
                cause,
              }),
          ),
        );
        const sourceOwner = sourceWorkspace(input);
        const body = {
          title: input.title,
          description,
          source: {
            branch: {
              name: SourceControlProvider.sourceBranch(input),
            },
            ...(sourceOwner
              ? {
                  repository: {
                    full_name: `${sourceOwner}/${input.source?.repository ?? repository.repoSlug}`,
                  },
                }
              : {}),
          },
          destination: {
            branch: {
              name: input.target?.refName ?? input.baseBranch,
            },
          },
          ...(input.draft === true ? { draft: true } : {}),
        };

        yield* executeJson(
          "createPullRequest",
          HttpClientRequest.post(
            apiUrl(
              `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests`,
            ),
          ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
          BitbucketPullRequests.BitbucketPullRequestSchema,
        );
      }),
    getDefaultBranch: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((locator) =>
          Effect.all(
            {
              repository: getRepositoryFromLocator(locator),
              branchingModel: getBranchingModelFromLocator(locator).pipe(
                Effect.catch(() =>
                  Effect.succeed<typeof RawBitbucketBranchingModelSchema.Type | null>(null),
                ),
              ),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map(defaultChangeRequestTargetBranch),
      ),
    // Bitbucket Cloud pull requests are Git-backed and Bitbucket does not provide
    // an official checkout CLI. This provider-local path uses GitVcsDriver as a
    // narrow escape hatch to materialize Bitbucket PR refs. Do not generalize this
    // as the source-control provider model: if we support non-Git-compatible
    // hosting providers or native JJ/Sapling checkout flows, move this into a
    // VCS-specific change-request checkout capability.
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const destinationRepository = yield* resolveRepository(input);
        const pullRequest = yield* getRawPullRequestFromRepository(
          destinationRepository,
          input.reference,
        );
        const destinationRepositoryName =
          repositoryNameWithOwner(pullRequest.destination.repository) ??
          `${destinationRepository.workspace}/${destinationRepository.repoSlug}`;
        const sourceRepositoryName =
          repositoryNameWithOwner(pullRequest.source.repository) ?? destinationRepositoryName;
        const isCrossRepository = sourceRepositoryName !== destinationRepositoryName;
        const remoteName = yield* resolveCheckoutRemote({
          cwd: input.cwd,
          destinationRepository,
          sourceRepositoryName,
          isCrossRepository,
          ...(input.context ? { context: input.context } : {}),
        });
        const remoteBranch = pullRequest.source.branch.name;
        const localBranch = checkoutBranchName({
          pullRequestId: pullRequest.id,
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
          isBitbucketApiError(cause)
            ? cause
            : new BitbucketApiError({
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
        Effect.flatMap((repo) => {
          const states = toBitbucketIssueStates(input.state);
          const query: Record<string, string | ReadonlyArray<string>> = {
            pagelen: String(Math.max(1, Math.min(input.limit ?? 50, 50))),
            sort: "-updated_on",
            ...(states.length > 0 ? { state: states } : {}),
          };
          const path = `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}/issues`;
          return executeJson(
            "listIssues",
            HttpClientRequest.get(apiUrl(path), { urlParams: query }),
            BitbucketIssues.BitbucketIssueListSchema,
          ).pipe(
            Effect.map((value) => value.values.map(BitbucketIssues.normalizeBitbucketIssueRecord)),
            Effect.catch((err) =>
              isBitbucketApiError(err) && err.status === 404
                ? Effect.succeed([])
                : Effect.fail(err),
            ),
          );
        }),
      ),
    getIssue: (input) => {
      const referenceId = normalizeIssueId(input.reference);
      return resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) => {
          const issuePath = `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}/issues/${encodeURIComponent(referenceId)}`;
          const issue = executeJson(
            "getIssue",
            HttpClientRequest.get(apiUrl(issuePath)),
            BitbucketIssues.BitbucketIssueSchema,
          );
          // pagelen is clamped per Bitbucket Cloud's [1, 100] limit; we fetch
          // 6 newest so truncateSourceControlDetailContent can emit a "truncated"
          // signal when the thread has more than 5 comments.
          const comments = executeJson(
            "getIssueComments",
            HttpClientRequest.get(apiUrl(`${issuePath}/comments`), {
              urlParams: { pagelen: "6", sort: "-created_on" },
            }),
            BitbucketIssues.BitbucketCommentListSchema,
          ).pipe(
            Effect.map((list) => BitbucketIssues.normalizeBitbucketCommentList(list).toReversed()),
            Effect.catch((err) =>
              isBitbucketApiError(err) && err.status === 404
                ? Effect.succeed([])
                : Effect.fail(err),
            ),
          );
          return Effect.all([issue, comments], { concurrency: 2 }).pipe(
            Effect.map(([rawIssue, normalizedComments]) => {
              const summary = BitbucketIssues.normalizeBitbucketIssueRecord(rawIssue);
              return {
                ...summary,
                body: rawIssue.content?.raw ?? "",
                comments: normalizedComments,
              };
            }),
          );
        }),
      );
    },
    searchIssues: (input) =>
      resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) => {
          const escaped = input.query.replace(/"/g, '\\"');
          const query: Record<string, string | ReadonlyArray<string>> = {
            q: `title ~ "${escaped}"`,
            pagelen: String(Math.max(1, Math.min(input.limit ?? 20, 50))),
            sort: "-updated_on",
          };
          const path = `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}/issues`;
          return executeJson(
            "searchIssues",
            HttpClientRequest.get(apiUrl(path), { urlParams: query }),
            BitbucketIssues.BitbucketIssueListSchema,
          ).pipe(
            Effect.map((value) => value.values.map(BitbucketIssues.normalizeBitbucketIssueRecord)),
            Effect.catch((err) =>
              isBitbucketApiError(err) && err.status === 404
                ? Effect.succeed([])
                : Effect.fail(err),
            ),
          );
        }),
      ),
    searchPullRequests: (input) =>
      resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) => {
          const escaped = input.query.replace(/"/g, '\\"');
          const query: Record<string, string | ReadonlyArray<string>> = {
            q: `title ~ "${escaped}"`,
            pagelen: String(Math.max(1, Math.min(input.limit ?? 20, 50))),
            sort: "-updated_on",
          };
          const path = `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}/pullrequests`;
          return executeJson(
            "searchPullRequests",
            HttpClientRequest.get(apiUrl(path), { urlParams: query }),
            BitbucketPullRequests.BitbucketPullRequestListSchema,
          ).pipe(
            Effect.map((list) =>
              list.values.map(BitbucketPullRequests.normalizeBitbucketPullRequestRecord),
            ),
            Effect.catch((err) =>
              isBitbucketApiError(err) && err.status === 404
                ? Effect.succeed([])
                : Effect.fail(err),
            ),
          );
        }),
      ),
    getPullRequestDetail: (input) => {
      const referenceId = BitbucketPullRequests.normalizeBitbucketChangeRequestId(input.reference);
      return resolveRepository({
        cwd: input.cwd,
        ...(input.context ? { context: input.context } : {}),
      }).pipe(
        Effect.flatMap((repo) => {
          const prPath = `/repositories/${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}/pullrequests/${encodeURIComponent(referenceId)}`;
          const pr = executeJson(
            "getPullRequestDetail",
            HttpClientRequest.get(apiUrl(prPath)),
            BitbucketPullRequests.BitbucketPullRequestDetailSchema,
          );
          const comments = executeJson(
            "getPullRequestComments",
            HttpClientRequest.get(apiUrl(`${prPath}/comments`), {
              urlParams: { pagelen: "6", sort: "-created_on" },
            }),
            BitbucketIssues.BitbucketCommentListSchema,
          ).pipe(
            Effect.map((list) => BitbucketIssues.normalizeBitbucketCommentList(list).toReversed()),
            Effect.catch((err) =>
              isBitbucketApiError(err) && err.status === 404
                ? Effect.succeed([])
                : Effect.fail(err),
            ),
          );
          return Effect.all([pr, comments], { concurrency: 2 }).pipe(
            Effect.flatMap(([raw, normalizedComments]) =>
              page.getPullRequestPageDetail(repo, prPath, raw).pipe(
                Effect.map((enrichment) => ({
                  ...BitbucketPullRequests.normalizeBitbucketPullRequestDetailRecord(
                    raw,
                    normalizedComments,
                  ),
                  ...enrichment,
                })),
              ),
            ),
          );
        }),
      );
    },
    getPullRequestDiff: (input) => page.getPullRequestDiff(input),
    getPullRequestState: (input) =>
      getRawPullRequest(input).pipe(
        Effect.map((raw) => {
          const record = BitbucketPullRequests.normalizeBitbucketPullRequestRecord(raw);
          return { state: record.state, isDraft: record.isDraft ?? false };
        }),
      ),
    listAssignees: (input) =>
      page.listWorkspaceMembers(input).pipe(Effect.map((members) => members.candidates)),
    getPullRequestActivity: page.getPullRequestActivity,
    getPullRequestFileContents: page.getPullRequestFileContents,
    addPullRequestComment: page.addPullRequestComment,
    updatePullRequestComment: page.updatePullRequestComment,
    replyToPullRequestThread: page.replyToPullRequestThread,
    setPullRequestThreadResolved: page.setPullRequestThreadResolved,
    submitPullRequestReview: page.submitPullRequestReview,
    updatePullRequest: page.updatePullRequest,
    mergePullRequest: page.mergePullRequest,
  });
});

export const layer = Layer.effect(BitbucketApi, make());
