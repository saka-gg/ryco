import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option } from "effect";

import * as ForgejoApi from "./ForgejoApi.ts";
import {
  apiPath,
  makeForgejoApiTestLayer as makeLayer,
  requestJsonBody,
} from "./forgejoApiTestLayer.ts";

const forgejoRepository = {
  full_name: "pingdotgg/ryco",
  html_url: "https://codeberg.test/pingdotgg/ryco",
  clone_url: "https://codeberg.test/pingdotgg/ryco.git",
  ssh_url: "git@codeberg.test:pingdotgg/ryco.git",
  default_branch: "main",
};

const forgejoPullRequest = {
  number: 42,
  title: "Add Forgejo provider",
  state: "open",
  merged: false,
  body: "PR body",
  html_url: "https://codeberg.test/pingdotgg/ryco/pulls/42",
  updated_at: "2026-01-02T00:00:00.000Z",
  comments: 1,
  user: { login: "alice" },
  head: {
    ref: "feature/source-control",
    label: "alice:feature/source-control",
    repo_id: 11,
    repo: {
      full_name: "alice/ryco",
      html_url: "https://codeberg.test/alice/ryco",
      clone_url: "https://codeberg.test/alice/ryco.git",
      ssh_url: "git@codeberg.test:alice/ryco.git",
      default_branch: "main",
    },
  },
  base: {
    ref: "main",
    repo_id: 12,
    repo: forgejoRepository,
  },
};

it.effect("detects configured Forgejo hosts from remotes", () => {
  const { layer } = makeLayer({
    response: () => Response.json({}),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const provider = forgejo.detectProviderFromRemoteUrl("git@codeberg.test:owner/repo.git");

    assert.deepStrictEqual(provider, {
      kind: "forgejo",
      name: "Forgejo",
      baseUrl: "https://codeberg.test",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("lists pull requests and filters by head branch locally", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json([
        forgejoPullRequest,
        {
          ...forgejoPullRequest,
          number: 43,
          head: { ...forgejoPullRequest.head, ref: "feature/other" },
        },
      ]),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const result = yield* forgejo.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/source-control",
      state: "open",
      limit: 10,
    });

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.number, 42);
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, "https://codeberg.test/api/v1/repos/pingdotgg/ryco/pulls");
    assert.deepStrictEqual(request?.urlParams.params, [
      ["state", "open"],
      ["sort", "recentupdate"],
      ["limit", "10"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("reads repository clone URLs and default branch", () => {
  const { layer } = makeLayer({
    response: () => Response.json(forgejoRepository),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const cloneUrls = yield* forgejo.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "pingdotgg/ryco",
    });
    const defaultBranch = yield* forgejo.getDefaultBranch({ cwd: "/repo" });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "pingdotgg/ryco",
      url: "https://codeberg.test/pingdotgg/ryco.git",
      sshUrl: "git@codeberg.test:pingdotgg/ryco.git",
    });
    assert.strictEqual(defaultBranch, "main");
  }).pipe(Effect.provide(layer));
});

it.effect("creates repositories through the Forgejo REST API", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.url.endsWith("/user")
        ? Response.json({ login: "pingdotgg" })
        : Response.json(forgejoRepository),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const cloneUrls = yield* forgejo.createRepository({
      cwd: "/repo",
      repository: "pingdotgg/ryco",
      visibility: "private",
    });

    assert.strictEqual(cloneUrls.nameWithOwner, "pingdotgg/ryco");
    const createRequest = execute.mock.calls.find((call) => call[0].method === "POST")?.[0];
    assert.ok(createRequest);
    assert.strictEqual(createRequest.url, "https://codeberg.test/api/v1/user/repos");
    assert.deepStrictEqual(requestJsonBody(createRequest), {
      name: "ryco",
      private: true,
      auto_init: false,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("creates pull requests using the Forgejo REST payload shape", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(forgejoPullRequest),
  });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "forgejo-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "PR body");

    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile,
    });

    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, "https://codeberg.test/api/v1/repos/pingdotgg/ryco/pulls");
    assert.strictEqual(request?.method, "POST");
    assert.ok(request);
    assert.deepStrictEqual(requestJsonBody(request), {
      title: "Provider PR",
      body: "PR body",
      head: "owner:feature/provider",
      base: "main",
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("reports auth status through the Forgejo REST /user endpoint", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ login: "forgejo-user" }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const auth = yield* forgejo.probeAuth;

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("forgejo-user"),
      host: Option.some("codeberg.test"),
      detail: Option.none(),
    });
    assert.strictEqual(execute.mock.calls[0]?.[0].headers.authorization, "token token");
  }).pipe(Effect.provide(layer));
});

