import { Cache, Context, Duration, Effect, Exit, FileSystem, Layer } from "effect";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
  type SourceControlProviderInfo,
} from "@ryco/contracts";
import type { SourceControlProviderKind } from "@ryco/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@ryco/shared/sourceControl";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as ForgejoApi from "./ForgejoApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  azureDevOpsDiscovery,
  githubDiscovery,
  gitlabDiscovery,
  makeBitbucketDiscovery,
  makeForgejoDiscovery,
} from "./SourceControlProviderDiscoveryCatalog.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";
import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);

interface LazyProviderOptions {
  readonly searchRepositories?: boolean;
  readonly cloneAuthentication?: boolean;
}

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProviderShape;
  readonly discovery: SourceControlProviderDiscovery.SourceControlProviderDiscoverySpec;
  readonly detectProviderFromRemoteUrl?: (remoteUrl: string) => SourceControlProviderInfo | null;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProviderShape;
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
}

export interface SourceControlProviderRegistryShape {
  readonly get: (
    kind: SourceControlProviderKind,
  ) => Effect.Effect<SourceControlProvider.SourceControlProviderShape, SourceControlProviderError>;
  readonly resolveHandle: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
  readonly resolve: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProvider.SourceControlProviderShape, SourceControlProviderError>;
  readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
  readonly detectProviderFromRemoteUrl: (remoteUrl: string) => SourceControlProviderInfo | null;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  SourceControlProviderRegistryShape
>()("ryco/source-control/SourceControlProviderRegistry") {}

function unsupportedProviderOperation(kind: SourceControlProviderKind, operation: string) {
  return Effect.fail(
    new SourceControlProviderError({
      provider: kind,
      operation,
      detail: `No ${kind} source control provider is registered.`,
    }),
  );
}

function unsupportedWorkflowOperation(kind: SourceControlProviderKind, operation: string) {
  return Effect.fail(
    new SourceControlProviderError({
      provider: kind,
      operation,
      detail: `Workflow status is not available for ${kind} repositories.`,
    }),
  );
}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProviderShape {
  const unsupported = (operation: string) => unsupportedProviderOperation(kind, operation);

  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => unsupported("getRepositoryCloneUrls"),
    createRepository: () => unsupported("createRepository"),
    getDefaultBranch: () => unsupported("getDefaultBranch"),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    listIssues: () => unsupported("listIssues"),
    getIssue: () => unsupported("getIssue"),
    addIssueComment: () => unsupported("addIssueComment"),
    addIssueCommentReaction: () => unsupported("addIssueCommentReaction"),
    searchIssues: () => unsupported("searchIssues"),
    searchChangeRequests: () => unsupported("searchChangeRequests"),
    getChangeRequestDetail: () => unsupported("getChangeRequestDetail"),
    addChangeRequestComment: () => unsupported("addChangeRequestComment"),
    addChangeRequestCommentReaction: () => unsupported("addChangeRequestCommentReaction"),
    getChangeRequestDiff: () => unsupported("getChangeRequestDiff"),
    createIssue: () => unsupported("createIssue"),
    listLabels: () => unsupported("listLabels"),
    listAssignees: () => unsupported("listAssignees"),
    getPullRequestState: () => unsupported("getPullRequestState"),
    getIssueState: () => unsupported("getIssueState"),
    listWorkflowRuns: () => unsupportedWorkflowOperation(kind, "listWorkflowRuns"),
    getWorkflowRunJobs: () => unsupportedWorkflowOperation(kind, "getWorkflowRunJobs"),
    getWorkflowJobLog: () => unsupportedWorkflowOperation(kind, "getWorkflowJobLog"),
    rerunWorkflow: () => unsupportedWorkflowOperation(kind, "rerunWorkflow"),
  });
}

function providerDetectionError(operation: string, cwd: string, cause: unknown) {
  return new SourceControlProviderError({
    provider: "unknown",
    operation,
    detail: `Failed to detect source control provider for ${cwd}.`,
    cause,
  });
}

