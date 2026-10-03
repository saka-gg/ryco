import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { GitLabApiRequest } from "./gitLabApi.ts";
import * as GitLabCli from "./GitLabCli.ts";
import {
  GITLAB_APPROVALS,
  GITLAB_COMMIT,
  GITLAB_COMMITS,
  GITLAB_CURRENT_USER,
  GITLAB_MERGE_REQUEST,
  GITLAB_PIPELINES,
  GITLAB_PROJECT,
  GITLAB_REVIEWERS,
} from "./gitLabMergeRequestPage.fixtures.ts";
import * as GitLabMergeRequests from "./gitLabMergeRequests.ts";
import { parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

const processResult = (
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

/** `GitLabCli.api` answering `METHOD endpoint-without-query` from fixtures (404 otherwise). */
function routeApi(
  routes: Readonly<Record<string, unknown>>,
  requests: GitLabApiRequest[] = [],
): GitLabCli.GitLabCliShape["api"] {
  return (input) => {
    requests.push(input.request);
    const key = `${input.request.method} ${input.request.endpoint.split("?")[0]}`;
    return key in routes
      ? Effect.succeed({ stdout: JSON.stringify(routes[key]), stdoutTruncated: false })
      : Effect.fail(
          new GitLabCli.GitLabCliError({ operation: input.operation, detail: key, status: 404 }),
        );
  };
}

function makeProvider(gitlab: Partial<GitLabCli.GitLabCliShape>) {
  return GitLabSourceControlProvider.make().pipe(
    Effect.provide(Layer.mock(GitLabCli.GitLabCli)(gitlab)),
  );
}

it("parses GitLab auth status by host", () => {
  const hosts = parseGitLabAuthStatusHosts(`gitlab.com
  ✓ Logged in to gitlab.com as gitlab-user
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as self-hosted-user
`);

  assert.deepStrictEqual(hosts, [
    {
      host: "gitlab.com",
      account: "gitlab-user",
      authenticated: true,
    },
    {
      host: "self-hosted.example.test",
      account: "self-hosted-user",
      authenticated: true,
    },
  ]);
});

it("uses a successful GitLab host even when another host fails", () => {
  const auth = GitLabSourceControlProvider.discovery.parseAuth(
    processResult(
      `gitlab.example.test
  ✓ Logged in to gitlab.example.test as gitlab-user
bad.example.test
  x failed to authenticate
`,
      {
        exitCode: ChildProcessSpawner.ExitCode(1),
      },
    ),
  );

  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.account, Option.some("gitlab-user"));
  assert.deepStrictEqual(auth.host, Option.some("gitlab.example.test"));
});

it.effect("maps GitLab MR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getMergeRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add GitLab provider",
          url: "https://gitlab.com/pingdotgg/ryco/-/merge_requests/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/ryco",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "gitlab",
      number: 42,
      title: "Add GitLab provider",
      url: "https://gitlab.com/pingdotgg/ryco/-/merge_requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/ryco",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("lists GitLab MRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let listInput: Parameters<GitLabCli.GitLabCliShape["listMergeRequests"]>[0] | null = null;
    const provider = yield* makeProvider({
      listMergeRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });
  }),
);

it.effect("creates GitLab MRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GitLabCli.GitLabCliShape["createMergeRequest"]>[0] | null = null;
    const provider = yield* makeProvider({
      createMergeRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider MR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      source: {
        owner: "owner",
        refName: "feature/provider",
      },
      title: "Provider MR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("listIssues maps GitLab summaries to provider: gitlab", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listIssues: () =>
        Effect.succeed([
          {
            number: 42,
            title: "Bug",
            url: "https://gitlab.com/owner/repo/-/issues/42",
            state: "open" as const,
            author: "alice",
            updatedAt: Option.some("2026-01-02T00:00:00.000Z"),
            labels: ["bug"],
          },
        ]),
    });
    const issues = yield* provider.listIssues({ cwd: "/repo", state: "open" });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.provider, "gitlab");
    assert.strictEqual(issues[0]?.number, 42);
    assert.strictEqual(issues[0]?.title, "Bug");
    assert.strictEqual(issues[0]?.state, "open");
    assert.strictEqual(issues[0]?.author, "alice");
    assert.deepStrictEqual(
      issues[0]?.updatedAt,
      Option.some(DateTime.fromDateUnsafe(new Date("2026-01-02T00:00:00.000Z"))),
    );
  }),
);

