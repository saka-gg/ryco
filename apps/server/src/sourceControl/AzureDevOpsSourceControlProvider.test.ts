import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Result } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES } from "@ryco/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import {
  AZURE_COMMITS_22,
  AZURE_CONNECTION_DATA,
  AZURE_ITERATIONS_22,
  AZURE_PULL_REQUEST_22,
  AZURE_THREADS_22,
  azurePolicyEvaluations,
} from "./azureDevOpsPullRequestPage.fixtures.ts";
import {
  decodeAzureDevOpsRawPullRequestJson,
  normalizeAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";

function makeProvider(azure: Partial<AzureDevOpsCli.AzureDevOpsCliShape>) {
  return AzureDevOpsSourceControlProvider.make().pipe(
    Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)(azure)),
  );
}

it.effect("maps Azure DevOps PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Azure provider",
          url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "azure-devops",
      number: 42,
      title: "Add Azure provider",
      url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: false,
    });
  }),
);

it.effect("creates Azure DevOps PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<AzureDevOpsCli.AzureDevOpsCliShape["createPullRequest"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses Azure CLI repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let cwdInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        cwdInput = input.cwd;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(cwdInput, "/repo");
  }),
);

it.effect("listIssues maps Azure DevOps work items to provider: azure-devops", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listWorkItems: () =>
        Effect.succeed([
          {
            number: 42,
            title: "Bug",
            url: "https://dev.azure.com/org/proj/_workitems/edit/42",
            state: "open" as const,
            author: "alice@example.com",
            updatedAt: Option.some("2026-01-02T00:00:00.000Z"),
            labels: ["bug"],
          },
        ]),
    });
    const issues = yield* provider.listIssues({ cwd: "/repo", state: "open" });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.provider, "azure-devops");
    assert.strictEqual(issues[0]?.number, 42);
    assert.strictEqual(issues[0]?.title, "Bug");
    assert.strictEqual(issues[0]?.state, "open");
    assert.strictEqual(issues[0]?.author, "alice@example.com");
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
      getWorkItem: () =>
        Effect.succeed({
          number: 7,
          title: "Big",
          url: "https://dev.azure.com/org/proj/_workitems/edit/7",
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
    assert.strictEqual(detail.provider, "azure-devops");
    assert.ok(Buffer.byteLength(detail.body, "utf8") <= SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES);
  }),
);

it.effect("searchIssues forwards query to cli.searchWorkItems", () =>
  Effect.gen(function* () {
    let captured: string | undefined;
    const provider = yield* makeProvider({
      searchWorkItems: (input) => {
        captured = input.query;
        return Effect.succeed([]);
      },
    });
    yield* provider.searchIssues({ cwd: "/repo", query: "memory leak" });
    assert.strictEqual(captured, "memory leak");
  }),
);

it.effect("searchChangeRequests forwards query to cli.searchPullRequests", () =>
  Effect.gen(function* () {
    let captured: string | undefined;
    const provider = yield* makeProvider({
      searchPullRequests: (input) => {
        captured = input.query;
        return Effect.succeed([]);
      },
    });
    yield* provider.searchChangeRequests({ cwd: "/repo", query: "fix" });
    assert.strictEqual(captured, "fix");
  }),
);

/** Answers the provider's REST reads for PR 22 from the official samples. */
function samplePullRequest22(): Partial<AzureDevOpsCli.AzureDevOpsCliShape> {
  const raw = decodeAzureDevOpsRawPullRequestJson(JSON.stringify(AZURE_PULL_REQUEST_22));
  if (!Result.isSuccess(raw)) throw new Error("bad fixture");
  return {
    getRawPullRequest: () => Effect.succeed(raw.success),
    invoke: (input) =>
      Effect.succeed(
        JSON.stringify(
          input.resource === "pullRequestThreads"
            ? AZURE_THREADS_22
            : input.resource === "pullRequestCommits"
              ? AZURE_COMMITS_22
              : input.resource === "pullRequestIterations"
                ? AZURE_ITERATIONS_22
                : input.resource === "connectionData"
                  ? AZURE_CONNECTION_DATA
                  : { count: 1, value: [true] },
        ),
      ),
    execute: () =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: JSON.stringify(
          azurePolicyEvaluations({ build: "approved", minimumApprovals: "approved" }),
        ),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  };
}