function providerLoadError(kind: SourceControlProviderKind, cause: unknown) {
  return new SourceControlProviderError({
    provider: kind,
    operation: "loadProvider",
    detail: `Failed to load ${kind} source control provider.`,
    cause,
  });
}

const makeLazyProvider = Effect.fn("makeLazySourceControlProvider")(function* (
  kind: SourceControlProviderKind,
  load: Effect.Effect<SourceControlProvider.SourceControlProviderShape, SourceControlProviderError>,
  options: LazyProviderOptions = {},
) {
  const provider = yield* Effect.cached(load);

  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.listChangeRequests(input))),
    getChangeRequest: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.getChangeRequest(input))),
    createChangeRequest: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.createChangeRequest(input))),
    getRepositoryCloneUrls: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.getRepositoryCloneUrls(input))),
    ...(options.searchRepositories
      ? {
          searchRepositories: (input) =>
            provider.pipe(
              Effect.flatMap((loaded) => {
                const method = loaded.searchRepositories;
                return method
                  ? method(input)
                  : unsupportedProviderOperation(kind, "searchRepositories");
              }),
            ),
        }
      : {}),
    ...(options.cloneAuthentication
      ? {
          cloneAuthentication: (input) =>
            provider.pipe(
              Effect.flatMap((loaded) => {
                const method = loaded.cloneAuthentication;
                return method
                  ? method(input)
                  : unsupportedProviderOperation(kind, "cloneAuthentication");
              }),
            ),
        }
      : {}),
    createRepository: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.createRepository(input))),
    getDefaultBranch: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.getDefaultBranch(input))),
    checkoutChangeRequest: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.checkoutChangeRequest(input))),
    listIssues: (input) => provider.pipe(Effect.flatMap((loaded) => loaded.listIssues(input))),
    getIssue: (input) => provider.pipe(Effect.flatMap((loaded) => loaded.getIssue(input))),
    addIssueComment: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.addIssueComment(input))),
    addIssueCommentReaction: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.addIssueCommentReaction(input))),
    searchIssues: (input) => provider.pipe(Effect.flatMap((loaded) => loaded.searchIssues(input))),
    searchChangeRequests: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.searchChangeRequests(input))),
    getChangeRequestDetail: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.getChangeRequestDetail(input))),
    addChangeRequestComment: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.addChangeRequestComment(input))),
    addChangeRequestCommentReaction: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.addChangeRequestCommentReaction(input))),
    getChangeRequestFilesViewed: (input) =>
      provider.pipe(
        Effect.flatMap((loaded) =>
          loaded.getChangeRequestFilesViewed
            ? loaded.getChangeRequestFilesViewed(input)
            : Effect.succeed({
                provider: kind,
                capability: { storage: "unsupported" as const },
                headSha: null,
                files: [],
              }),
        ),
      ),
    setChangeRequestFileViewed: (input) =>
      provider.pipe(
        Effect.flatMap((loaded) =>
          loaded.setChangeRequestFileViewed
            ? loaded.setChangeRequestFileViewed(input)
            : Effect.fail(
                new SourceControlProviderError({
                  provider: kind,
                  operation: "setChangeRequestFileViewed",
                  detail: "Viewed files are not supported by this provider.",
                }),
              ),
        ),
      ),
    getChangeRequestDiff: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.getChangeRequestDiff(input))),
    createIssue: (input) => provider.pipe(Effect.flatMap((loaded) => loaded.createIssue(input))),
    listLabels: (input) => provider.pipe(Effect.flatMap((loaded) => loaded.listLabels(input))),
    listAssignees: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.listAssignees(input))),
    getPullRequestState: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.getPullRequestState(input))),
    getIssueState: (input) =>
      provider.pipe(Effect.flatMap((loaded) => loaded.getIssueState(input))),
    listWorkflowRuns: (input) =>
      provider.pipe(
        Effect.flatMap((loaded) => {
          const method = loaded.listWorkflowRuns;
          return method ? method(input) : unsupportedWorkflowOperation(kind, "listWorkflowRuns");
        }),
      ),
    getWorkflowRunJobs: (input) =>
      provider.pipe(
        Effect.flatMap((loaded) => {
          const method = loaded.getWorkflowRunJobs;
          return method ? method(input) : unsupportedWorkflowOperation(kind, "getWorkflowRunJobs");
        }),
      ),
    getWorkflowJobLog: (input) =>
      provider.pipe(
        Effect.flatMap((loaded) => {
          const method = loaded.getWorkflowJobLog;
          return method ? method(input) : unsupportedWorkflowOperation(kind, "getWorkflowJobLog");
        }),
      ),
    rerunWorkflow: (input) =>
      provider.pipe(
        Effect.flatMap((loaded) => {
          const method = loaded.rerunWorkflow;
          return method ? method(input) : unsupportedWorkflowOperation(kind, "rerunWorkflow");
        }),
      ),
  });
});

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>,
  detectProvider: (remoteUrl: string) => SourceControlProviderInfo | null,
): SourceControlProvider.SourceControlProviderContext | null {
  const candidates = remotes
    .map((remote) => {
      const provider = detectProvider(remote.url);
      return provider
        ? {
            provider,
            remoteName: remote.name,
            remoteUrl: remote.url,
          }
        : null;
    })
    .filter((value): value is SourceControlProvider.SourceControlProviderContext => value !== null);

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
    candidates[0] ??
    null
  );
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProviderShape,
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProviderShape {
  if (context === null) {
    return provider;
  }

  return SourceControlProvider.SourceControlProvider.of({
    kind: provider.kind,
    listChangeRequests: (input) =>
      provider.listChangeRequests({
        ...input,
        context: input.context ?? context,
      }),
    getChangeRequest: (input) =>
      provider.getChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    createChangeRequest: (input) =>
      provider.createChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    getRepositoryCloneUrls: (input) =>
      provider.getRepositoryCloneUrls({
        ...input,
        context: input.context ?? context,
      }),
    ...(provider.searchRepositories
      ? {
          searchRepositories: (input) => {
            const method = provider.searchRepositories;
            if (!method) return unsupportedProviderOperation(provider.kind, "searchRepositories");
            return method({
              ...input,
              context: input.context ?? context,
            });
          },
        }
      : {}),
    ...(provider.cloneAuthentication
      ? {
          cloneAuthentication: (input) => {
            const method = provider.cloneAuthentication;
            if (!method) return unsupportedProviderOperation(provider.kind, "cloneAuthentication");
            return method(input);
          },
        }
      : {}),
    createRepository: (input) => provider.createRepository(input),
    getDefaultBranch: (input) =>
      provider.getDefaultBranch({
        ...input,
        context: input.context ?? context,
      }),
    checkoutChangeRequest: (input) =>
      provider.checkoutChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    listIssues: (input) =>
      provider.listIssues({
        ...input,
        context: input.context ?? context,
      }),
    getIssue: (input) =>
      provider.getIssue({
        ...input,
        context: input.context ?? context,
      }),
    addIssueComment: (input) =>
      provider.addIssueComment({
        ...input,
        context: input.context ?? context,
      }),
    addIssueCommentReaction: (input) =>
      provider.addIssueCommentReaction({
        ...input,
        context: input.context ?? context,
      }),
    searchIssues: (input) =>
      provider.searchIssues({
        ...input,
        context: input.context ?? context,
      }),
    searchChangeRequests: (input) =>
      provider.searchChangeRequests({
        ...input,
        context: input.context ?? context,
      }),
    getChangeRequestDetail: (input) =>
      provider.getChangeRequestDetail({
        ...input,
        context: input.context ?? context,
      }),
    addChangeRequestComment: (input) =>
      provider.addChangeRequestComment({
        ...input,
        context: input.context ?? context,
      }),
    addChangeRequestCommentReaction: (input) =>
      provider.addChangeRequestCommentReaction({
        ...input,
        context: input.context ?? context,
      }),
    ...(provider.getChangeRequestFilesViewed
      ? {
          getChangeRequestFilesViewed: (
            input: Parameters<
              NonNullable<
                SourceControlProvider.SourceControlProviderShape["getChangeRequestFilesViewed"]
              >
            >[0],
          ) =>
            provider.getChangeRequestFilesViewed!({ ...input, context: input.context ?? context }),
        }
      : {}),
    ...(provider.setChangeRequestFileViewed
      ? {
          setChangeRequestFileViewed: (
            input: Parameters<
              NonNullable<
                SourceControlProvider.SourceControlProviderShape["setChangeRequestFileViewed"]
              >
            >[0],
          ) =>
            provider.setChangeRequestFileViewed!({ ...input, context: input.context ?? context }),
        }
      : {}),
    getChangeRequestDiff: (input) =>
      provider.getChangeRequestDiff({
        ...input,
        context: input.context ?? context,
      }),
    createIssue: (input) =>
      provider.createIssue({
        ...input,
        context: input.context ?? context,
      }),
    listLabels: (input) =>
      provider.listLabels({
        ...input,
        context: input.context ?? context,
      }),
    listAssignees: (input) =>
      provider.listAssignees({
        ...input,
        context: input.context ?? context,
      }),
    getPullRequestState: (input) =>
      provider.getPullRequestState({
        ...input,
        context: input.context ?? context,
      }),
    getIssueState: (input) =>
      provider.getIssueState({
        ...input,
        context: input.context ?? context,
      }),
    ...(provider.listWorkflowRuns
      ? {
          listWorkflowRuns: (input) => {
            const method = provider.listWorkflowRuns;
            if (!method) return unsupportedWorkflowOperation(provider.kind, "listWorkflowRuns");
            return method({
              ...input,
              context: input.context ?? context,
            });
          },
        }
      : {}),
    ...(provider.getWorkflowRunJobs
      ? {
          getWorkflowRunJobs: (input) => {
            const method = provider.getWorkflowRunJobs;
            if (!method) return unsupportedWorkflowOperation(provider.kind, "getWorkflowRunJobs");
            return method({
              ...input,
              context: input.context ?? context,
            });
          },
        }
      : {}),
    ...(provider.getWorkflowJobLog
      ? {
          getWorkflowJobLog: (input) => {
            const method = provider.getWorkflowJobLog;
            if (!method) return unsupportedWorkflowOperation(provider.kind, "getWorkflowJobLog");
            return method({
              ...input,
              context: input.context ?? context,
            });
          },
        }
      : {}),
    ...(provider.rerunWorkflow
      ? {
          rerunWorkflow: (input) => {
            const method = provider.rerunWorkflow;
            if (!method) return unsupportedWorkflowOperation(provider.kind, "rerunWorkflow");
            return method({
              ...input,
              context: input.context ?? context,
            });
          },
        }
      : {}),
  });
}