it.effect("getIssue truncates body when over 8 KB", () =>
  Effect.gen(function* () {
    const bigBody = "x".repeat(SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES + 100);
    const provider = yield* makeProvider({
      getIssue: () =>
        Effect.succeed({
          number: 7,
          title: "Big",
          url: "https://gitlab.com/owner/repo/-/issues/7",
          state: "open" as const,
          author: "bob",
          updatedAt: Option.none(),
          labels: [],
          body: bigBody,
          comments: [],
        }),
    });
    const detail = yield* provider.getIssue({ cwd: "/repo", reference: "7" });
    assert.strictEqual(detail.truncated, true);
    assert.strictEqual(detail.provider, "gitlab");
    assert.ok(Buffer.byteLength(detail.body, "utf8") <= SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES);
  }),
);

it.effect("searchIssues forwards query to cli.searchIssues", () =>
  Effect.gen(function* () {
    let captured: string | undefined;
    const provider = yield* makeProvider({
      searchIssues: (input) => {
        captured = input.query;
        return Effect.succeed([]);
      },
    });
    yield* provider.searchIssues({ cwd: "/repo", query: "memory leak" });
    assert.strictEqual(captured, "memory leak");
  }),
);

it.effect("searchChangeRequests forwards query to cli.searchMergeRequests", () =>
  Effect.gen(function* () {
    let captured: string | undefined;
    const provider = yield* makeProvider({
      searchMergeRequests: (input) => {
        captured = input.query;
        return Effect.succeed([]);
      },
    });
    yield* provider.searchChangeRequests({ cwd: "/repo", query: "fix" });
    assert.strictEqual(captured, "fix");
  }),
);

it.effect("getChangeRequestDetail returns body and comments", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getMergeRequestDetail: () =>
        Effect.succeed({
          number: 99,
          title: "Add feature",
          url: "https://gitlab.com/owner/repo/-/merge_requests/99",
          baseRefName: "main",
          headRefName: "feature/add",
          state: "open" as const,
          updatedAt: Option.none(),
          body: "MR body text",
          comments: [{ author: "reviewer", body: "looks good", createdAt: "2026-03-01T10:00:00Z" }],
        }),
    });
    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "99" });
    assert.strictEqual(detail.provider, "gitlab");
    assert.strictEqual(detail.number, 99);
    assert.strictEqual(detail.body, "MR body text");
    assert.strictEqual(detail.comments.length, 1);
    assert.strictEqual(detail.comments[0]?.author, "reviewer");
    assert.strictEqual(detail.comments[0]?.body, "looks good");
    assert.strictEqual(detail.truncated, false);
  }),
);

describe("GitLabSourceControlProvider pickers and stubs", () => {
  it.effect("createIssue fails with 'Not implemented' SourceControlProviderError", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({});
      const result = yield* provider
        .createIssue({ cwd: "/repo", title: "x", body: "" })
        .pipe(Effect.flip);
      assert.strictEqual(result.operation, "createIssue");
      assert.include(result.detail, "Not implemented");
    }),
  );

  it.effect("listLabels reads the project's labels (docs example)", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        api: routeApi({
          // https://docs.gitlab.com/api/labels/#list-all-project-labels
          "GET projects/:fullpath/labels": [
            {
              id: 1,
              name: "bug",
              color: "#d9534f",
              text_color: "#FFFFFF",
              description: "Bug reported by user",
              description_html: "Bug reported by user",
              open_issues_count: 1,
              closed_issues_count: 0,
              open_merge_requests_count: 1,
              subscribed: false,
              priority: 10,
              is_project_label: true,
              archived: false,
            },
          ],
        }),
      });
      const labels = yield* provider.listLabels({ cwd: "/repo" });
      assert.deepStrictEqual(labels, [
        { name: "bug", color: "d9534f", description: "Bug reported by user" },
      ]);
    }),
  );

  it.effect("listAssignees reads active members", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({
        api: routeApi({
          // https://docs.gitlab.com/api/project_members/#list-all-members-of-a-project
          "GET projects/:fullpath/members/all": [
            {
              id: 1,
              username: "raymond_smith",
              name: "Raymond Smith",
              state: "active",
              avatar_url:
                "https://www.gravatar.com/avatar/c2525a7f58ae3776070e44c106c48e15?s=80&d=identicon",
              web_url: "http://192.168.1.8:3000/root",
              access_level: 30,
            },
            {
              id: 2,
              username: "blocked_user",
              name: "Blocked",
              state: "blocked",
              access_level: 30,
            },
          ],
        }),
      });
      const assignees = yield* provider.listAssignees({ cwd: "/repo" });
      assert.deepStrictEqual(assignees, [
        {
          login: "raymond_smith",
          displayName: "Raymond Smith",
          avatarUrl:
            "https://www.gravatar.com/avatar/c2525a7f58ae3776070e44c106c48e15?s=80&d=identicon",
        },
      ]);
    }),
  );
});