it.effect("getChangeRequestDetail returns body, thread comments and merge readiness", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider(samplePullRequest22());
    const detail = yield* provider.getChangeRequestDetail({ cwd: "/repo", reference: "22" });
    assert.strictEqual(detail.provider, "azure-devops");
    assert.strictEqual(detail.number, 22);
    assert.strictEqual(detail.body, "Adding a new feature");
    assert.deepStrictEqual(
      detail.comments.map((comment) => [comment.id, comment.author]),
      [
        ["147:1", "fabrikamfiber16@hotmail.com"],
        ["148:1", "fabrikamfiber16@hotmail.com"],
      ],
    );
    assert.strictEqual(detail.truncated, false);
    assert.strictEqual(detail.author, "fabrikamfiber16@hotmail.com");
    assert.strictEqual(detail.headSha, "8c9396b5cf22f929767c7172e9dbbe777ddc6357");
    assert.strictEqual(detail.mergeability, "mergeable");
    assert.strictEqual(detail.mergeStateStatus, "clean");
    assert.strictEqual(detail.reviewDecision, "approved");
    assert.strictEqual(detail.autoMerge, null);
    assert.deepStrictEqual(
      detail.commits?.map((commit) => commit.oid),
      ["8c9396b5cf22f929767c7172e9dbbe777ddc6357"],
    );
  }),
);

it.effect("implements every page method, so the registry forwards them", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider(samplePullRequest22());
    for (const method of [
      "mergeChangeRequest",
      "getChangeRequestActivity",
      "getChangeRequestFileContents",
      "submitChangeRequestReview",
      "replyToReviewThread",
      "setReviewThreadResolved",
      "updateChangeRequestComment",
      "updateChangeRequest",
    ] as const) {
      assert.strictEqual(typeof provider[method], "function", method);
    }
    const activity = yield* provider.getChangeRequestActivity!({ cwd: "/repo", reference: "22" });
    assert.strictEqual(activity.reviewThreads[0]?.path, "new_feature.cpp");
    assert.strictEqual(activity.viewer?.isAuthor, true);
  }),
);

it.effect("serves commit-scoped diffs through the option guard and refuses reactions", () =>
  Effect.gen(function* () {
    const gitCalls: Array<ReadonlyArray<string>> = [];
    const provider = yield* makeProvider({
      ...samplePullRequest22(),
      runGit: (input) => {
        gitCalls.push(input.args);
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: input.args[0] === "diff" ? "commit diff" : "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    });
    const diff = yield* provider.getChangeRequestDiff({
      cwd: "/repo",
      reference: "22",
      commitSha: "8c9396b",
    });
    assert.strictEqual(diff, "commit diff");
    const reactions = yield* provider
      .addChangeRequestCommentReaction({
        cwd: "/repo",
        reference: "22",
        commentId: "147:1",
        content: "thumbs-up",
      })
      .pipe(Effect.flip);
    assert.strictEqual(reactions.detail, "Azure DevOps does not support comment reactions.");
    const involvement = yield* provider
      .listChangeRequests({
        cwd: "/repo",
        headSelector: "",
        state: "open",
        involvement: "mentioned",
      })
      .pipe(Effect.flip);
    assert.include(involvement.detail, "mentions");
  }),
);

describe("AzureDevOpsSourceControlProvider stubs (Phase 1 of issue creation)", () => {
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
});

it.effect("reports the PR terminal time from Azure DevOps closedDate", () =>
  Effect.gen(function* () {
    const closedAt = DateTime.makeUnsafe("2026-05-01T10:00:05.000Z");
    const stateOf = (
      state: "open" | "closed" | "merged",
      times: { readonly closedAt?: DateTime.Utc },
    ) =>
      makeProvider({
        getPullRequest: () =>
          Effect.succeed({
            number: 42,
            title: "Terminal time",
            url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
            baseRefName: "main",
            headRefName: "feature/terminal-time",
            state,
            updatedAt: Option.none(),
            isDraft: false,
            ...times,
          }),
      }).pipe(
        Effect.flatMap((provider) => provider.getPullRequestState({ cwd: "/repo", number: 42 })),
      );

    // Azure's closedDate is the completion time for both merged and abandoned PRs.
    assert.deepStrictEqual(yield* stateOf("merged", { closedAt }), {
      state: "merged",
      isDraft: false,
      terminalAt: closedAt,
    });
    assert.deepStrictEqual(yield* stateOf("closed", { closedAt }), {
      state: "closed",
      isDraft: false,
      terminalAt: closedAt,
    });
    assert.deepStrictEqual(yield* stateOf("open", {}), {
      state: "open",
      isDraft: false,
      terminalAt: null,
    });
  }),
);

it("normalizes Azure DevOps closedDate into the PR record", () => {
  const decoded = decodeAzureDevOpsRawPullRequestJson(
    JSON.stringify({
      pullRequestId: 42,
      title: "Completed",
      status: "completed",
      sourceRefName: "refs/heads/feature/terminal-time",
      targetRefName: "refs/heads/main",
      creationDate: "2026-05-01T09:00:00Z",
      closedDate: "2026-05-01T10:00:05Z",
    }),
  );
  assert.isTrue(Result.isSuccess(decoded));
  if (!Result.isSuccess(decoded)) return;
  const record = normalizeAzureDevOpsPullRequestRecord(decoded.success);
  assert.strictEqual(record.state, "merged");
  assert.deepStrictEqual(record.closedAt, DateTime.makeUnsafe("2026-05-01T10:00:05Z"));
});
