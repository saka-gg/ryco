import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  AzureDevOpsCliError,
  type AzureDevOpsCliShape,
  type AzureDevOpsInvokeInput,
} from "./AzureDevOpsCli.ts";
import {
  AZURE_COMMENT_CREATE_REQUEST,
  AZURE_COMMITS_22,
  AZURE_CONNECTION_DATA,
  AZURE_FILE_THREAD_CREATED,
  AZURE_ITERATION_CHANGES_22,
  AZURE_ITERATIONS_22,
  AZURE_PULL_REQUEST_22,
  AZURE_PULL_REQUEST_LIST,
  AZURE_REF_UPDATE_RESULT,
  AZURE_TAGS,
  AZURE_TEAM_MEMBERS,
  AZURE_THREAD_CREATED,
  AZURE_THREADS_22,
  azurePolicyEvaluations,
} from "./azureDevOpsPullRequestPage.fixtures.ts";
import {
  AZURE_DEVOPS_HEAD_CHANGED_DETAIL,
  makeAzureDevOpsPullRequestOperations,
} from "./azureDevOpsPullRequestOperations.ts";
import {
  decodeAzureDevOpsPullRequestListJson,
  decodeAzureDevOpsRawPullRequestJson,
} from "./azureDevOpsPullRequests.ts";

const HEAD = "8c9396b5cf22f929767c7172e9dbbe777ddc6357";
const TARGET = "f47bbc106853afe3c1b07a81754bce5f4b8dbf62";
const OLD_HEAD = "b60280bc6e62e2f880f1b63c1e24987664d3bda3";
const PROJECT = "a7573007-bbb3-4341-b726-0c4148a07853";
const REPOSITORY = "3411ebc1-d5aa-464f-9615-0b527bc66719";
const VIEWER_ID = "d6245f20-2af8-44f4-9451-8107cb2767db";
const ROUTE = { project: PROJECT, repositoryId: REPOSITORY, pullRequestId: 22 };

type Reply = unknown;
interface GitReply {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stdoutTruncated?: boolean;
}

function output(reply: GitReply): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(reply.exitCode ?? 0),
    stdout: reply.stdout ?? "",
    stderr: "",
    stdoutTruncated: reply.stdoutTruncated ?? false,
    stderrTruncated: false,
  };
}

const isCliError = Schema.is(AzureDevOpsCliError);
const fail = (detail: string) => new AzureDevOpsCliError({ operation: "test", detail });

/**
 * A recording `AzureDevOpsCliShape`. Replies are JSON values (or an
 * `AzureDevOpsCliError` to fail); unrouted calls fail the test.
 */
function fakeAzure(routes: {
  readonly pullRequest?: unknown;
  readonly invoke?: (input: AzureDevOpsInvokeInput) => Reply;
  readonly execute?: (args: ReadonlyArray<string>) => Reply;
  readonly git?: (args: ReadonlyArray<string>) => GitReply;
  readonly list?: (input: Parameters<AzureDevOpsCliShape["listPullRequests"]>[0]) => Reply;
}) {
  const calls = {
    invokes: [] as AzureDevOpsInvokeInput[],
    executes: [] as ReadonlyArray<string>[],
    files: [] as { contents: string; args: ReadonlyArray<string> }[],
    git: [] as ReadonlyArray<string>[],
    lists: [] as Parameters<AzureDevOpsCliShape["listPullRequests"]>[0][],
  };
  const respond = (reply: Reply) =>
    isCliError(reply)
      ? Effect.fail(reply)
      : Effect.succeed(typeof reply === "string" ? reply : JSON.stringify(reply ?? null));
  const unrouted = (what: string) => Effect.die(new Error(`unrouted ${what}`));
  const azure: AzureDevOpsCliShape = {
    execute: (input) => {
      calls.executes.push(input.args);
      const reply = routes.execute?.(input.args);
      if (reply === undefined) return unrouted(`execute ${input.args.join(" ")}`);
      return isCliError(reply)
        ? Effect.fail(reply)
        : Effect.succeed(output({ stdout: JSON.stringify(reply) }));
    },
    getRawPullRequest: () => {
      const result = decodeAzureDevOpsRawPullRequestJson(
        JSON.stringify(routes.pullRequest ?? AZURE_PULL_REQUEST_22),
      );
      return Result.isSuccess(result)
        ? Effect.succeed(result.success)
        : Effect.die(new Error("bad pull request fixture"));
    },
    invoke: (input) => {
      calls.invokes.push(input);
      const reply = routes.invoke?.(input);
      return reply === undefined ? unrouted(`invoke ${input.resource}`) : respond(reply);
    },
    executeWithFile: (input) => {
      calls.files.push({ contents: input.contents, args: input.args("/tmp/ryco-az-body.md") });
      return Effect.succeed("{}");
    },
    runGit: (input) => {
      calls.git.push(input.args);
      const reply = routes.git?.(input.args);
      return reply === undefined
        ? unrouted(`git ${input.args.join(" ")}`)
        : Effect.succeed(output(reply));
    },
    listPullRequests: (input) => {
      calls.lists.push(input);
      const reply = routes.list?.(input) ?? AZURE_PULL_REQUEST_LIST;
      const decoded = decodeAzureDevOpsPullRequestListJson(JSON.stringify(reply));
      return Result.isSuccess(decoded) ? Effect.succeed(decoded.success) : Effect.die("bad list");
    },
    getPullRequest: () => unrouted("getPullRequest"),
    getRepositoryCloneUrls: () => unrouted("getRepositoryCloneUrls"),
    createRepository: () => unrouted("createRepository"),
    createPullRequest: () => unrouted("createPullRequest"),
    getDefaultBranch: () => unrouted("getDefaultBranch"),
    checkoutPullRequest: () => unrouted("checkoutPullRequest"),
    listWorkItems: () => unrouted("listWorkItems"),
    getWorkItem: () => unrouted("getWorkItem"),
    searchWorkItems: () => unrouted("searchWorkItems"),
    searchPullRequests: () => unrouted("searchPullRequests"),
  };
  return { azure, calls, page: makeAzureDevOpsPullRequestOperations(azure) };
}