describe("GitLabSourceControlProvider pull request page", () => {
  it.effect("lists by involvement through REST and adds each open row's pipeline", () =>
    Effect.gen(function* () {
      const requests: GitLabApiRequest[] = [];
      const provider = yield* makeProvider({
        api: routeApi(
          {
            "GET user": GITLAB_CURRENT_USER,
            "GET projects/:fullpath/merge_requests": [GITLAB_MERGE_REQUEST],
            "GET projects/:fullpath/pipelines": [
              { ...GITLAB_PIPELINES[0], ref: "refs/merge-requests/133/head", status: "success" },
            ],
          },
          requests,
        ),
      });
      const rows = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "",
        state: "open",
        involvement: "authored",
      });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.author, "marcel.amirault");
      assert.strictEqual(rows[0]?.mergeability, "mergeable");
      assert.strictEqual(rows[0]?.headSha, "e82eb4a098e32c796079ca3915e07487fc4db24c");
      assert.deepStrictEqual(
        rows[0]?.checkRollup?.map((item) => item.conclusion),
        [Option.some("success")],
      );
      assert.include(requests[1]?.endpoint ?? "", "author_username=john_smith");
    }),
  );

  it.effect("adds readiness to the detail when glab reports the merge request's facts", () =>
    Effect.gen(function* () {
      const raw = GitLabMergeRequests.decodeGitLabMergeRequestDetailJson(
        JSON.stringify(GITLAB_MERGE_REQUEST),
      );
      if (raw._tag !== "Success") throw new Error("fixture did not decode");
      const statusSha = GITLAB_MERGE_REQUEST.head_pipeline.sha;
      const provider = yield* makeProvider({
        getMergeRequestDetail: () => Effect.succeed(raw.success),
        api: routeApi({
          "GET projects/:fullpath/merge_requests/133/reviewers": GITLAB_REVIEWERS,
          "GET projects/:fullpath/merge_requests/133/approvals": GITLAB_APPROVALS,
          "GET projects/:fullpath": GITLAB_PROJECT,
          // The head pipeline runs on a merged-results commit of the head.
          [`GET projects/:fullpath/repository/commits/${statusSha}`]: {
            ...GITLAB_COMMIT,
            id: statusSha,
            parent_ids: [
              GITLAB_MERGE_REQUEST.diff_refs.base_sha,
              GITLAB_MERGE_REQUEST.diff_refs.head_sha,
            ],
          },
          [`GET projects/:fullpath/repository/commits/${statusSha}/statuses`]: [],
          [`GET projects/:fullpath/pipelines/${GITLAB_MERGE_REQUEST.head_pipeline.id}/jobs`]: [],
          "GET projects/:fullpath/merge_requests/133/commits": GITLAB_COMMITS,
        }),
      });
      const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "133" });
      assert.strictEqual(detail.reviewDecision, "approved");
      assert.strictEqual(detail.mergeStateStatus, "clean");
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: true,
        squash: true,
        rebase: false,
      });
      assert.deepStrictEqual(detail.checkRollup, []);
      assert.strictEqual(detail.commits?.length, 2);
    }),
  );

  it.effect("opens drafts and maps API failures to provider errors", () =>
    Effect.gen(function* () {
      let draft: boolean | undefined;
      const provider = yield* makeProvider({
        createMergeRequest: (input) => {
          draft = input.draft;
          return Effect.void;
        },
        api: routeApi({}),
      });
      yield* provider.createChangeRequest({
        cwd: "/repo",
        baseRefName: "main",
        headSelector: "feature/x",
        title: "X",
        bodyFile: "/tmp/body.md",
        draft: true,
      });
      assert.strictEqual(draft, true);
      const error = yield* provider.getChangeRequestActivity!({
        cwd: "/repo",
        reference: "133",
      }).pipe(Effect.flip);
      assert.strictEqual(error.provider, "gitlab");
      assert.strictEqual(error.operation, "getChangeRequestActivity");
    }),
  );

  it.effect("keeps reactions unsupported", () =>
    Effect.gen(function* () {
      const provider = yield* makeProvider({});
      const error = yield* provider
        .addChangeRequestCommentReaction({
          cwd: "/repo",
          reference: "133",
          commentId: "301",
          content: "heart",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, "GitLab does not support comment reactions.");
    }),
  );
});