export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig;
    const process = yield* VcsProcess.VcsProcess;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProviderShape
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);
    const dynamicDetectors = registrations
      .map((registration) => registration.detectProviderFromRemoteUrl)
      .filter(
        (detector): detector is (remoteUrl: string) => SourceControlProviderInfo | null =>
          detector !== undefined,
      );

    const get: SourceControlProviderRegistryShape["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const detectProviderFromRemoteUrl: SourceControlProviderRegistryShape["detectProviderFromRemoteUrl"] =
      (remoteUrl) => {
        const staticProvider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
        if (staticProvider && staticProvider.kind !== "unknown") {
          return staticProvider;
        }

        for (const detector of dynamicDetectors) {
          const provider = detector(remoteUrl);
          if (provider && provider.kind !== "unknown") {
            return provider;
          }
        }

        return staticProvider;
      };

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
        const handle = yield* vcsRegistry
          .resolve({ cwd })
          .pipe(Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)));
        const remotes = yield* handle.driver
          .listRemotes(cwd)
          .pipe(Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)));
        const context = selectProviderContext(remotes.remotes, detectProviderFromRemoteUrl);

        return yield* SourceControlProviderDiscovery.refineUnknownRemoteProvider({
          specs: discoverySpecs,
          process,
          cwd,
          context,
        });
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    const resolveHandle: SourceControlProviderRegistryShape["resolveHandle"] = (input) =>
      Cache.get(providerContextCache, input.cwd).pipe(
        Effect.map((context) => {
          const kind = context?.provider.kind ?? "unknown";
          const provider = providers.get(kind) ?? unsupportedProvider(kind);
          return {
            provider: bindProviderContext(provider, context),
            context,
          } satisfies SourceControlProviderHandle;
        }),
      );

    return SourceControlProviderRegistry.of({
      get,
      detectProviderFromRemoteUrl,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
      discover: Effect.all(
        discoverySpecs.map((spec) =>
          SourceControlProviderDiscovery.probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
          }),
        ),
        { concurrency: "unbounded" },
      ),
    });
  },
);

