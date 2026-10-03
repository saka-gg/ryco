import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import {
  AZURE_PULL_REQUEST_22,
  AZURE_PULL_REQUEST_LIST,
} from "./azureDevOpsPullRequestPage.fixtures.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();

const supportLayer = Layer.mergeAll(
  Layer.mock(VcsProcess.VcsProcess)({
    run: mockRun,
  }),
  NodeServices.layer,
);
const layer = Layer.mergeAll(AzureDevOpsCli.layer.pipe(Layer.provide(supportLayer)), supportLayer);

afterEach(() => {
  mockRun.mockReset();
});

describe("AzureDevOpsCli.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add Azure provider",
              sourceRefName: "refs/heads/feature/source-control",
              targetRefName: "refs/heads/main",
              status: "active",
              creationDate: "2026-01-02T00:00:00.000Z",
              closedDate: null,
              _links: {
                web: {
                  href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
                },
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0], {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
        env: { LC_ALL: "C" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists pull requests with Azure status and source branch arguments", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                pullRequestId: 7,
                title: "Merged work",
                sourceRefName: "refs/heads/feature/merged",
                targetRefName: "refs/heads/main",
                status: "completed",
                closedDate: "2026-01-03T00:00:00.000Z",
                _links: {
                  web: {
                    href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/7",
                  },
                },
              },
            ]),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.listPullRequests({
        cwd: "/repo",
        headSelector: "origin:feature/merged",
        state: "merged",
        limit: 10,
      });

      assert.strictEqual(result[0]?.state, "merged");
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          "feature/merged",
          "--status",
          "completed",
          "--top",
          "10",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
        env: { LC_ALL: "C" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "repo",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories through Azure Repos", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.createRepository({
        cwd: "/repo",
        repository: "project/repo",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "create",
          "--detect",
          "true",
          "--name",
          "repo",
          "--project",
          "project",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
        env: { LC_ALL: "C" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates pull requests using the body file as the Azure description", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = `/tmp/ryco-azure-devops-cli-${Date.now()}.md`;
      yield* fileSystem.writeFileString(bodyFile, "Generated body");
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        title: "Provider PR",
        bodyFile,
      });

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "az",
          cwd: "/repo",
          args: expect.arrayContaining(["--description", `@${bodyFile}`]),
        }),
      );
      expect(mockRun.mock.calls[0]?.[0].args).not.toContain("--output");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not force JSON output on checkout side-effect commands", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.checkoutPullRequest({
        cwd: "/repo",
        reference: "42",
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "checkout",
          "--only-show-errors",
          "--detect",
          "true",
          "--id",
          "42",
          "--remote-name",
          "origin",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
        env: { LC_ALL: "C" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("getWorkItem invokes az boards work-item show with --id", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              id: 42,
              fields: {
                "System.Title": "Detailed",
                "System.State": "Active",
                "System.Description": "<p>issue body</p>",
              },
            }),
          ),
        ),
      );
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const detail = yield* az.getWorkItem({ cwd: "/repo", reference: "42" });
      expect(detail.body.trim()).toBe("issue body");
      const call = mockRun.mock.calls[mockRun.mock.calls.length - 1]?.[0];
      expect(call?.args).toContain("--id");
      expect(call?.args).toContain("42");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("invokes REST endpoints with route/query parameters and a temp-file body", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let stagedBody: string | null = null;
      let stagedFile: string | null = null;
      mockRun.mockImplementationOnce((input) => {
        const index = input.args.indexOf("--in-file");
        stagedFile = input.args[index + 1] ?? null;
        return fileSystem.readFileString(stagedFile!).pipe(
          Effect.orDie,
          Effect.tap((body) => Effect.sync(() => (stagedBody = body))),
          Effect.as(processOutput('{"id":148}')),
        );
      });

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const raw = yield* az.invoke({
        cwd: "/repo",
        operation: "createThread",
        area: "git",
        resource: "pullRequestThreads",
        routeParameters: { project: "p", repositoryId: "r", pullRequestId: 22 },
        queryParameters: { $iteration: 2 },
        httpMethod: "POST",
        body: {
          comments: [{ parentCommentId: 0, content: "Body; $(not a shell)", commentType: 1 }],
        },
      });

      assert.strictEqual(raw, '{"id":148}');
      const args = mockRun.mock.calls[0]?.[0].args ?? [];
      assert.deepStrictEqual(args.slice(0, args.indexOf("--in-file")), [
        "devops",
        "invoke",
        "--detect",
        "true",
        "--area",
        "git",
        "--resource",
        "pullRequestThreads",
        "--route-parameters",
        "project=p",
        "repositoryId=r",
        "pullRequestId=22",
        "--query-parameters",
        "$iteration=2",
        "--http-method",
        "POST",
        "--api-version",
        "7.1",
      ]);
      assert.deepStrictEqual(args.slice(-3), ["--only-show-errors", "--output", "json"]);
      // The body travels in the file, never on argv, and the file is removed.
      assert.ok(!args.some((arg) => arg.includes("not a shell")));
      assert.deepStrictEqual(JSON.parse(stagedBody ?? "null"), {
        comments: [{ parentCommentId: 0, content: "Body; $(not a shell)", commentType: 1 }],
      });
      assert.strictEqual(yield* fileSystem.exists(stagedFile!), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("omits empty route parameters and maps invoke failures", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "AzureDevOpsCli.execute",
            command: "az devops invoke",
            cwd: "/repo",
            exitCode: 1,
            detail: "ERROR: --area is not present in current organization",
          }),
        ),
      );
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az
        .invoke({
          cwd: "/repo",
          operation: "getConnectionData",
          area: "Location",
          resource: "connectionData",
          routeParameters: {},
          apiVersion: "7.1-preview",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.operation, "getConnectionData");
      expect(error.detail).toContain("--area is not present");
      const args = mockRun.mock.calls[0]?.[0].args ?? [];
      assert.ok(!args.includes("--route-parameters"));
      assert.ok(!args.includes("--in-file"));
      assert.deepStrictEqual(
        args.slice(args.indexOf("--api-version"), args.indexOf("--api-version") + 2),
        ["--api-version", "7.1-preview"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs git without prompts and decodes the full pull request", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("abc\n")));
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.runGit({ cwd: "/repo", operation: "mergeBase", args: ["merge-base", "a", "b"] });
      assert.deepStrictEqual(mockRun.mock.calls[0]?.[0], {
        operation: "AzureDevOpsCli.git.mergeBase",
        command: "git",
        args: ["merge-base", "a", "b"],
        cwd: "/repo",
        timeoutMs: 60_000,
        env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never" },
      });

      mockRun.mockReturnValueOnce(
        Effect.succeed(processOutput(JSON.stringify(AZURE_PULL_REQUEST_22))),
      );
      const pullRequest = yield* az.getRawPullRequest({ cwd: "/repo", reference: "#22" });
      assert.strictEqual(pullRequest.repository?.id, "3411ebc1-d5aa-464f-9615-0b527bc66719");
      assert.strictEqual(
        pullRequest.lastMergeSourceCommit?.commitId,
        "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
      );
      assert.deepStrictEqual(mockRun.mock.calls[1]?.[0].args.slice(0, 7), [
        "repos",
        "pr",
        "show",
        "--detect",
        "true",
        "--id",
        "22",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("passes involvement filters and draft creation to az repos pr", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(processOutput(JSON.stringify(AZURE_PULL_REQUEST_LIST))),
      );
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const rows = yield* az.listPullRequests({
        cwd: "/repo",
        headSelector: "",
        state: "open",
        creator: "me",
        reviewer: "me",
      });
      assert.deepStrictEqual(
        rows.map((row) => [row.number, row.mergeability]),
        [
          [22, "mergeable"],
          [21, "mergeable"],
          [1, "mergeable"],
        ],
      );
      const listArgs = mockRun.mock.calls[0]?.[0].args ?? [];
      expect(listArgs).toEqual(expect.arrayContaining(["--creator", "me", "--reviewer", "me"]));

      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      yield* az.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        title: "Provider PR",
        bodyFile: "/tmp/body.md",
        draft: true,
      });
      expect(mockRun.mock.calls[1]?.[0].args.slice(-2)).toEqual(["--draft", "true"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("searchPullRequests filters via JMESPath query", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.searchPullRequests({ cwd: "/repo", query: "fix" });
      const call = mockRun.mock.calls[mockRun.mock.calls.length - 1]?.[0];
      expect(call?.args).toContain("repos");
      expect(call?.args).toContain("pr");
      expect(call?.args).toContain("list");
      const queryArg = (call?.args ?? []).find(
        (a) => typeof a === "string" && a.includes("contains(title"),
      );
      expect(queryArg).toContain("'fix'");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("searchWorkItems builds WIQL with title CONTAINS clause", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.searchWorkItems({ cwd: "/repo", query: "memory leak" });
      const call = mockRun.mock.calls[mockRun.mock.calls.length - 1]?.[0];
      const wiql = (call?.args ?? []).find(
        (a) => typeof a === "string" && a.toUpperCase().includes("SELECT"),
      );
      expect(typeof wiql === "string" && wiql.toLowerCase()).toContain("contains");
      expect(typeof wiql === "string" && wiql).toContain("memory leak");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("listWorkItems queries WIQL with state filter and decodes", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                id: 42,
                fields: {
                  "System.Title": "Bug",
                  "System.State": "Active",
                },
                url: "https://dev.azure.com/org/proj/_apis/wit/workItems/42",
              },
            ]),
          ),
        ),
      );
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const items = yield* az.listWorkItems({ cwd: "/repo", state: "open", limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]?.number).toBe(42);
      expect(mockRun).toHaveBeenCalled();
      const call = mockRun.mock.calls[mockRun.mock.calls.length - 1]?.[0];
      expect(call?.command).toBe("az");
      expect(call?.args).toContain("query");
      expect(
        call?.args.some((a) => typeof a === "string" && a.toUpperCase().includes("SELECT")),
      ).toBe(true);
      expect(call?.env).toEqual(expect.objectContaining({ LC_ALL: "C" }));
    }).pipe(Effect.provide(layer)),
  );
});