/** Read endpoints of PR 22 answered from the official samples. */
function readRoutes(input: AzureDevOpsInvokeInput): Reply {
  switch (input.resource) {
    case "pullRequestIterations":
      return AZURE_ITERATIONS_22;
    case "pullRequestCommits":
      return AZURE_COMMITS_22;
    case "pullRequestThreads":
      return input.routeParameters["threadId"] === 148
        ? AZURE_THREADS_22.value.find((thread) => thread.id === 148)
        : AZURE_THREADS_22;
    case "connectionData":
      return AZURE_CONNECTION_DATA;
    case "Permissions":
      return { count: 1, value: [true] };
    case "pullRequestIterationChanges":
      return AZURE_ITERATION_CHANGES_22;
    default:
      return undefined;
  }
}

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  return Cause.squash(exit.cause) as E;
};

describe("getActivity", () => {
  it.effect(
    "reads iterations, commits, identity and permissions, then threads tracked to the latest iteration",
    () =>
      Effect.gen(function* () {
        const { page, calls } = fakeAzure({ invoke: readRoutes });
        const activity = yield* page.getActivity({ cwd: "/repo", reference: "22" });

        assert.strictEqual(activity.provider, "azure-devops");
        assert.strictEqual(activity.number, 22);
        assert.strictEqual(activity.headSha, HEAD);
        assert.strictEqual(activity.pendingReview, null);
        assert.deepStrictEqual(activity.viewer, {
          login: "fabrikamfiber16@hotmail.com",
          isAuthor: true,
          canUpdate: true,
          canMerge: true,
          canReview: true,
          canUpdateBranch: false,
          canEnableAutoMerge: true,
          canDisableAutoMerge: false,
        });
        assert.strictEqual(activity.timeline.length, 6);
        assert.deepStrictEqual(
          activity.reviewThreads.map((thread) => [thread.id, thread.line]),
          [["148", 5]],
        );
        const threadsCall = calls.invokes.find((call) => call.resource === "pullRequestThreads");
        assert.deepStrictEqual(threadsCall?.routeParameters, ROUTE);
        assert.deepStrictEqual(threadsCall?.queryParameters, { $iteration: 2 });
        const permissions = calls.invokes.filter((call) => call.resource === "Permissions");
        assert.deepStrictEqual(
          permissions.map((call) => [call.area, call.routeParameters["permissions"]]),
          [
            ["Security", 16384],
            ["Security", 4],
          ],
        );
        assert.deepStrictEqual(permissions[0]?.queryParameters, {
          tokens: `repoV2/${PROJECT}/${REPOSITORY}`,
          alwaysAllowAdministrators: true,
        });
        const connection = calls.invokes.find((call) => call.resource === "connectionData");
        assert.deepStrictEqual(
          [connection?.area, connection?.apiVersion],
          ["Location", "7.1-preview"],
        );
        assert.deepStrictEqual(
          calls.invokes.find((call) => call.resource === "pullRequestCommits")?.queryParameters,
          { $top: 250 },
        );
      }),
  );

  it.effect("falls back to the profile, then loads without a viewer when identity is unknown", () =>
    Effect.gen(function* () {
      const profile = fakeAzure({
        invoke: (input) =>
          input.resource === "connectionData"
            ? fail("--area is not present in current organization")
            : input.resource === "Profiles"
              ? {
                  id: VIEWER_ID,
                  displayName: "Normal Paulk",
                  emailAddress: "fabrikamfiber16@hotmail.com",
                }
              : readRoutes(input),
      });
      const withProfile = yield* profile.page.getActivity({ cwd: "/repo", reference: "22" });
      assert.strictEqual(withProfile.viewer?.login, "fabrikamfiber16@hotmail.com");

      const anonymous = fakeAzure({
        invoke: (input) =>
          input.resource === "connectionData" || input.resource === "Profiles"
            ? fail("unauthorized")
            : input.resource === "Permissions"
              ? fail("forbidden")
              : readRoutes(input),
      });
      const withoutViewer = yield* anonymous.page.getActivity({ cwd: "/repo", reference: "22" });
      assert.strictEqual(withoutViewer.viewer, null);
      assert.strictEqual(withoutViewer.reviewThreads[0]?.viewerCanReply, false);
    }),
  );
});

