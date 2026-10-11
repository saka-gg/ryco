import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { GitCommandError, type SourceControlProviderError } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { WorkspaceAccessPolicyLayer } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = {
  nameWithOwner: "octocat/ryco",
  url: "https://github.com/octocat/ryco",
  sshUrl: "git@github.com:octocat/ryco.git",
};

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProviderShape> = {},
): SourceControlProvider.SourceControlProviderShape {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
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
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeLayer(input: {
  readonly provider?: SourceControlProvider.SourceControlProviderShape;
  readonly detectedProviderKind?: SourceControlProvider.SourceControlProviderShape["kind"] | null;
  readonly git?: Partial<GitVcsDriver.GitVcsDriverShape>;
  readonly workspaceAccessRoot?: string;
}) {
  return SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        get: () => Effect.succeed(input.provider ?? makeProvider()),
        detectProviderFromRemoteUrl: () =>
          input.detectedProviderKind
            ? {
                kind: input.detectedProviderKind,
                name: input.detectedProviderKind,
                baseUrl: "https://bitbucket.org",
              }
            : null,
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-source-control-repos-" })),
    Layer.provide(WorkspaceAccessPolicyLayer(input.workspaceAccessRoot)),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/ryco",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/ryco" }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("searches repositories through providers that support repository search", () => {
  const calls: Array<{ cwd: string; query: string | undefined; limit: number | undefined }> = [];
  const provider = makeProvider({
    searchRepositories: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, query: input.query, limit: input.limit });
        return [CLONE_URLS];
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.searchRepositories({
      provider: "github",
      query: " ryco ",
      limit: 10,
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, {
      repositories: [{ provider: "github", ...CLONE_URLS }],
    });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", query: "ryco", limit: 10 }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect(
  "resolves bare repository names through repository search when exactly one match exists",
  () => {
    const provider = makeProvider({
      getRepositoryCloneUrls: () => Effect.die("unexpected direct repository lookup"),
      searchRepositories: () => Effect.succeed([CLONE_URLS]),
    });

    return Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.lookupRepository({
        provider: "github",
        repository: "ryco",
        cwd: "/workspace",
      });

      assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    }).pipe(Effect.provide(makeLayer({ provider })));
  },
);

it.effect("clones a looked-up repository into the requested destination", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-clone-parent-",
    });
    const destinationPath = `${parent}/ryco`;
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/ryco",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: "github", ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", "--", CLONE_URLS.url, "ryco"],
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects clone destinations outside the configured workspace before mutation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-restricted-",
    });
    const outsideRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-outside-",
    });
    const destinationPath = `${outsideRoot}/repository`;
    let cloneCalls = 0;

    const error = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service
        .cloneRepository({
          provider: "github",
          repository: "octocat/ryco",
          destinationPath,
        })
        .pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        makeLayer({
          workspaceAccessRoot: workspaceRoot,
          git: {
            execute: () =>
              Effect.sync(() => {
                cloneCalls += 1;
                return processOutput();
              }),
          },
        }),
      ),
    );

    assert.strictEqual(error._tag, "SourceControlRepositoryError");
    assert.match(error.detail, /access is restricted/);
    assert.strictEqual(cloneCalls, 0);
    assert.isFalse(yield* fs.exists(destinationPath));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uses provider clone auth and HTTPS when the provider supplies clone credentials", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-clone-parent-",
    });
    const destinationPath = `${parent}/ryco`;
    const cloneCalls: Array<{
      cwd: string;
      args: ReadonlyArray<string>;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const provider = makeProvider({
      getRepositoryCloneUrls: () =>
        Effect.succeed({
          ...CLONE_URLS,
          url: "https://octocat@github.com/octocat/ryco",
        }),
      cloneAuthentication: () =>
        Effect.succeed({
          kind: "http-basic" as const,
          username: "x-bitbucket-api-token-auth",
          password: "secret-token",
        }),
    });

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/ryco",
        destinationPath,
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: {
          provider: "github",
          ...CLONE_URLS,
          url: "https://octocat@github.com/octocat/ryco",
        },
      });
      assert.deepStrictEqual(cloneCalls[0]?.args, ["clone", "--", CLONE_URLS.url, "ryco"]);
      assert.strictEqual(cloneCalls[0]?.env?.RYCO_GIT_USERNAME, "x-bitbucket-api-token-auth");
      assert.strictEqual(cloneCalls[0]?.env?.RYCO_GIT_PASSWORD, "secret-token");
      assert.strictEqual(cloneCalls[0]?.env?.GIT_TERMINAL_PROMPT, "0");
      assert.ok(cloneCalls[0]?.env?.GIT_ASKPASS);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider,
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args, env: input.env });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uses detected provider clone auth for raw HTTPS clone URLs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-clone-parent-",
    });
    const destinationPath = `${parent}/bitbucket-test`;
    const cloneCalls: Array<{
      args: ReadonlyArray<string>;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const provider = makeProvider({
      kind: "bitbucket",
      cloneAuthentication: () =>
        Effect.succeed({
          kind: "http-basic" as const,
          username: "x-bitbucket-api-token-auth",
          password: "secret-token",
        }),
    });

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        remoteUrl: "https://ryco-app-admin@bitbucket.org/ryco-app/ryco-post-index.git",
        destinationPath,
      });

      assert.strictEqual(result.remoteUrl, "https://bitbucket.org/ryco-app/ryco-post-index.git");
      assert.deepStrictEqual(cloneCalls[0]?.args, [
        "clone",
        "--",
        "https://bitbucket.org/ryco-app/ryco-post-index.git",
        "bitbucket-test",
      ]);
      assert.strictEqual(cloneCalls[0]?.env?.RYCO_GIT_USERNAME, "x-bitbucket-api-token-auth");
      assert.strictEqual(cloneCalls[0]?.env?.RYCO_GIT_PASSWORD, "secret-token");
      assert.ok(cloneCalls[0]?.env?.GIT_ASKPASS);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider,
          detectedProviderKind: "bitbucket",
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ args: input.args, env: input.env });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects clone URLs that could be parsed as git options", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-clone-parent-",
    });
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;

    const result = yield* service
      .cloneRepository({
        remoteUrl: "--upload-pack=/tmp/pwn",
        destinationPath: `${parent}/ryco`,
      })
      .pipe(Effect.result);

    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(makeLayer({}))),
);

