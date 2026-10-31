import * as NodeOS from "node:os";
import { Context, Effect, FileSystem, Layer, Path, Schema, Scope } from "effect";

import {
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
  type SourceControlRepositorySearchInput,
  type SourceControlRepositorySearchResult,
} from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import { RestartSensitiveWork } from "../updates/restartSensitiveWork.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

/** The clone runner stays off the boot path: it loads with the first clone. */
const loadGitCloneRun = Effect.promise(() => import("./gitCloneRun.ts"));

export interface SourceControlRepositoryServiceShape {
  readonly lookupRepository: (
    input: SourceControlRepositoryLookupInput,
  ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
  readonly searchRepositories: (
    input: SourceControlRepositorySearchInput,
  ) => Effect.Effect<SourceControlRepositorySearchResult, SourceControlRepositoryError>;
  readonly cloneRepository: (
    input: SourceControlCloneRepositoryInput,
  ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
  readonly publishRepository: (
    input: SourceControlPublishRepositoryInput,
  ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
}

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  SourceControlRepositoryServiceShape
>()("ryco/source-control/SourceControlRepositoryService") {}

function detailFromUnknown(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    if ("detail" in cause && typeof cause.detail === "string" && cause.detail.length > 0) {
      return cause.detail;
    }
    if ("message" in cause && typeof cause.message === "string" && cause.message.length > 0) {
      return cause.message;
    }
  }

  return "An unexpected source control error occurred.";
}

function repositoryError(input: {
  readonly operation: string;
  readonly provider: SourceControlProviderKind;
  readonly detail: string;
  readonly cause?: unknown;
}): SourceControlRepositoryError {
  return new SourceControlRepositoryError({
    provider: input.provider,
    operation: input.operation,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    Schema.is(SourceControlRepositoryError)(cause)
      ? cause
      : repositoryError({
          operation,
          provider,
          detail: detailFromUnknown(cause),
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

function isBareRepositoryReference(repository: string): boolean {
  return !repository.includes("/") && !repository.includes(":");
}

function repositorySlug(nameWithOwner: string): string {
  return nameWithOwner.split("/").at(-1)?.trim() ?? nameWithOwner;
}

function exactBareRepositoryMatches(
  repositories: ReadonlyArray<SourceControlRepositoryCloneUrls>,
  repository: string,
): ReadonlyArray<SourceControlRepositoryCloneUrls> {
  const normalized = repository.trim().toLowerCase();
  return repositories.filter(
    (item) =>
      item.nameWithOwner.toLowerCase() === normalized ||
      repositorySlug(item.nameWithOwner).toLowerCase() === normalized,
  );
}

function selectSingleRepositorySearchMatch(input: {
  readonly repositories: ReadonlyArray<SourceControlRepositoryCloneUrls>;
  readonly repository: string;
}): SourceControlRepositoryCloneUrls | null {
  const exactMatches = exactBareRepositoryMatches(input.repositories, input.repository);
  const candidates = exactMatches.length > 0 ? exactMatches : input.repositories;
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function defaultCloneProtocol(input: {
  readonly requestedProtocol?: SourceControlCloneProtocol;
  readonly provider?: SourceControlProvider.SourceControlProviderShape | null;
}): SourceControlCloneProtocol | undefined {
  if (input.requestedProtocol) return input.requestedProtocol;
  return input.provider?.cloneAuthentication ? "https" : undefined;
}

const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\\n' "$RYCO_GIT_USERNAME" ;;
  *) printf '%s\\n' "$RYCO_GIT_PASSWORD" ;;
esac
`;

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

function isScpStyleGitUrl(input: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(input);
}

function validateCloneRemoteUrl(
  remoteUrl: string,
  provider: SourceControlProviderKind,
): Effect.Effect<string, SourceControlRepositoryError> {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) {
    return Effect.fail(
      repositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a valid repository URL before cloning.",
      }),
    );
  }

  if (isScpStyleGitUrl(trimmed)) {
    return Effect.succeed(trimmed);
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "ssh:") {
      return Effect.succeed(trimmed);
    }
  } catch {
    // Fall through to the validation error below.
  }

  return Effect.fail(
    repositoryError({
      operation: "cloneRepository",
      provider,
      detail: "Clone URL must use https://, ssh://, or git@host:owner/repo.git syntax.",
    }),
  );
}

function isHttpsCloneUrl(remoteUrl: string): boolean {
  try {
    return new URL(remoteUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function removeUrlCredentials(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

export const make = Effect.fn("makeSourceControlRepositoryService")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;
  const restartWork = yield* RestartSensitiveWork;
  // Clones outlive the request that started them (see gitCloneRun.ts); they live as long as
  // this service, and the registry is built with the first clone.
  const serviceScope = yield* Effect.scope;
  const cloneJobs = yield* Effect.cached(
    loadGitCloneRun.pipe(
      Effect.flatMap((cloneRun) => cloneRun.makeCloneJobs),
      Scope.provide(serviceScope),
    ),
  );

  const authorizeExistingPath = (operation: string, candidate: string) =>
    workspaceAccessPolicy
      .assertExistingPath({
        path: candidate,
        operation,
      })
      .pipe(
        Effect.mapError((cause) =>
          repositoryError({
            operation,
            provider: "unknown",
            detail: cause.message,
            cause,
          }),
        ),
      );

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      repositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const resolveRepositoryCloneUrls = Effect.fn(
    "SourceControlRepositoryService.resolveRepositoryCloneUrls",
  )(function* (input: {
    readonly operation: string;
    readonly providerKind: Exclude<SourceControlProviderKind, "unknown">;
    readonly provider: SourceControlProvider.SourceControlProviderShape;
    readonly cwd: string;
    readonly repository: string;
  }) {
    const repository = input.repository.trim();
    if (isBareRepositoryReference(repository) && input.provider.searchRepositories) {
      const matches = yield* input.provider.searchRepositories({
        cwd: input.cwd,
        query: repository,
        limit: 10,
      });
      const match = selectSingleRepositorySearchMatch({ repositories: matches, repository });
      if (match) return match;
      if (matches.length > 1) {
        return yield* repositoryError({
          operation: input.operation,
          provider: input.providerKind,
          detail: `Multiple ${input.providerKind} repositories match "${repository}". Select one from the repository list or enter the full workspace/repository name.`,
        });
      }
    }

    return yield* input.provider.getRepositoryCloneUrls({
      cwd: input.cwd,
      repository,
    });
  });

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const cwd = yield* authorizeExistingPath("lookupRepository", input.cwd ?? config.cwd);
    const urls = yield* resolveRepositoryCloneUrls({
      operation: "lookupRepository",
      providerKind,
      provider,
      cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const searchRepositories = Effect.fn("SourceControlRepositoryService.searchRepositories")(
    function* (input: SourceControlRepositorySearchInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "searchRepositories",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      if (!provider.searchRepositories) {
        return yield* repositoryError({
          operation: "searchRepositories",
          provider: providerKind,
          detail: `${providerKind} repository search is not implemented yet.`,
        });
      }

      const cwd = yield* authorizeExistingPath("searchRepositories", input.cwd ?? config.cwd);
      const urls = yield* provider.searchRepositories({
        cwd,
        ...(input.query !== undefined ? { query: input.query.trim() } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { repositories: urls.map((item) => toRepositoryInfo(providerKind, item)) };
    },
  );

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* repositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, path));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      const authorizedDestination = yield* workspaceAccessPolicy
        .assertPath({
          path: normalizedDestination,
          operation: "cloneRepository",
        })
        .pipe(
          Effect.mapError((cause) =>
            repositoryError({
              operation: "cloneRepository",
              provider: "unknown",
              detail: cause.message,
              cause,
            }),
          ),
        );
      yield* fileSystem.makeDirectory(path.dirname(authorizedDestination), { recursive: true });

      return {
        destinationPath: authorizedDestination,
        parentPath: path.dirname(authorizedDestination),
        directoryName: path.basename(authorizedDestination),
      };
    },
  );

  // The full check runs inside the clone, so the same request again can join a running clone
  // or get the outcome of a finished one instead of failing on the destination it filled.
  // Before the provider lookup, `unlessRepository` fails fast for a destination that cannot be
  // one: neither a running clone nor a kept outcome is answered without `<dest>/.git`.
  const assertDestinationEmpty = Effect.fn("SourceControlRepositoryService.assertDestinationEmpty")(
    function* (destinationPath: string, options?: { readonly unlessRepository?: boolean }) {
      if (!(yield* fileSystem.exists(destinationPath).pipe(Effect.orElseSucceed(() => false)))) {
        return;
      }
      const entries = yield* fileSystem.readDirectory(destinationPath, { recursive: false }).pipe(
        Effect.mapError((cause) =>
          repositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not a directory.",
            cause,
          }),
        ),
      );
      if (entries.length > 0 && !(options?.unlessRepository === true && entries.includes(".git"))) {
        return yield* repositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Destination path already exists and is not empty.",
        });
      }
    },
  );

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    yield* assertDestinationEmpty(preparedDestination.destinationPath, { unlessRepository: true });
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";
    let cloneProvider: SourceControlProvider.SourceControlProviderShape | null = null;

    if (input.provider && input.repository) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "cloneRepository",
        provider: input.provider,
      });
      cloneProvider = yield* providers.get(providerKind);
      const urls = yield* resolveRepositoryCloneUrls({
        operation: "cloneRepository",
        providerKind,
        provider: cloneProvider,
        cwd: preparedDestination.parentPath,
        repository: input.repository.trim(),
      });
      repository = toRepositoryInfo(providerKind, urls);
      remoteUrl = selectRemoteUrl(
        urls,
        defaultCloneProtocol({
          provider: cloneProvider,
          ...(input.protocol !== undefined ? { requestedProtocol: input.protocol } : {}),
        }),
      );
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* repositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    const validatedRemoteUrl = yield* validateCloneRemoteUrl(remoteUrl, provider);
    if (!cloneProvider && isHttpsCloneUrl(validatedRemoteUrl)) {
      const detectedProvider = providers.detectProviderFromRemoteUrl(validatedRemoteUrl);
      if (detectedProvider?.kind && detectedProvider.kind !== "unknown") {
        cloneProvider = yield* providers.get(detectedProvider.kind);
        provider = detectedProvider.kind;
      }
    }
    const cloneAuthentication =
      cloneProvider?.cloneAuthentication && isHttpsCloneUrl(validatedRemoteUrl)
        ? yield* cloneProvider.cloneAuthentication({ remoteUrl: validatedRemoteUrl })
        : null;
    const cloneRemoteUrl = cloneAuthentication
      ? removeUrlCredentials(validatedRemoteUrl)
      : validatedRemoteUrl;

    const cloneRun = yield* loadGitCloneRun;
    const jobs = yield* cloneJobs;
    return yield* jobs.runOrJoin({
      key: yield* cloneRun.cloneJobKey(preparedDestination, cloneRemoteUrl),
      destinationPath: preparedDestination.destinationPath,
      clone: cloneRun
        .cloneIntoDestination({
          git,
          destination: preparedDestination,
          remoteUrl: cloneRemoteUrl,
          provider,
          checkDestination: assertDestinationEmpty(preparedDestination.destinationPath),
          allowStagingAt: (stagingPath) =>
            workspaceAccessPolicy
              .assertPath({ path: stagingPath, operation: "cloneRepository" })
              .pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              ),
          withCredentials: (use) =>
            cloneAuthentication
              ? Effect.scoped(
                  Effect.gen(function* () {
                    const askpassDir = yield* fileSystem.makeTempDirectoryScoped({
                      prefix: "ryco-git-askpass-",
                    });
                    const askpassPath = path.join(askpassDir, "askpass.sh");
                    yield* fileSystem.writeFileString(askpassPath, GIT_ASKPASS_SCRIPT);
                    yield* fileSystem.chmod(askpassPath, 0o700);
                    return yield* use({
                      GIT_ASKPASS: askpassPath,
                      GIT_TERMINAL_PROMPT: "0",
                      RYCO_GIT_USERNAME: cloneAuthentication.username,
                      RYCO_GIT_PASSWORD: cloneAuthentication.password,
                    });
                  }),
                ).pipe(mapRepositoryError("cloneRepository", provider))
              : use(undefined),
        })
        .pipe(
          Effect.andThen(
            authorizeExistingPath("cloneRepository", preparedDestination.destinationPath),
          ),
          Effect.map((clonedPath) => ({
            cwd: clonedPath,
            remoteUrl: cloneRemoteUrl,
            repository,
          })),
          // The clone runs detached for as long as this, so a restart waits for all of it.
          restartWork.track,
        ),
    });
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const cwd = yield* authorizeExistingPath("publishRepository", input.cwd);
      const urls = yield* provider.createRepository({
        cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
      if (!hasCommits) {
        const details = yield* git
          .statusDetails(cwd)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    searchRepositories: (input) =>
      searchRepositories(input).pipe(mapRepositoryError("searchRepositories", input.provider)),
    cloneRepository: (input) =>
      cloneRepository(input).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make());