describe("getDiff and file contents (local git)", () => {
  it.effect("fetches missing commits by id and diffs merge-base…head", () =>
    Effect.gen(function* () {
      const present = new Set<string>();
      const { page, calls } = fakeAzure({
        git: (args) => {
          if (args[0] === "cat-file") {
            return { exitCode: present.has(args[2]!.replace("^{commit}", "")) ? 0 : 1 };
          }
          if (args[0] === "fetch") {
            for (const sha of args.slice(4)) present.add(sha);
            return {};
          }
          return { stdout: "diff --git a/new_feature.cpp b/new_feature.cpp\n" };
        },
      });
      const diff = yield* page.getDiff({
        cwd: "/repo",
        reference: "22",
        remoteName: "upstream",
        expectedHeadSha: HEAD,
      });
      assert.strictEqual(diff, "diff --git a/new_feature.cpp b/new_feature.cpp\n");
      assert.deepStrictEqual(
        calls.git.find((args) => args[0] === "fetch"),
        ["fetch", "--quiet", "--no-tags", "upstream", TARGET, HEAD],
      );
      // Pinned prefixes and no textconv: the user's `diff.noprefix` / `diff.srcPrefix`
      // would otherwise produce headers the page's diff parser rejects.
      assert.deepStrictEqual(calls.git.at(-1), [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--no-relative",
        "--submodule=short",
        `${TARGET}...${HEAD}`,
      ]);
    }),
  );

  it.effect("refuses a moved head, falls back to pull request refs, and caps size", () =>
    Effect.gen(function* () {
      const moved = fakeAzure({});
      const movedError = failure(
        yield* moved.page
          .getDiff({
            cwd: "/repo",
            reference: "22",
            remoteName: "origin",
            expectedHeadSha: OLD_HEAD,
          })
          .pipe(Effect.exit),
      );
      expect(movedError.detail).toMatch(/changed while loading the diff/);
      assert.strictEqual(moved.calls.git.length, 0);

      const present = new Set<string>();
      const refs = fakeAzure({
        git: (args) => {
          if (args[0] === "cat-file") {
            return { exitCode: present.has(args[2]!.replace("^{commit}", "")) ? 0 : 1 };
          }
          if (args[0] === "fetch") {
            // The server refuses unadvertised objects; the merge ref brings both parents.
            if (args[4] === "refs/pull/22/merge") {
              present.add(TARGET);
              present.add(HEAD);
            }
            return { exitCode: args[4] === "refs/pull/22/merge" ? 0 : 128 };
          }
          return { stdout: "x".repeat(10), stdoutTruncated: true };
        },
      });
      const tooLarge = failure(
        yield* refs.page
          .getDiff({ cwd: "/repo", reference: "22", remoteName: "origin" })
          .pipe(Effect.exit),
      );
      assert.strictEqual(tooLarge.detail, "This diff is too large to display.");
      expect(refs.calls.git.filter((args) => args[0] === "fetch").map((args) => args[4])).toEqual([
        TARGET,
        "refs/pull/22/merge",
        "refs/heads/npaulk/my_work",
        "refs/heads/new_feature",
      ]);
    }),
  );

  it.effect("scopes a diff to one of the pull request's commits", () =>
    Effect.gen(function* () {
      const { page, calls } = fakeAzure({
        invoke: readRoutes,
        git: (args) => (args[0] === "diff" ? { stdout: "commit diff" } : {}),
      });
      const diff = yield* page.getDiff({
        cwd: "/repo",
        reference: "22",
        remoteName: "origin",
        commitSha: "8c9396b",
      });
      assert.strictEqual(diff, "commit diff");
      assert.deepStrictEqual(calls.git.at(-1)?.slice(-2), [`${HEAD}^1`, HEAD]);

      const outside = failure(
        yield* page
          .getDiff({ cwd: "/repo", reference: "22", remoteName: "origin", commitSha: "deadbeef" })
          .pipe(Effect.exit),
      );
      assert.strictEqual(outside.detail, "Commit deadbeef is not part of pull request #22.");
    }),
  );

  it.effect("reads both sides at merge-base and head; absent or binary sides are null", () =>
    Effect.gen(function* () {
      const base = "1111111111111111111111111111111111111111";
      const { page, calls } = fakeAzure({
        git: (args) => {
          if (args[0] === "merge-base") return { stdout: `${base}\n` };
          if (args[0] === "cat-file" && args[1] === "blob") {
            if (args[2] === `${base}:src/old.ts`) return { exitCode: 128 };
            if (args[2] === `${HEAD}:src/new.ts`) return { stdout: "export {};\n" };
            return { stdout: "\u0000PNG" };
          }
          return {};
        },
      });
      const contents = yield* page.getFileContents({
        cwd: "/repo",
        reference: "22",
        remoteName: "origin",
        path: "src/new.ts",
        previousPath: "src/old.ts",
        headSha: HEAD,
      });
      assert.deepStrictEqual(contents, {
        path: "src/new.ts",
        oldContents: null,
        newContents: "export {};\n",
        truncated: false,
      });
      assert.deepStrictEqual(
        calls.git.find((args) => args[0] === "merge-base"),
        ["merge-base", TARGET, HEAD],
      );

      const invalidPath = failure(
        yield* page
          .getFileContents({
            cwd: "/repo",
            reference: "22",
            remoteName: "origin",
            path: "../etc/passwd",
            headSha: HEAD,
          })
          .pipe(Effect.exit),
      );
      assert.strictEqual(invalidPath.detail, "Invalid repository file path: ../etc/passwd");
      const invalidSha = failure(
        yield* page
          .getFileContents({
            cwd: "/repo",
            reference: "22",
            remoteName: "origin",
            path: "a.ts",
            headSha: "--output=x",
          })
          .pipe(Effect.exit),
      );
      assert.strictEqual(invalidSha.detail, "Invalid commit id: --output=x");
    }),
  );
});

