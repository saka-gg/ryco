import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import { SourceControlProviderError } from "@ryco/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as ForgejoApi from "./ForgejoApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeRegistry(input: {
  readonly remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>;
  readonly githubCli?: Partial<GitHubCli.GitHubCliShape>;
  readonly process?: Partial<VcsProcess.VcsProcessShape>;
  readonly bitbucketApi?: Partial<BitbucketApi.BitbucketApiShape>;
}) {
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: input.remotes.map((remote) => ({
          ...remote,
          pushUrl: Option.none(),
          isPrimary: remote.name === "origin",
        })),
        freshness: {
          source: "live-local" as const,
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriverShape>;

  const registryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    get: () => Effect.succeed(driver as unknown as VcsDriver.VcsDriverShape),
    resolve: () =>
      Effect.succeed({
        kind: "git",
        repository: {
          kind: "git",
          rootPath: "/repo",
          metadataPath: null,
          freshness: {
            source: "live-local" as const,
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        },
        driver: driver as unknown as VcsDriver.VcsDriverShape,
      }),
  });

  return SourceControlProviderRegistry.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        registryLayer,
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)(input.bitbucketApi ?? {}),
        Layer.mock(ForgejoApi.ForgejoApi)({
          detectProviderFromRemoteUrl: () => null,
          probeAuth: Effect.succeed({
            status: "unauthenticated",
            account: Option.none(),
            host: Option.some("codeberg.org"),
            detail: Option.none(),
          }),
        }),
        Layer.mock(GitHubCli.GitHubCli)({
          getPullRequestStack: () => Effect.succeed(null),
          getPullRequestStackSummaries: () => Effect.succeed(new Map()),
          getRepositoryMergeCapabilities: () =>
            Effect.fail(
              new GitHubCli.GitHubCliError({
                operation: "getRepositoryMergeCapabilities",
                detail: "not configured in this test",
              }),
            ),
          ...input.githubCli,
        }),
        Layer.mock(GitLabCli.GitLabCli)({}),
        Layer.mock(VcsProcess.VcsProcess)(
          input.process ?? { run: () => Effect.succeed(processOutput("")) },
        ),
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), {
          prefix: "ryco-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("routes GitHub remotes to the GitHub provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:pingdotgg/ryco.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("forwards Bitbucket repository search and clone auth through the lazy provider", () =>
  Effect.gen(function* () {
    const searchRepositoriesCalled = yield* Ref.make(false);
    const cloneAuthenticationCalled = yield* Ref.make(false);
    const cloneUrls = {
      nameWithOwner: "ryco-app/ryco-post-index",
      url: "https://bitbucket.org/ryco-app/ryco-post-index.git",
      sshUrl: "git@bitbucket.org:ryco-app/ryco-post-index.git",
    };
    const registry = yield* makeRegistry({
      remotes: [],
      bitbucketApi: {
        searchRepositories: (input) =>
          Effect.tap(Effect.succeed([cloneUrls]), () => {
            assert.strictEqual(input.cwd, "/repo");
            assert.strictEqual(input.query, "post");
            assert.strictEqual(input.limit, 5);
            return Ref.set(searchRepositoriesCalled, true);
          }),
        cloneAuthentication: (input) =>
          Effect.tap(
            Effect.succeed({
              kind: "http-basic" as const,
              username: "x-bitbucket-api-token-auth",
              password: "secret-token",
            }),
            () => {
              assert.strictEqual(
                input.remoteUrl,
                "https://ryco-app-admin@bitbucket.org/ryco-app/ryco-post-index.git",
              );
              return Ref.set(cloneAuthenticationCalled, true);
            },
          ),
      },
    });

    const provider = yield* registry.get("bitbucket");
    const searchRepositories = provider.searchRepositories;
    const cloneAuthentication = provider.cloneAuthentication;
    assert.ok(searchRepositories);
    assert.ok(cloneAuthentication);

    const repositories = yield* searchRepositories({
      cwd: "/repo",
      query: "post",
      limit: 5,
    });
    const authentication = yield* cloneAuthentication({
      remoteUrl: "https://ryco-app-admin@bitbucket.org/ryco-app/ryco-post-index.git",
    });

    assert.deepStrictEqual(repositories, [cloneUrls]);
    assert.deepStrictEqual(authentication, {
      kind: "http-basic",
      username: "x-bitbucket-api-token-auth",
      password: "secret-token",
    });
    assert.strictEqual(yield* Ref.get(searchRepositoriesCalled), true);
    assert.strictEqual(yield* Ref.get(cloneAuthenticationCalled), true);
  }),
);

it.effect("routes directly by provider kind for remote-first workflows", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [],
    });

    const provider = yield* registry.get("github");

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect("routes GitLab remotes to the GitLab provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@gitlab.com:group/project.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("refines unknown remotes to GitLab when glab is authenticated for that host", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@code.example.test:group/project.git" }],
      process: {
        run: (input) => {
          if (input.command === "glab" && input.args.join(" ") === "auth status") {
            return Effect.succeed(
              processOutput(`code.example.test
  ✓ Logged in to code.example.test as self-hosted-user
`),
            );
          }
          return Effect.succeed(processOutput(`${input.command} version test\n`));
        },
      },
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "gitlab");
  }),
);

