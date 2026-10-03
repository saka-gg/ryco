import { assert, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Option } from "effect";
import { AtlassianConnectionId } from "@ryco/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import { makeLayer } from "./bitbucketApiTestLayer.ts";
import type { AtlassianConnectionRecord } from "../persistence/Services/AtlassianConnections.ts";
import { manualBitbucketTokenSecretName } from "../atlassian/AtlassianConnectionService.ts";

const bitbucketPullRequest = {
  id: 42,
  title: "Add Bitbucket provider",
  state: "OPEN",
  updated_on: "2026-01-02T00:00:00.000Z",
  links: {
    html: {
      href: "https://bitbucket.org/pingdotgg/ryco/pull-requests/42",
    },
  },
  source: {
    branch: { name: "feature/source-control" },
    repository: {
      full_name: "octocat/ryco",
      workspace: { slug: "octocat" },
    },
  },
  destination: {
    branch: { name: "main" },
    repository: {
      full_name: "pingdotgg/ryco",
      workspace: { slug: "pingdotgg" },
    },
  },
};

const repositoryJson = {
  full_name: "pingdotgg/ryco",
  links: {
    html: { href: "https://bitbucket.org/pingdotgg/ryco" },
    clone: [
      { name: "https", href: "https://bitbucket.org/pingdotgg/ryco.git" },
      { name: "ssh", href: "git@bitbucket.org:pingdotgg/ryco.git" },
    ],
  },
  mainbranch: { name: "main" },
};