export const make = Effect.fn("makeSourceControlProviderRegistry")(function* () {
  const githubCli = yield* GitHubCli.GitHubCli;
  const gitlabCli = yield* GitLabCli.GitLabCli;
  const bitbucketApi = yield* BitbucketApi.BitbucketApi;
  const forgejoApi = yield* ForgejoApi.ForgejoApi;
  const azureDevOpsCli = yield* AzureDevOpsCli.AzureDevOpsCli;
  const fileSystem = yield* FileSystem.FileSystem;

  const github = yield* makeLazyProvider(
    "github",
    Effect.tryPromise({
      try: () => import("./GitHubSourceControlProvider.ts"),
      catch: (cause) => providerLoadError("github", cause),
    }).pipe(
      Effect.flatMap((module) => module.make()),
      Effect.provideService(GitHubCli.GitHubCli, githubCli),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    ),
  );

  const gitlab = yield* makeLazyProvider(
    "gitlab",
    Effect.tryPromise({
      try: () => import("./GitLabSourceControlProvider.ts"),
      catch: (cause) => providerLoadError("gitlab", cause),
    }).pipe(
      Effect.flatMap((module) => module.make()),
      Effect.provideService(GitLabCli.GitLabCli, gitlabCli),
    ),
  );

  const bitbucket = yield* makeLazyProvider(
    "bitbucket",
    Effect.tryPromise({
      try: () => import("./BitbucketSourceControlProvider.ts"),
      catch: (cause) => providerLoadError("bitbucket", cause),
    }).pipe(
      Effect.flatMap((module) => module.make()),
      Effect.provideService(BitbucketApi.BitbucketApi, bitbucketApi),
    ),
    { searchRepositories: true, cloneAuthentication: true },
  );

  const forgejo = yield* makeLazyProvider(
    "forgejo",
    Effect.tryPromise({
      try: () => import("./ForgejoSourceControlProvider.ts"),
      catch: (cause) => providerLoadError("forgejo", cause),
    }).pipe(
      Effect.flatMap((module) => module.make()),
      Effect.provideService(ForgejoApi.ForgejoApi, forgejoApi),
    ),
  );

  const azureDevOps = yield* makeLazyProvider(
    "azure-devops",
    Effect.tryPromise({
      try: () => import("./AzureDevOpsSourceControlProvider.ts"),
      catch: (cause) => providerLoadError("azure-devops", cause),
    }).pipe(
      Effect.flatMap((module) => module.make()),
      Effect.provideService(AzureDevOpsCli.AzureDevOpsCli, azureDevOpsCli),
    ),
  );

  const bitbucketDiscovery = makeBitbucketDiscovery(bitbucketApi);
  const forgejoDiscovery = makeForgejoDiscovery(forgejoApi);

  return yield* makeWithProviders([
    {
      kind: "github",
      provider: github,
      discovery: githubDiscovery,
    },
    {
      kind: "gitlab",
      provider: gitlab,
      discovery: gitlabDiscovery,
    },
    {
      kind: "azure-devops",
      provider: azureDevOps,
      discovery: azureDevOpsDiscovery,
    },
    {
      kind: "bitbucket",
      provider: bitbucket,
      discovery: bitbucketDiscovery,
    },
    {
      kind: "forgejo",
      provider: forgejo,
      discovery: forgejoDiscovery,
      detectProviderFromRemoteUrl: forgejoApi.detectProviderFromRemoteUrl,
    },
  ]);
});

export const layer = Layer.effect(SourceControlProviderRegistry, make());