it.effect("leaves unknown remotes unchanged when glab is authenticated for another host", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@code.example.test:group/project.git" }],
      process: {
        run: (input) => {
          if (input.command === "glab" && input.args.join(" ") === "auth status") {
            return Effect.succeed(
              processOutput(`gitlab.example.test
  ✓ Logged in to gitlab.example.test as gitlab-user
`),
            );
          }
          return Effect.succeed(processOutput(`${input.command} version test\n`));
        },
      },
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "unknown");
  }),
);

it.effect("routes Bitbucket remotes to the Bitbucket provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@bitbucket.org:pingdotgg/ryco.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "bitbucket");
  }),
);

it.effect("routes Forgejo remotes to the Forgejo provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@codeberg.org:pingdotgg/ryco.git" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "forgejo");
  }),
);

it.effect("routes Azure DevOps remotes to the Azure DevOps provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "https://dev.azure.com/acme/project/_git/repo" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);

it.effect("falls back to a non-origin remote when origin is not configured", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      remotes: [{ name: "upstream", url: "https://dev.azure.com/acme/project/_git/repo" }],
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);

it.effect("dispatches listIssues to the GitHub provider for GitHub remotes", () =>
  Effect.gen(function* () {
    const called = yield* Ref.make(false);
    const registry = yield* makeRegistry({
      remotes: [{ name: "origin", url: "git@github.com:pingdotgg/ryco.git" }],
      githubCli: {
        listIssues: (_input) => Effect.tap(Effect.succeed([]), () => Ref.set(called, true)),
      },
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });
    yield* provider.listIssues({ cwd: "/repo", state: "open" });

    assert.strictEqual(yield* Ref.get(called), true);
  }),
);

it.effect(
  "dispatches getIssue, searchIssues, searchChangeRequests, and getChangeRequestDetail to the GitHub provider",
  () =>
    Effect.gen(function* () {
      const getIssueCalled = yield* Ref.make(false);
      const searchIssuesCalled = yield* Ref.make(false);
      const searchChangeRequestsCalled = yield* Ref.make(false);
      const getChangeRequestDetailCalled = yield* Ref.make(false);

      const registry = yield* makeRegistry({
        remotes: [{ name: "origin", url: "git@github.com:pingdotgg/ryco.git" }],
        githubCli: {
          getIssue: (_input) =>
            Effect.tap(
              Effect.succeed({
                number: 1,
                title: "Test issue",
                url: "https://github.com/pingdotgg/ryco/issues/1",
                state: "open" as const,
                author: null,
                updatedAt: Option.none(),
                labels: [],
                assignees: [],
                commentsCount: 0,
                body: "body",
                comments: [],
              }),
              () => Ref.set(getIssueCalled, true),
            ),
          searchIssues: (_input) =>
            Effect.tap(Effect.succeed([]), () => Ref.set(searchIssuesCalled, true)),
          searchPullRequests: (_input) =>
            Effect.tap(Effect.succeed([]), () => Ref.set(searchChangeRequestsCalled, true)),
          getPullRequestDetail: (_input) =>
            Effect.tap(
              Effect.succeed({
                number: 1,
                title: "Test PR",
                url: "https://github.com/pingdotgg/ryco/pull/1",
                baseRefName: "main",
                headRefName: "feature/test",
                author: null,
                assignees: [],
                labels: [],
                commentsCount: 0,
                body: "body",
                comments: [],
                linkedIssueNumbers: [],
                reviewers: [],
                commits: [],
                additions: 0,
                deletions: 0,
                changedFiles: 0,
                files: [],
              }),
              () => Ref.set(getChangeRequestDetailCalled, true),
            ),
        },
      });

      const provider = yield* registry.resolve({ cwd: "/repo" });

      yield* provider.getIssue({ cwd: "/repo", reference: "1" });
      yield* provider.searchIssues({ cwd: "/repo", query: "bug" });
      yield* provider.searchChangeRequests({ cwd: "/repo", query: "fix" });
      yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "1" });

      assert.strictEqual(yield* Ref.get(getIssueCalled), true, "getIssue should be called");
      assert.strictEqual(yield* Ref.get(searchIssuesCalled), true, "searchIssues should be called");
      assert.strictEqual(
        yield* Ref.get(searchChangeRequestsCalled),
        true,
        "searchChangeRequests should be called",
      );
      assert.strictEqual(
        yield* Ref.get(getChangeRequestDetailCalled),
        true,
        "getChangeRequestDetail should be called",
      );
    }),
);