it.effect("accepts explicit HTTPS, SSH, and SCP-style clone URLs", () => {
  const cloneCalls: ReadonlyArray<string>[] = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-clone-parent-",
    });
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;

    for (const [index, remoteUrl] of [
      "https://github.com/octocat/ryco.git",
      "ssh://git@github.com/octocat/ryco.git",
      "git@github.com:octocat/ryco.git",
    ].entries()) {
      yield* service.cloneRepository({
        remoteUrl,
        destinationPath: `${parent}/repo-${index}`,
      });
    }

    assert.deepStrictEqual(cloneCalls, [
      ["clone", "--", "https://github.com/octocat/ryco.git", "repo-0"],
      ["clone", "--", "ssh://git@github.com/octocat/ryco.git", "repo-1"],
      ["clone", "--", "git@github.com:octocat/ryco.git", "repo-2"],
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            Effect.sync(() => {
              cloneCalls.push(input.args);
              return processOutput();
            }),
        },
      }),
    ),
  );
});

it.effect("rejects unsupported clone URL schemes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "ryco-source-control-clone-parent-",
    });
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;

    const result = yield* service
      .cloneRepository({
        remoteUrl: "file:///tmp/repo.git",
        destinationPath: `${parent}/ryco`,
      })
      .pipe(Effect.result);

    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(makeLayer({}))),
);

it.effect("publishes by creating the repository, adding a remote, and pushing upstream", () => {
  const createCalls: Array<{ cwd: string; repository: string; visibility: string }> = [];
  const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];
  const provider = makeProvider({
    createRepository: (input) =>
      Effect.sync(() => {
        createCalls.push({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/ryco",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "feature/remote-v1",
      upstreamBranch: "origin/feature/remote-v1",
      status: "pushed",
    });
    assert.deepStrictEqual(createCalls, [
      { cwd: "/workspace", repository: "octocat/ryco", visibility: "private" },
    ]);
    assert.deepStrictEqual(remoteCalls, [
      { cwd: "/workspace", preferredName: "origin", url: CLONE_URLS.sshUrl },
    ]);
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        git: {
          ensureRemote: (input) =>
            Effect.sync(() => {
              remoteCalls.push(input);
              return "origin";
            }),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: "origin/feature/remote-v1",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publishes to the remote name returned by ensureRemote", () => {
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/ryco",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          ensureRemote: () => Effect.succeed("origin-1"),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: `${options?.remoteName ?? "missing"}/feature/remote-v1`,
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/ryco",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git rev-parse --verify HEAD",
                    cwd: input.cwd,
                    detail: "fatal: Needed a single revision",
                  }),
                )
              : Effect.succeed(processOutput()),
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              upstreamRef: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              aheadOfDefaultCount: 0,
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushCalls += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});