function storedBitbucketConnection(input: {
  readonly connectionId: string;
  readonly label?: string;
  readonly email: string;
  readonly updatedAt?: string;
}): AtlassianConnectionRecord {
  const timestamp = input.updatedAt ?? "2026-01-01T00:00:00.000Z";
  return {
    connectionId: AtlassianConnectionId.make(input.connectionId),
    kind: "bitbucket_token",
    label: input.label ?? "Stored Bitbucket",
    status: "connected",
    products: ["bitbucket"],
    capabilities: ["bitbucket:read", "bitbucket:write"],
    accountName: null,
    accountEmail: input.email,
    avatarUrl: null,
    baseUrl: "https://api.bitbucket.org/2.0",
    expiresAt: null,
    lastVerifiedAt: null,
    readonly: false,
    isDefault: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function basicAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
}

it.effect("parses pull request responses from the Bitbucket REST API", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        ...bitbucketPullRequest,
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const result = yield* bitbucket.getPullRequest({
      cwd: "/repo",
      reference: "#42",
    });

    assert.deepStrictEqual(result, {
      number: 42,
      title: "Add Bitbucket provider",
      url: "https://bitbucket.org/pingdotgg/ryco/pull-requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "octocat/ryco",
      headRepositoryOwnerLogin: "octocat",
    });
    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      "https://api.test.local/2.0/repositories/pingdotgg/ryco/pullrequests/42",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("lists pull requests with Bitbucket state and source branch query params", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [
          {
            ...bitbucketPullRequest,
            id: 7,
            state: "MERGED",
            source: {
              branch: { name: "feature/merged" },
              repository: { full_name: "pingdotgg/ryco" },
            },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const result = yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "origin:feature/merged",
      state: "merged",
      limit: 10,
    });

    assert.strictEqual(result[0]?.state, "merged");
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/ryco/pullrequests",
    );
    assert.deepStrictEqual(request?.urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      ["q", 'source.branch.name = "feature/merged" AND state = "MERGED"'],
      ["state", "MERGED"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("lists closed pull requests with both closed Bitbucket states", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/closed",
      state: "closed",
      limit: 10,
    });

    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      [
        "q",
        'source.branch.name = "feature/closed" AND (state = "DECLINED" OR state = "SUPERSEDED")',
      ],
      ["state", "DECLINED"],
      ["state", "SUPERSEDED"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("lists repository pull requests without a source-branch filter", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "",
      state: "open",
      limit: 10,
    });

    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      ["q", 'state = "OPEN"'],
      ["state", "OPEN"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("expands all-state pull request listing instead of relying on Bitbucket defaults", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/all",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(execute.mock.calls[0]?.[0].urlParams.params, [
      ["pagelen", "10"],
      ["sort", "-updated_on"],
      [
        "q",
        'source.branch.name = "feature/all" AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")',
      ],
      ["state", "OPEN"],
      ["state", "MERGED"],
      ["state", "DECLINED"],
      ["state", "SUPERSEDED"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("reads repository clone URLs and default branch", () => {
  const { layer } = makeLayer({
    response: (request) =>
      Response.json(
        request.url.endsWith("/branching-model")
          ? {
              development: {
                branch: { name: "main" },
                name: "main",
                use_mainbranch: true,
              },
            }
          : repositoryJson,
      ),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const cloneUrls = yield* bitbucket.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "pingdotgg/ryco",
    });
    const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/ryco",
      url: "https://bitbucket.org/pingdotgg/ryco.git",
      sshUrl: "git@bitbucket.org:pingdotgg/ryco.git",
    });
    assert.strictEqual(defaultBranch, "main");
  }).pipe(Effect.provide(layer));
});

it.effect("searches repositories across accessible Bitbucket workspaces", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      if (request.url.endsWith("/user/workspaces")) {
        return Response.json({
          values: [{ workspace: { slug: "pingdotgg" } }, { workspace: { slug: "ryco-app" } }],
        });
      }
      if (request.url.endsWith("/repositories/pingdotgg")) {
        return Response.json({
          values: [
            {
              ...repositoryJson,
              mainbranch: { type: "branch" },
            },
            {
              ...repositoryJson,
              full_name: "pingdotgg/admin",
              links: {
                html: { href: "https://bitbucket.org/pingdotgg/admin" },
                clone: [
                  { name: "https", href: "https://bitbucket.org/pingdotgg/admin.git" },
                  { name: "ssh", href: "git@bitbucket.org:pingdotgg/admin.git" },
                ],
              },
            },
          ],
        });
      }
      return Response.json({
        values: [
          {
            ...repositoryJson,
            full_name: "ryco-app/ryco-post-index",
            links: {
              html: { href: "https://bitbucket.org/ryco-app/ryco-post-index" },
              clone: [
                {
                  name: "https",
                  href: "https://bitbucket.org/ryco-app/ryco-post-index.git",
                },
                { name: "ssh", href: "git@bitbucket.org:ryco-app/ryco-post-index.git" },
              ],
            },
          },
        ],
      });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const repositories = yield* bitbucket.searchRepositories({
      cwd: "/repo",
      query: "post",
      limit: 5,
    });

    assert.deepStrictEqual(repositories, [
      {
        nameWithOwner: "ryco-app/ryco-post-index",
        url: "https://bitbucket.org/ryco-app/ryco-post-index.git",
        sshUrl: "git@bitbucket.org:ryco-app/ryco-post-index.git",
      },
    ]);
    assert.deepStrictEqual(
      execute.mock.calls.map((call) => call[0].url),
      [
        "https://api.test.local/2.0/user/workspaces",
        "https://api.test.local/2.0/repositories/pingdotgg",
        "https://api.test.local/2.0/repositories/ryco-app",
      ],
    );
    const repositoryRequests = execute.mock.calls.slice(1).map((call) => call[0]);
    assert.deepStrictEqual(repositoryRequests[0]?.urlParams.params, [
      ["pagelen", "25"],
      ["sort", "-updated_on"],
      ["q", '(name ~ "post" OR full_name ~ "post")'],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "does not fall back to local VCS detection for malformed explicit Bitbucket repos",
  () => {
    const { execute, layer } = makeLayer({
      response: () => Response.json(repositoryJson),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const error = yield* bitbucket
        .getRepositoryCloneUrls({
          cwd: "/Users/laurinfrank",
          repository: "ryco-post-index",
        })
        .pipe(Effect.flip);

      assert.equal(
        error.detail,
        "Bitbucket repositories must be specified as workspace/repository, or selected from repository search.",
      );
      assert.strictEqual(execute.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "prefers the Bitbucket branching model development branch as the default PR target",
  () => {
    const { execute, layer } = makeLayer({
      response: (request) =>
        Response.json(
          request.url.endsWith("/branching-model")
            ? {
                development: {
                  branch: { name: "develop" },
                  name: "develop",
                  use_mainbranch: false,
                },
              }
            : repositoryJson,
        ),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "develop");
      assert.deepStrictEqual(
        execute.mock.calls.map((call) => call[0].url).toSorted(),
        [
          "https://api.test.local/2.0/repositories/pingdotgg/ryco",
          "https://api.test.local/2.0/repositories/pingdotgg/ryco/branching-model",
        ].toSorted(),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "falls back to the repository main branch when the Bitbucket development branch is invalid",
  () => {
    const { layer } = makeLayer({
      response: (request) =>
        Response.json(
          request.url.endsWith("/branching-model")
            ? {
                development: {
                  name: "develop",
                  use_mainbranch: false,
                  is_valid: false,
                },
              }
            : repositoryJson,
        ),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "main");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "falls back to the repository main branch when the Bitbucket branching model is unavailable",
  () => {
    const { layer } = makeLayer({
      response: (request) =>
        request.url.endsWith("/branching-model")
          ? Response.json({ error: { message: "Not found" } }, { status: 404 })
          : Response.json(repositoryJson),
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

      assert.strictEqual(defaultBranch, "main");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("creates repositories through the Bitbucket REST API", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(repositoryJson),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const cloneUrls = yield* bitbucket.createRepository({
      cwd: "/repo",
      repository: "pingdotgg/ryco",
      visibility: "private",
    });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/ryco",
      url: "https://bitbucket.org/pingdotgg/ryco.git",
      sshUrl: "git@bitbucket.org:pingdotgg/ryco.git",
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, "https://api.test.local/2.0/repositories/pingdotgg/ryco");
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(rawBody)), {
      scm: "git",
      is_private: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("creates pull requests using the official REST payload shape", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(bitbucketPullRequest),
  });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "bitbucket-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "PR body");

    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile,
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/ryco/pullrequests",
    );
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    assert.ok(rawBody);
    assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(rawBody)), {
      title: "Provider PR",
      description: "PR body",
      source: {
        branch: { name: "feature/provider" },
        repository: { full_name: "owner/ryco" },
      },
      destination: {
        branch: { name: "main" },
      },
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("reports auth status through the Bitbucket REST /user endpoint", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const auth = yield* bitbucket.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("bitbucket-user"),
      host: Option.some("bitbucket.org"),
      detail: Option.none(),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reports auth status using a saved Atlassian Bitbucket token", () => {
  const connection = storedBitbucketConnection({
    connectionId: "atl-conn-bitbucket",
    email: "stored@example.com",
  });
  const secrets = new Map<string, Uint8Array>([
    [
      manualBitbucketTokenSecretName(connection.connectionId),
      new TextEncoder().encode("stored-token"),
    ],
  ]);
  const { execute, layer } = makeLayer({
    env: {
      RYCO_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
    },
    atlassianConnections: [connection],
    secrets,
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const auth = yield* bitbucket.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("bitbucket-user"),
      host: Option.some("bitbucket.org"),
      detail: Option.none(),
    });
    assert.strictEqual(
      execute.mock.calls[0]?.[0].headers.authorization,
      basicAuthorization("stored@example.com", "stored-token"),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("uses saved Atlassian Bitbucket credentials before environment credentials", () => {
  const connection = storedBitbucketConnection({
    connectionId: "atl-conn-bitbucket",
    email: "stored@example.com",
  });
  const secrets = new Map<string, Uint8Array>([
    [
      manualBitbucketTokenSecretName(connection.connectionId),
      new TextEncoder().encode("stored-token"),
    ],
  ]);
  const { execute, layer } = makeLayer({
    atlassianConnections: [connection],
    secrets,
    response: () =>
      Response.json({
        ...bitbucketPullRequest,
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.getPullRequest({
      cwd: "/repo",
      reference: "#42",
    });

    assert.strictEqual(
      execute.mock.calls[0]?.[0].headers.authorization,
      basicAuthorization("stored@example.com", "stored-token"),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("uses saved Bitbucket API tokens for HTTPS git clone authentication", () => {
  const connection = storedBitbucketConnection({
    connectionId: "atl-conn-bitbucket",
    email: "stored@example.com",
  });
  const secrets = new Map<string, Uint8Array>([
    [
      manualBitbucketTokenSecretName(connection.connectionId),
      new TextEncoder().encode("stored-token"),
    ],
  ]);
  const { execute, layer } = makeLayer({
    atlassianConnections: [connection],
    secrets,
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const auth = yield* bitbucket.cloneAuthentication({
      remoteUrl: "https://bitbucket.org/ryco-app/ryco-post-index.git",
    });

    assert.deepStrictEqual(auth, {
      kind: "http-basic",
      username: "x-bitbucket-api-token-auth",
      password: "stored-token",
    });
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("does not probe Bitbucket when no credentials are configured", () => {
  const { execute, layer } = makeLayer({
    env: {
      RYCO_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
    },
    response: () => Response.json({ username: "bitbucket-user" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const auth = yield* bitbucket.probeAuth;

    assert.strictEqual(auth.status, "unauthenticated");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("checks out same-repository pull requests with the existing Bitbucket remote", () => {
  const { git, layer } = makeLayer({
    response: () =>
      Response.json({
        ...bitbucketPullRequest,
        source: {
          branch: { name: "feature/source-control" },
          repository: {
            full_name: "pingdotgg/ryco",
            workspace: { slug: "pingdotgg" },
          },
        },
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.checkoutPullRequest({
      cwd: "/repo",
      context: {
        provider: {
          kind: "bitbucket",
          name: "Bitbucket",
          baseUrl: "https://bitbucket.org",
        },
        remoteName: "origin",
        remoteUrl: "git@bitbucket.org:pingdotgg/ryco.git",
      },
      reference: "42",
      force: true,
    });

    assert.strictEqual(git.ensureRemote.mock.calls.length, 0);
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
      localBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "feature/source-control",
      remoteName: "origin",
      remoteBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "feature/source-control",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("checks out fork pull requests through an ensured fork remote", () => {
  const { git, layer } = makeLayer({
    response: (request) => {
      if (request.url.endsWith("/repositories/octocat/ryco")) {
        return Response.json({
          ...repositoryJson,
          full_name: "octocat/ryco",
          links: {
            html: { href: "https://bitbucket.org/octocat/ryco" },
            clone: [
              { name: "https", href: "https://bitbucket.org/octocat/ryco.git" },
              { name: "ssh", href: "git@bitbucket.org:octocat/ryco.git" },
            ],
          },
        });
      }
      return Response.json({
        ...bitbucketPullRequest,
        source: {
          branch: { name: "main" },
          repository: {
            full_name: "octocat/ryco",
            workspace: { slug: "octocat" },
          },
        },
      });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.checkoutPullRequest({
      cwd: "/repo",
      reference: "42",
      force: true,
    });

    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "octocat",
      url: "git@bitbucket.org:octocat/ryco.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "octocat",
      remoteBranch: "main",
      localBranch: "ryco/pr-42/main",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "ryco/pr-42/main",
      remoteName: "octocat",
      remoteBranch: "main",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "ryco/pr-42/main",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("listIssues returns empty array when Bitbucket replies 404", () => {
  const { layer } = makeLayer({
    response: () => Response.json({ error: { message: "Issues disabled" } }, { status: 404 }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const issues = yield* bitbucket.listIssues({ cwd: "/repo", state: "open" });
    assert.deepStrictEqual(issues, []);
  }).pipe(Effect.provide(layer));
});

it.effect("getIssue returns body and comments via two REST calls", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      if (request.url.includes("/comments")) {
        return Response.json({
          values: [
            {
              user: { username: "alice", display_name: "Alice" },
              content: { raw: "first comment" },
              created_on: "2026-03-14T10:00:00Z",
            },
          ],
        });
      }
      return Response.json({
        id: 42,
        title: "Bug report",
        state: "open",
        content: { raw: "issue body" },
        reporter: { username: "alice", display_name: "Alice" },
        links: { html: { href: "https://bitbucket.org/pingdotgg/ryco/issues/42" } },
      });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const detail = yield* bitbucket.getIssue({ cwd: "/repo", reference: "42" });
    assert.strictEqual(detail.number, 42);
    assert.strictEqual(detail.body, "issue body");
    assert.strictEqual(detail.comments.length, 1);
    assert.strictEqual(detail.comments[0]?.author, "alice");
    // Two calls: issue + comments
    assert.strictEqual(execute.mock.calls.length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("searchIssues forwards BBQL to /issues endpoint", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [
          {
            id: 5,
            title: "memory leak in parser",
            state: "open",
            links: { html: { href: "https://bitbucket.org/pingdotgg/ryco/issues/5" } },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const results = yield* bitbucket.searchIssues({ cwd: "/repo", query: "memory leak" });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.number, 5);
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/ryco/issues",
    );
    assert.deepStrictEqual(request?.urlParams.params, [
      ["q", 'title ~ "memory leak"'],
      ["pagelen", "20"],
      ["sort", "-updated_on"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("searchPullRequests forwards BBQL to /pullrequests endpoint", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [
          {
            id: 12,
            title: "fix memory leak in parser",
            state: "OPEN",
            links: {
              html: { href: "https://bitbucket.org/pingdotgg/ryco/pull-requests/12" },
            },
            source: {
              branch: { name: "fix/leak" },
              repository: { full_name: "pingdotgg/ryco" },
            },
            destination: {
              branch: { name: "main" },
              repository: { full_name: "pingdotgg/ryco" },
            },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const results = yield* bitbucket.searchPullRequests({ cwd: "/repo", query: "memory leak" });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.number, 12);
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(
      request?.url,
      "https://api.test.local/2.0/repositories/pingdotgg/ryco/pullrequests",
    );
    assert.deepStrictEqual(request?.urlParams.params, [
      ["q", 'title ~ "memory leak"'],
      ["pagelen", "20"],
      ["sort", "-updated_on"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "getPullRequestDetail returns body and comments, tolerating failed enrichment reads",
  () => {
    const { execute, layer } = makeLayer({
      response: (request) => {
        if (/\/(commits|statuses|mergeability\/checks)$/u.test(request.url)) {
          return Response.json({ type: "error", error: { message: "Forbidden" } }, { status: 403 });
        }
        if (request.url.includes("/comments")) {
          return Response.json({
            values: [
              {
                user: { username: "reviewer", display_name: "Reviewer" },
                content: { raw: "looks good" },
                created_on: "2026-03-14T10:00:00Z",
              },
            ],
          });
        }
        return Response.json({
          id: 12,
          title: "RYCO-123 Add feature",
          state: "OPEN",
          summary: { raw: "PR body text for OPS-9" },
          author: { display_name: "Alice" },
          reviewers: [{ display_name: "Reviewer" }],
          participants: [
            {
              user: { display_name: "Reviewer", nickname: "reviewer" },
              role: "REVIEWER",
              approved: true,
            },
          ],
          comment_count: 3,
          task_count: 1,
          links: {
            html: { href: "https://bitbucket.org/pingdotgg/ryco/pull-requests/12" },
          },
          source: {
            branch: { name: "feature/add" },
            repository: { full_name: "pingdotgg/ryco" },
          },
          destination: {
            branch: { name: "main" },
            repository: { full_name: "pingdotgg/ryco" },
          },
        });
      },
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const detail = yield* bitbucket.getPullRequestDetail({ cwd: "/repo", reference: "12" });
      assert.strictEqual(detail.number, 12);
      assert.strictEqual(detail.body, "PR body text for OPS-9");
      assert.strictEqual(detail.comments.length, 1);
      assert.strictEqual(detail.comments[0]?.author, "reviewer");
      assert.strictEqual(detail.author, "Alice");
      assert.strictEqual(detail.commentsCount, 3);
      assert.strictEqual(detail.tasksCount, 1);
      assert.deepStrictEqual(detail.reviewers, ["Reviewer"]);
      assert.deepStrictEqual(detail.linkedWorkItemKeys, ["RYCO-123", "OPS-9"]);
      assert.deepStrictEqual(detail.participants[0], {
        displayName: "Reviewer",
        username: "reviewer",
        role: "REVIEWER",
        approved: true,
      });
      // PR + comments, then the page enrichment (commits, statuses, mergeability).
      assert.strictEqual(execute.mock.calls.length, 5);
      assert.strictEqual(detail.commits, undefined);
      assert.strictEqual(detail.checkRollup, undefined);
      assert.strictEqual(detail.mergeability, "unknown");
      assert.deepStrictEqual(detail.reviewerStates, [
        { login: "Reviewer", kind: "user", state: "approved" },
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("getPullRequestDiff returns the raw Bitbucket diff text", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      if (request.url.endsWith("/diff")) {
        return new Response("diff --git a/file.ts b/file.ts\n+added\n", {
          headers: { "content-type": "text/plain" },
        });
      }
      return Response.json(bitbucketPullRequest);
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const diff = yield* bitbucket.getPullRequestDiff({ cwd: "/repo", reference: "12" });
    assert.include(diff, "diff --git");
    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      "https://api.test.local/2.0/repositories/pingdotgg/ryco/pullrequests/12/diff",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("listIssues fetches open issues and returns normalized records", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json({
        values: [
          {
            id: 42,
            title: "Bug report",
            state: "open",
            updated_on: "2026-03-14T10:00:00Z",
            reporter: { username: "alice", display_name: "Alice" },
            links: { html: { href: "https://bitbucket.org/pingdotgg/ryco/issues/42" } },
          },
        ],
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const issues = yield* bitbucket.listIssues({ cwd: "/repo", state: "open", limit: 10 });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.number, 42);
    assert.strictEqual(issues[0]?.state, "open");
    assert.strictEqual(issues[0]?.author, "alice");
    const url = execute.mock.calls[0]?.[0].url ?? "";
    assert.ok(url.includes("/repositories/pingdotgg/ryco/issues"), `URL was: ${url}`);
  }).pipe(Effect.provide(layer));
});

it.effect("getIssue parses issue ID from a trailing-slash URL", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      if (request.url.includes("/comments")) {
        return Response.json({ values: [] });
      }
      return Response.json({
        id: 42,
        title: "Bug report",
        state: "open",
        content: { raw: "issue body" },
        reporter: { username: "alice", display_name: "Alice" },
        links: { html: { href: "https://bitbucket.org/pingdotgg/ryco/issues/42" } },
      });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.getIssue({
      cwd: "/repo",
      reference: "https://bitbucket.org/w/r/issues/42/",
    });
    const issueCallUrl =
      execute.mock.calls.find((call) => !call[0].url.includes("/comments"))?.[0].url ?? "";
    assert.ok(
      issueCallUrl.includes("/issues/42"),
      `Expected URL to include /issues/42, got: ${issueCallUrl}`,
    );
    assert.ok(
      !issueCallUrl.endsWith("/issues/"),
      `Expected URL not to end with /issues/, got: ${issueCallUrl}`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("getPullRequestDetail parses PR ID from a trailing-slash URL", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      if (request.url.includes("/comments")) {
        return Response.json({ values: [] });
      }
      return Response.json({
        id: 42,
        title: "Add feature",
        state: "OPEN",
        summary: { raw: "PR body" },
        links: {
          html: { href: "https://bitbucket.org/pingdotgg/ryco/pull-requests/42" },
        },
        source: {
          branch: { name: "feature/add" },
          repository: { full_name: "pingdotgg/ryco" },
        },
        destination: {
          branch: { name: "main" },
          repository: { full_name: "pingdotgg/ryco" },
        },
      });
    },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    yield* bitbucket.getPullRequestDetail({
      cwd: "/repo",
      reference: "https://bitbucket.org/w/r/pull-requests/42/",
    });
    const prCallUrl =
      execute.mock.calls.find((call) => !call[0].url.includes("/comments"))?.[0].url ?? "";
    assert.ok(
      prCallUrl.includes("/pullrequests/42"),
      `Expected URL to include /pullrequests/42, got: ${prCallUrl}`,
    );
    assert.ok(
      !prCallUrl.endsWith("/pullrequests/"),
      `Expected URL not to end with /pullrequests/, got: ${prCallUrl}`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "getIssue resolves with body and empty comments when comments endpoint returns 404",
  () => {
    const { layer } = makeLayer({
      response: (request) => {
        if (request.url.includes("/comments")) {
          return Response.json({ error: { message: "Not found" } }, { status: 404 });
        }
        return Response.json({
          id: 7,
          title: "Flaky test",
          state: "open",
          content: { raw: "issue body text" },
          reporter: { username: "bob", display_name: "Bob" },
          links: { html: { href: "https://bitbucket.org/pingdotgg/ryco/issues/7" } },
        });
      },
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const detail = yield* bitbucket.getIssue({ cwd: "/repo", reference: "7" });
      assert.strictEqual(detail.number, 7);
      assert.strictEqual(detail.body, "issue body text");
      assert.deepStrictEqual(detail.comments, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "getPullRequestDetail resolves with body and empty comments when comments endpoint returns 404",
  () => {
    const { layer } = makeLayer({
      response: (request) => {
        if (request.url.includes("/comments")) {
          return Response.json({ error: { message: "Not found" } }, { status: 404 });
        }
        return Response.json({
          id: 9,
          title: "Fix crash",
          state: "OPEN",
          summary: { raw: "PR description" },
          links: {
            html: { href: "https://bitbucket.org/pingdotgg/ryco/pull-requests/9" },
          },
          source: {
            branch: { name: "fix/crash" },
            repository: { full_name: "pingdotgg/ryco" },
          },
          destination: {
            branch: { name: "main" },
            repository: { full_name: "pingdotgg/ryco" },
          },
        });
      },
    });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      const detail = yield* bitbucket.getPullRequestDetail({ cwd: "/repo", reference: "9" });
      assert.strictEqual(detail.number, 9);
      assert.strictEqual(detail.body, "PR description");
      assert.deepStrictEqual(detail.comments, []);
    }).pipe(Effect.provide(layer));
  },
);