describe("change request page forwarding", () => {
  const context = {
    provider: {
      kind: "github" as const,
      name: "GitHub",
      baseUrl: "https://github.com",
    },
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/repo.git",
  } satisfies SourceControlProvider.SourceControlProviderContext;

  const optionalOperations = [
    "mergeChangeRequest",
    "getChangeRequestActivity",
    "getChangeRequestFileContents",
    "submitChangeRequestReview",
    "replyToReviewThread",
    "setReviewThreadResolved",
    "updateChangeRequestComment",
    "updateChangeRequest",
  ] as const satisfies ReadonlyArray<SourceControlProvider.OptionalChangeRequestOperation>;

  /** A provider whose optional methods echo their name and received input. */
  function recordingProvider(
    calls: Array<{ readonly operation: string; readonly input: unknown }>,
    options: { readonly withOptional: boolean },
  ): SourceControlProvider.SourceControlProviderShape {
    const record =
      (operation: string) =>
      (input: unknown): Effect.Effect<never, never> => {
        calls.push({ operation, input });
        return Effect.succeed({ operation } as never);
      };
    const optional = options.withOptional
      ? Object.fromEntries(optionalOperations.map((operation) => [operation, record(operation)]))
      : {};
    return {
      kind: "github",
      ...optional,
    } as unknown as SourceControlProvider.SourceControlProviderShape;
  }

  const inputFor = (operation: (typeof optionalOperations)[number]) =>
    ({ cwd: "/repo", reference: "7", operation }) as never;

  const invoke = (
    provider: SourceControlProvider.SourceControlProviderShape,
    operation: (typeof optionalOperations)[number],
  ) => {
    const method = provider[operation] as
      | ((input: never) => Effect.Effect<object, SourceControlProviderError>)
      | undefined;
    assert.ok(method, `${operation} must be forwarded`);
    return method(inputFor(operation));
  };

  it.effect("forwards merge and every page method through the lazy provider", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
      const lazy = yield* SourceControlProviderRegistry.makeLazyProvider(
        "github",
        Effect.succeed(recordingProvider(calls, { withOptional: true })),
      );
      for (const operation of optionalOperations) {
        const result = yield* invoke(lazy, operation);
        assert.deepStrictEqual(result, { operation });
      }
      assert.deepStrictEqual(
        calls.map((call) => call.operation),
        [...optionalOperations],
      );
    }),
  );

  it.effect("fails clearly when the loaded provider lacks a page method", () =>
    Effect.gen(function* () {
      const lazy = yield* SourceControlProviderRegistry.makeLazyProvider(
        "gitlab",
        Effect.succeed(recordingProvider([], { withOptional: false })),
      );
      for (const operation of optionalOperations) {
        const error = yield* invoke(lazy, operation).pipe(Effect.flip);
        assert.ok(Schema.is(SourceControlProviderError)(error));
        assert.strictEqual(error.operation, operation);
        assert.strictEqual(error.provider, "gitlab");
        assert.include(error.detail, "does not support");
      }
    }),
  );

  it.effect("binds the detected remote context into every forwarded page method", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
      const bound = SourceControlProviderRegistry.bindProviderContext(
        recordingProvider(calls, { withOptional: true }),
        context,
      );
      for (const operation of optionalOperations) {
        yield* invoke(bound, operation);
      }
      assert.strictEqual(calls.length, optionalOperations.length);
      for (const call of calls) {
        assert.deepStrictEqual((call.input as { readonly context?: unknown }).context, context);
      }

      const unbound = SourceControlProviderRegistry.bindProviderContext(
        recordingProvider([], { withOptional: false }),
        context,
      );
      for (const operation of optionalOperations) {
        assert.strictEqual(unbound[operation], undefined);
      }
    }),
  );

  it.effect("merges a GitHub pull request through registry.resolve", () =>
    Effect.gen(function* () {
      const merged = yield* Ref.make(false);
      const registry = yield* makeRegistry({
        remotes: [{ name: "origin", url: "git@github.com:acme/repo.git" }],
        githubCli: {
          getPullRequest: () =>
            Effect.succeed({
              number: 7,
              title: "Seven",
              url: "https://github.com/acme/repo/pull/7",
              baseRefName: "main",
              headRefName: "feature/x",
              state: "open" as const,
              headSha: "abc",
            }),
          getRepositoryMergeCapabilities: () =>
            Effect.succeed({ merge: true, squash: true, rebase: false }),
          mergePullRequestAsync: (input) =>
            Effect.sync(() => {
              assert.strictEqual(input.repository, "acme/repo");
              assert.strictEqual(input.expectedHeadSha, "abc");
            }).pipe(
              Effect.andThen(Ref.set(merged, true)),
              Effect.as({ outcome: "merged" as const }),
            ),
        },
      });
      const provider = yield* registry.resolve({ cwd: "/repo" });
      const mergeChangeRequest = provider.mergeChangeRequest;
      assert.ok(mergeChangeRequest);
      const result = yield* mergeChangeRequest({
        cwd: "/repo",
        reference: "7",
        mergeMethod: "squash",
        expectedHeadSha: "abc",
      });
      assert.deepStrictEqual(result, { outcome: "merged" });
      assert.strictEqual(yield* Ref.get(merged), true);
    }),
  );
});