it.effect("uses fj credentials when no Forgejo token is configured", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const keysFile = yield* fileSystem.makeTempFileScoped({ prefix: "forgejo-cli-keys-" });
    yield* fileSystem.writeFileString(
      keysFile,
      '{"hosts":{"codeberg.test":{"type":"Application","name":"fj-user","token":"fj-token"}}}',
    );

    const { execute, layer } = makeLayer({
      env: {
        RYCO_FORGEJO_BASE_URL: "https://codeberg.test",
        RYCO_FORGEJO_CLI_KEYS_FILE: keysFile,
      },
      response: () => Response.json({ login: "fj-user" }),
    });

    const auth = yield* Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      return yield* forgejo.probeAuth;
    }).pipe(Effect.provide(layer));

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("fj-user"),
      host: Option.some("codeberg.test"),
      detail: Option.none(),
    });
    assert.strictEqual(execute.mock.calls[0]?.[0].headers.authorization, "token fj-token");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("discovers custom Forgejo hosts from fj credentials", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const keysFile = yield* fileSystem.makeTempFileScoped({ prefix: "forgejo-cli-keys-" });
    yield* fileSystem.writeFileString(
      keysFile,
      '{"hosts":{"forge.example.test":{"type":"Application","name":"self-hosted","token":"fj-custom-token"}}}',
    );

    const { execute, layer } = makeLayer({
      env: {
        RYCO_FORGEJO_CLI_KEYS_FILE: keysFile,
      },
      response: () => Response.json({ login: "self-hosted" }),
    });

    const auth = yield* Effect.gen(function* () {
      const forgejo = yield* ForgejoApi.ForgejoApi;
      return yield* forgejo.probeAuth;
    }).pipe(Effect.provide(layer));

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("self-hosted"),
      host: Option.some("forge.example.test"),
      detail: Option.none(),
    });
    assert.strictEqual(execute.mock.calls[0]?.[0].url, "https://forge.example.test/api/v1/user");
    assert.strictEqual(execute.mock.calls[0]?.[0].headers.authorization, "token fj-custom-token");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("checks out fork pull requests through an ensured fork remote", () => {
  const { git, layer } = makeLayer({
    response: () => Response.json(forgejoPullRequest),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    yield* forgejo.checkoutPullRequest({
      cwd: "/repo",
      reference: "42",
      force: true,
    });

    assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
      cwd: "/repo",
      preferredName: "alice",
      url: "git@codeberg.test:alice/ryco.git",
    });
    assert.deepStrictEqual(git.fetchRemoteBranch.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "alice",
      remoteBranch: "feature/source-control",
      localBranch: "ryco/pr-42/feature/source-control",
    });
    assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
      cwd: "/repo",
      branch: "ryco/pr-42/feature/source-control",
      remoteName: "alice",
      remoteBranch: "feature/source-control",
    });
    assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      refName: "ryco/pr-42/feature/source-control",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("getPullRequestDetail returns body, comments, commits, and files", () => {
  const { execute, layer } = makeLayer({
    response: (request) => {
      if (request.url.includes("/issues/42/comments")) {
        return Response.json([
          {
            user: { login: "reviewer" },
            body: "looks good",
            created_at: "2026-03-14T10:00:00Z",
          },
        ]);
      }
      if (request.url.includes("/pulls/42/commits")) {
        return Response.json([
          {
            sha: "abcdef1234567890",
            commit: {
              message: "Add support\n\nDetails",
              author: { name: "Alice", date: "2026-03-14T09:00:00Z" },
            },
            author: { login: "alice" },
          },
        ]);
      }
      if (request.url.includes("/pulls/42/files")) {
        return Response.json([{ filename: "src/forgejo.ts", additions: 10, deletions: 2 }]);
      }
      return Response.json(forgejoPullRequest);
    },
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const detail = yield* forgejo.getPullRequestDetail({ cwd: "/repo", reference: "42" });

    assert.strictEqual(detail.number, 42);
    assert.strictEqual(detail.body, "PR body");
    assert.strictEqual(detail.comments[0]?.author, "reviewer");
    assert.strictEqual(detail.commits[0]?.shortOid, "abcdef123456");
    assert.strictEqual(detail.additions, 10);
    assert.strictEqual(detail.deletions, 2);
    assert.strictEqual(detail.changedFiles, 1);
    // The detail reads, then the merge readiness reads (no head sha: no status read).
    assert.deepStrictEqual(execute.mock.calls.map(([request]) => apiPath(request)).toSorted(), [
      "/repos/pingdotgg/ryco",
      "/repos/pingdotgg/ryco/branches/main",
      "/repos/pingdotgg/ryco/issues/42/comments",
      "/repos/pingdotgg/ryco/pulls/42",
      "/repos/pingdotgg/ryco/pulls/42/commits",
      "/repos/pingdotgg/ryco/pulls/42/files",
      "/repos/pingdotgg/ryco/pulls/42/reviews",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("getPullRequestDiff reads Forgejo diff text", () => {
  const { layer } = makeLayer({
    response: () =>
      new Response("diff --git a/src/forgejo.ts b/src/forgejo.ts\n", {
        headers: { "content-type": "text/plain" },
      }),
  });

  return Effect.gen(function* () {
    const forgejo = yield* ForgejoApi.ForgejoApi;
    const diff = yield* forgejo.getPullRequestDiff({ cwd: "/repo", reference: "42" });

    assert.strictEqual(diff, "diff --git a/src/forgejo.ts b/src/forgejo.ts\n");
  }).pipe(Effect.provide(layer));
});