describe("review mutations", () => {
  it.effect("submits a review: body thread, anchored line thread, then the vote", () =>
    Effect.gen(function* () {
      const { page, calls } = fakeAzure({
        invoke: (input) =>
          input.httpMethod === "POST" && input.resource === "pullRequestThreads"
            ? AZURE_FILE_THREAD_CREATED
            : readRoutes(input),
        execute: () => ({ id: VIEWER_ID, vote: 10 }),
      });
      const result = yield* page.submitReview({
        cwd: "/repo",
        reference: "22",
        event: "approve",
        body: "Looks good.",
        comments: [
          {
            path: "new_feature.cpp",
            body: "Should we add a comment about what this value means?",
            line: 5,
            side: "right",
          },
        ],
        expectedHeadSha: HEAD,
        webUrl: "https://dev.azure.com/fabrikam/_git/2016_10_31/pullrequest/22",
      });
      assert.deepStrictEqual(result, {
        reviewId: `vote:${VIEWER_ID}:10`,
        state: "approved",
        url: "https://dev.azure.com/fabrikam/_git/2016_10_31/pullrequest/22",
      });
      const changes = calls.invokes.find((call) => call.resource === "pullRequestIterationChanges");
      assert.deepStrictEqual(changes?.routeParameters, { ...ROUTE, iterationId: 2 });
      assert.deepStrictEqual(changes?.queryParameters, { $top: 2000, $compareTo: 0 });
      const posts = calls.invokes.filter((call) => call.httpMethod === "POST");
      assert.deepStrictEqual(
        posts.map((call) => call.body),
        [
          { comments: [{ parentCommentId: 0, content: "Looks good.", commentType: 1 }], status: 1 },
          {
            comments: [
              {
                parentCommentId: 0,
                content: "Should we add a comment about what this value means?",
                commentType: 1,
              },
            ],
            status: 1,
            threadContext: {
              filePath: "/new_feature.cpp",
              rightFileStart: { line: 5, offset: 1 },
              rightFileEnd: { line: 5, offset: 1 },
            },
            pullRequestThreadContext: {
              changeTrackingId: 1,
              iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 },
            },
          },
        ],
      );
      assert.deepStrictEqual(calls.executes.at(-1), [
        "repos",
        "pr",
        "set-vote",
        "--detect",
        "true",
        "--id",
        "22",
        "--vote",
        "approve",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }),
  );

  it.effect("posts nothing when the head moved, and maps request-changes to wait-for-author", () =>
    Effect.gen(function* () {
      const stale = fakeAzure({ invoke: readRoutes });
      const error = failure(
        yield* stale.page
          .submitReview({
            cwd: "/repo",
            reference: "22",
            event: "comment",
            comments: [{ path: "new_feature.cpp", body: "x", line: 1 }],
            expectedHeadSha: OLD_HEAD,
          })
          .pipe(Effect.exit),
      );
      assert.strictEqual(error.detail, AZURE_DEVOPS_HEAD_CHANGED_DETAIL);
      assert.strictEqual(
        stale.calls.invokes.filter((call) => call.httpMethod === "POST").length,
        0,
      );

      const vote = fakeAzure({ invoke: readRoutes, execute: () => ({ id: VIEWER_ID, vote: -5 }) });
      const result = yield* vote.page.submitReview({
        cwd: "/repo",
        reference: "22",
        event: "request_changes",
        comments: [],
        expectedHeadSha: HEAD,
      });
      assert.strictEqual(result.state, "changes_requested");
      assert.strictEqual(vote.calls.executes.at(-1)?.[8], "wait-for-author");
    }),
  );

  it.effect("replies to the thread's first comment and returns the refreshed thread", () =>
    Effect.gen(function* () {
      const { page, calls } = fakeAzure({
        invoke: (input) =>
          input.resource === "pullRequestThreadComments"
            ? { ...AZURE_COMMENT_CREATE_REQUEST, id: 2 }
            : readRoutes(input),
      });
      const thread = yield* page.replyToThread({
        cwd: "/repo",
        reference: "22",
        threadId: "148",
        body: "Good idea",
      });
      assert.strictEqual(thread.id, "148");
      const post = calls.invokes.find((call) => call.resource === "pullRequestThreadComments");
      assert.deepStrictEqual(post?.routeParameters, { ...ROUTE, threadId: 148 });
      assert.deepStrictEqual(post?.body, AZURE_COMMENT_CREATE_REQUEST);
      // The refreshed read tracks positions to the latest iteration.
      assert.deepStrictEqual(calls.invokes.at(-1)?.queryParameters, { $iteration: 2 });
    }),
  );

  it.effect("resolves and reopens threads with PATCH status", () =>
    Effect.gen(function* () {
      const { page, calls } = fakeAzure({
        invoke: (input) => ({
          ...AZURE_FILE_THREAD_CREATED,
          status: (input.body as { status: string }).status,
        }),
      });
      const resolved = yield* page.setThreadResolved({
        cwd: "/repo",
        reference: "22",
        threadId: "148",
        resolved: true,
      });
      assert.deepStrictEqual(resolved, { threadId: "148", isResolved: true });
      assert.deepStrictEqual(calls.invokes[0]?.body, { status: "fixed" });
      assert.strictEqual(calls.invokes[0]?.httpMethod, "PATCH");
      const reopened = yield* page.setThreadResolved({
        cwd: "/repo",
        reference: "22",
        threadId: "148",
        resolved: false,
      });
      assert.strictEqual(reopened.isResolved, false);
    }),
  );

  it.effect("edits and deletes comments by thread and comment id", () =>
    Effect.gen(function* () {
      const { page, calls } = fakeAzure({
        invoke: (input) => (input.httpMethod === "DELETE" ? "" : AZURE_THREAD_CREATED.comments[0]),
      });
      const edited = yield* page.updateComment({
        cwd: "/repo",
        reference: "22",
        commentId: "147:1",
        commentKind: "issue-comment",
        action: "edit",
        body: "Edited",
      });
      assert.deepStrictEqual(edited, { commentId: "147:1", deleted: false });
      assert.deepStrictEqual(calls.invokes[0]?.routeParameters, {
        ...ROUTE,
        threadId: 147,
        commentId: 1,
      });
      assert.deepStrictEqual(calls.invokes[0]?.body, { content: "Edited" });
      const deleted = yield* page.updateComment({
        cwd: "/repo",
        reference: "22",
        commentId: "148:2",
        commentKind: "review-comment",
        action: "delete",
      });
      assert.deepStrictEqual(deleted, { commentId: "148:2", deleted: true });
      assert.strictEqual(calls.invokes[1]?.httpMethod, "DELETE");
      const invalid = failure(
        yield* page
          .updateComment({
            cwd: "/repo",
            reference: "22",
            commentId: "PRRC_1",
            commentKind: "issue-comment",
            action: "delete",
          })
          .pipe(Effect.exit),
      );
      assert.strictEqual(invalid.detail, "Invalid comment id: PRRC_1");
    }),
  );
});

describe("lifecycle and merge", () => {
  const update = (
    action: Parameters<ReturnType<typeof fakeAzure>["page"]["updatePullRequest"]>[0]["action"],
    routes: Parameters<typeof fakeAzure>[0] = {},
  ) => {
    const fake = fakeAzure({ invoke: readRoutes, execute: () => ({}), ...routes });
    return fake.page.updatePullRequest({ cwd: "/repo", reference: "22", action }).pipe(
      Effect.exit,
      Effect.map((exit) => ({ exit, calls: fake.calls })),
    );
  };
  const cliArgs = (args: ReadonlyArray<string> | undefined) => args?.slice(0, -3).join(" ");

  it.effect("edits title and body through a staged file, and retargets with PATCH", () =>
    Effect.gen(function* () {
      const { calls } = yield* update(
        { kind: "edit", title: "Retitled", body: "New body", baseRefName: "main" },
        { invoke: () => AZURE_PULL_REQUEST_22 },
      );
      assert.deepStrictEqual(calls.files, [
        {
          contents: "New body",
          args: [
            "repos",
            "pr",
            "update",
            "--detect",
            "true",
            "--id",
            "22",
            "--title",
            "Retitled",
            "--description",
            "@/tmp/ryco-az-body.md",
          ],
        },
      ]);
      assert.deepStrictEqual(calls.invokes[0], {
        cwd: "/repo",
        operation: "updateChangeRequest",
        area: "git",
        resource: "pullRequests",
        routeParameters: ROUTE,
        httpMethod: "PATCH",
        body: { targetRefName: "refs/heads/main" },
      });
      const tooLong = yield* update({ kind: "edit", body: "x".repeat(4001) });
      expect(failure(tooLong.exit).detail).toMatch(/limited to 4000 characters/);
      assert.strictEqual(tooLong.calls.files.length, 0);
    }),
  );

  it.effect("maps draft, close, reopen, reviewers and auto-merge off to az repos pr", () =>
    Effect.gen(function* () {
      const draft = yield* update({ kind: "set-draft", draft: true });
      assert.strictEqual(
        cliArgs(draft.calls.executes[0]),
        "repos pr update --detect true --id 22 --draft true",
      );
      const reopen = yield* update({ kind: "reopen" });
      assert.strictEqual(
        cliArgs(reopen.calls.executes[0]),
        "repos pr update --detect true --id 22 --status active",
      );
      const reviewers = yield* update({
        kind: "reviewers",
        add: ["a@x.com", "b@x.com"],
        remove: ["c@x.com"],
      });
      assert.deepStrictEqual(reviewers.calls.executes.map(cliArgs), [
        "repos pr reviewer add --detect true --id 22 --reviewers a@x.com b@x.com",
        "repos pr reviewer remove --detect true --id 22 --reviewers c@x.com",
      ]);
      const autoOff = yield* update({ kind: "auto-merge", enabled: false });
      assert.strictEqual(
        cliArgs(autoOff.calls.executes[0]),
        "repos pr update --detect true --id 22 --auto-complete false",
      );
    }),
  );

  it.effect("abandons and deletes the head branch only at the commit it last saw", () =>
    Effect.gen(function* () {
      const closed = yield* update(
        { kind: "close", deleteBranch: true },
        { invoke: () => AZURE_REF_UPDATE_RESULT },
      );
      assert.strictEqual(
        cliArgs(closed.calls.executes[0]),
        "repos pr update --detect true --id 22 --status abandoned",
      );
      assert.deepStrictEqual(closed.calls.invokes[0]?.routeParameters, {
        project: PROJECT,
        repositoryId: REPOSITORY,
      });
      assert.deepStrictEqual(closed.calls.invokes[0]?.body, [
        { name: "refs/heads/npaulk/my_work", oldObjectId: HEAD, newObjectId: "0".repeat(40) },
      ]);
      const rejected = yield* update(
        { kind: "delete-branch" },
        {
          invoke: () => ({
            value: [
              {
                ...AZURE_REF_UPDATE_RESULT.value[0],
                success: false,
                updateStatus: "staleOldObjectId",
              },
            ],
            count: 1,
          }),
        },
      );
      assert.strictEqual(
        failure(rejected.exit).detail,
        "Could not delete npaulk/my_work (staleOldObjectId).",
      );
    }),
  );

  it.effect("adds and removes labels", () =>
    Effect.gen(function* () {
      const { calls } = yield* update(
        { kind: "labels", add: ["bug"], remove: ["wip"] },
        { invoke: () => ({ name: "bug", active: true }) },
      );
      assert.deepStrictEqual(
        calls.invokes.map((call) => [
          call.resource,
          call.httpMethod,
          call.routeParameters["labelIdOrName"],
          call.body,
        ]),
        [
          ["pullRequestLabels", "POST", undefined, { name: "bug" }],
          ["pullRequestLabels", "DELETE", "wip", undefined],
        ],
      );
    }),
  );

  it.effect(
    "arms auto-complete as the viewer with the chosen strategy, never on a moved head",
    () =>
      Effect.gen(function* () {
        const armed = yield* update(
          { kind: "auto-merge", enabled: true, mergeMethod: "squash", expectedHeadSha: HEAD },
          {
            invoke: (input) =>
              input.resource === "pullRequests" ? AZURE_PULL_REQUEST_22 : readRoutes(input),
          },
        );
        assert.ok(Exit.isSuccess(armed.exit));
        assert.deepStrictEqual(armed.calls.invokes.at(-1)?.body, {
          autoCompleteSetBy: { id: VIEWER_ID },
          completionOptions: { mergeStrategy: "squash" },
        });
        const moved = yield* update({
          kind: "auto-merge",
          enabled: true,
          expectedHeadSha: OLD_HEAD,
        });
        assert.strictEqual(failure(moved.exit).detail, AZURE_DEVOPS_HEAD_CHANGED_DETAIL);
        assert.strictEqual(moved.calls.invokes.length, 0);
        const assignees = yield* update({ kind: "assignees", add: ["a"], remove: [] });
        assert.strictEqual(
          failure(assignees.exit).detail,
          "Azure DevOps pull requests have no assignees.",
        );
      }),
  );

  it.effect("completes with lastMergeSourceCommit as the head precondition", () =>
    Effect.gen(function* () {
      const merged = fakeAzure({
        invoke: () => ({ ...AZURE_PULL_REQUEST_22, status: "completed" }),
      });
      const result = yield* merged.page.merge({
        cwd: "/repo",
        reference: "22",
        mergeMethod: "rebase",
        deleteBranch: true,
        expectedHeadSha: HEAD,
      });
      assert.deepStrictEqual(result, { outcome: "merged" });
      assert.deepStrictEqual(merged.calls.invokes[0]?.body, {
        status: "completed",
        lastMergeSourceCommit: { commitId: HEAD },
        completionOptions: { mergeStrategy: "rebase", deleteSourceBranch: true },
      });

      const queued = fakeAzure({
        invoke: () => ({ ...AZURE_PULL_REQUEST_22, mergeStatus: "queued" }),
      });
      const enqueued = yield* queued.page.merge({
        cwd: "/repo",
        reference: "22",
        mergeMethod: "merge",
      });
      assert.deepStrictEqual(enqueued, { outcome: "enqueued" });
      assert.deepStrictEqual(
        (queued.calls.invokes[0]!.body as { completionOptions: unknown }).completionOptions,
        { mergeStrategy: "noFastForward", deleteSourceBranch: false },
      );

      const stale = fakeAzure({});
      const error = failure(
        yield* stale.page
          .merge({
            cwd: "/repo",
            reference: "22",
            mergeMethod: "squash",
            expectedHeadSha: OLD_HEAD,
          })
          .pipe(Effect.exit),
      );
      assert.strictEqual(error.detail, AZURE_DEVOPS_HEAD_CHANGED_DETAIL);
      assert.strictEqual(stale.calls.invokes.length, 0);
    }),
  );
});

describe("lists, detail and pickers", () => {
  it.effect(
    "filters by involvement with --creator / --reviewer me and matches titles locally",
    () =>
      Effect.gen(function* () {
        const { page, calls } = fakeAzure({});
        const authored = yield* page.listChangeRequests({
          cwd: "/repo",
          headSelector: "",
          state: "open",
          involvement: "authored",
        });
        assert.strictEqual(calls.lists[0]?.creator, "me");
        assert.deepStrictEqual(
          authored.map((row) => row.number),
          [22, 21, 1],
        );
        yield* page.listChangeRequests({
          cwd: "/repo",
          headSelector: "",
          state: "open",
          involvement: "review-requested",
        });
        assert.strictEqual(calls.lists[1]?.reviewer, "me");
        const involved = yield* page.listChangeRequests({
          cwd: "/repo",
          headSelector: "",
          state: "open",
          involvement: "involved",
        });
        assert.deepStrictEqual(
          involved.map((row) => row.number),
          [22, 21, 1],
        );
        const searched = yield* page.listChangeRequests({
          cwd: "/repo",
          headSelector: "",
          state: "open",
          limit: 5,
          involvement: "authored",
          query: "known issues",
        });
        assert.deepStrictEqual(
          searched.map((row) => row.number),
          [21],
        );
        assert.strictEqual(calls.lists.at(-1)?.limit, 100);
        const assigned = failure(
          yield* page
            .listChangeRequests({
              cwd: "/repo",
              headSelector: "",
              state: "open",
              involvement: "assigned",
            })
            .pipe(Effect.exit),
        );
        assert.strictEqual(
          assigned.detail,
          "Azure DevOps has no assignees on pull requests to filter by.",
        );
      }),
  );

  it.effect("builds the detail with readiness, commits and comments; policies are optional", () =>
    Effect.gen(function* () {
      const withPolicies = fakeAzure({
        invoke: readRoutes,
        execute: () =>
          azurePolicyEvaluations({
            build: "running",
            minimumApprovals: "approved",
            mergeStrategy: true,
          }),
      });
      const detail = yield* withPolicies.page.getDetail({ cwd: "/repo", reference: "22" });
      assert.strictEqual(
        detail.url,
        "https://dev.azure.com/fabrikam/_git/2016_10_31/pullrequest/22",
      );
      assert.strictEqual(detail.body, "Adding a new feature");
      assert.deepStrictEqual(
        detail.comments.map((comment) => comment.id),
        ["147:1", "148:1"],
      );
      assert.deepStrictEqual(
        detail.commits.map((commit) => commit.shortOid),
        ["8c9396b"],
      );
      assert.deepStrictEqual(detail.reviewers, ["fabrikamfiber16@hotmail.com"]);
      assert.strictEqual(detail.reviewDecision, "approved");
      assert.strictEqual(detail.mergeStateStatus, "blocked");
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: false,
        squash: true,
        rebase: false,
      });
      assert.strictEqual(detail.headSha, HEAD);
      assert.strictEqual(detail.mergeability, "mergeable");
      assert.deepStrictEqual(withPolicies.calls.executes[0]?.slice(0, 7), [
        "repos",
        "pr",
        "policy",
        "list",
        "--detect",
        "true",
        "--id",
      ]);

      const withoutPolicies = fakeAzure({ invoke: readRoutes, execute: () => fail("forbidden") });
      const plain = yield* withoutPolicies.page.getDetail({ cwd: "/repo", reference: "22" });
      assert.strictEqual(plain.mergeStateStatus, undefined);
      assert.deepStrictEqual(plain.mergeCapabilities, { merge: true, squash: true, rebase: true });
      assert.ok(Option.isNone(Option.fromNullishOr(plain.closedAt)));
    }),
  );

  it.effect("offers the default team's members as reviewers and project tags as labels", () =>
    Effect.gen(function* () {
      const { page, calls } = fakeAzure({
        execute: (args) =>
          args[0] === "repos"
            ? { id: REPOSITORY, project: { id: PROJECT, name: "2016_10_31" } }
            : args[1] === "project"
              ? {
                  id: PROJECT,
                  defaultTeam: {
                    id: "564e8204-a90b-4432-883b-d4363c6125ca",
                    name: "2016_10_31 Team",
                  },
                }
              : AZURE_TEAM_MEMBERS,
        invoke: () => AZURE_TAGS,
      });
      const people = yield* page.listAssignees({ cwd: "/repo" });
      assert.deepStrictEqual(
        people.map((person) => [person.login, person.displayName]),
        [
          ["fabrikamfiber1@hotmail.com", "Christie Church"],
          ["fabrikamfiber3@hotmail.com", "Chuck Reinhart"],
          ["fabrikamfiber2@hotmail.com", "Johnnie McLeod"],
        ],
      );
      assert.deepStrictEqual(calls.executes[2]?.slice(0, 9), [
        "devops",
        "team",
        "list-member",
        "--detect",
        "true",
        "--project",
        PROJECT,
        "--team",
        "564e8204-a90b-4432-883b-d4363c6125ca",
      ]);
      const labels = yield* page.listLabels({ cwd: "/repo" });
      assert.deepStrictEqual(labels, [{ name: "my-first-tag" }, { name: "my-second-tag" }]);
      assert.deepStrictEqual(
        [calls.invokes[0]?.area, calls.invokes[0]?.resource, calls.invokes[0]?.routeParameters],
        ["wit", "tags", { project: PROJECT }],
      );
    }),
  );
});