describe("unsupported change request options", () => {
  // A host with none of these options (GitLab now supports them all).
  const base = {
    kind: "unknown",
    listChangeRequests: () => Effect.succeed([]),
    getChangeRequestDiff: () => Effect.succeed("diff"),
    createChangeRequest: () => Effect.void,
  } as unknown as SourceControlProvider.SourceControlProviderShape;
  const guarded = SourceControlProvider.withUnsupportedChangeRequestOptionGuards(base);

  it.effect("fails instead of silently returning unfiltered or whole data", () =>
    Effect.gen(function* () {
      const involvement = yield* guarded
        .listChangeRequests({
          cwd: "/repo",
          headSelector: "",
          state: "open",
          involvement: "authored",
        })
        .pipe(Effect.flip);
      assert.include(involvement.detail, "involvement");
      const query = yield* guarded
        .listChangeRequests({ cwd: "/repo", headSelector: "", state: "open", query: "bug" })
        .pipe(Effect.flip);
      assert.include(query.detail, "searching within filtered change requests lists");
      const commit = yield* guarded
        .getChangeRequestDiff({ cwd: "/repo", reference: "7", commitSha: "abc" })
        .pipe(Effect.flip);
      assert.include(commit.detail, "single-commit diffs");
      const draft = yield* guarded
        .createChangeRequest({
          cwd: "/repo",
          baseRefName: "main",
          headSelector: "x",
          title: "t",
          bodyFile: "/tmp/b",
          draft: true,
        })
        .pipe(Effect.flip);
      assert.include(draft.detail, "opening change requests");
    }),
  );

  it.effect("passes plain requests through untouched", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* guarded.listChangeRequests({ cwd: "/repo", headSelector: "", state: "open" }),
        [],
      );
      assert.strictEqual(
        yield* guarded.getChangeRequestDiff({ cwd: "/repo", reference: "7" }),
        "diff",
      );
    }),
  );
});
