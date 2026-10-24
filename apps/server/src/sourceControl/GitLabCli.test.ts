import { assert, it, afterEach, expect, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitLabCli from "./GitLabCli.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();
const layer = it.layer(
  GitLabCli.layer.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: mockedRun,
      }),
    ),
  ),
);

function processOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => {
  mockedRun.mockReset();
});

layer("GitLabCli.layer", (it) => {
  it.effect("parses merge request view output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 42,
              title: "Add MR thread creation",
              web_url: "https://gitlab.com/pingdotgg/ryco/-/merge_requests/42",
              target_branch: "main",
              source_branch: "feature/mr-threads",
              state: "opened",
              source_project_id: 101,
              target_project_id: 100,
              source_project: {
                path_with_namespace: "octocat/ryco",
              },
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add MR thread creation",
        url: "https://gitlab.com/pingdotgg/ryco/-/merge_requests/42",
        baseRefName: "main",
        headRefName: "feature/mr-threads",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/ryco",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "42", "--output", "json"],
        }),
      );
    }),
  );

  it.effect("skips invalid entries when parsing MR lists", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 0,
                title: "invalid",
                web_url: "https://gitlab.com/pingdotgg/ryco/-/merge_requests/0",
                target_branch: "main",
                source_branch: "feature/invalid",
              },
              {
                iid: 43,
                title: "  Valid MR  ",
                web_url: " https://gitlab.com/pingdotgg/ryco/-/merge_requests/43 ",
                target_branch: " main ",
                source_branch: " feature/mr-list ",
                state: "merged",
              },
            ]),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listMergeRequests({
          cwd: "/repo",
          headSelector: "feature/mr-list",
          state: "all",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid MR",
          url: "https://gitlab.com/pingdotgg/ryco/-/merge_requests/43",
          baseRefName: "main",
          headRefName: "feature/mr-list",
          state: "merged",
        },
      ]);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "mr",
            "list",
            "--source-branch",
            "feature/mr-list",
            "--all",
            "--per-page",
            "20",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              path_with_namespace: "octocat/ryco",
              web_url: "https://gitlab.com/octocat/ryco",
              http_url_to_repo: "https://gitlab.com/octocat/ryco.git",
              ssh_url_to_repo: "git@gitlab.com:octocat/ryco.git",
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/ryco",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/ryco",
        url: "https://gitlab.com/octocat/ryco",
        sshUrl: "git@gitlab.com:octocat/ryco.git",
      });
    }),
  );

  it.effect("creates merge requests through the GitLab API without placing the body in argv", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/ryco-mr-body.md",
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests",
            "--raw-field",
            "source_branch=feature/provider",
            "--raw-field",
            "target_branch=main",
            "--raw-field",
            "title=Provider MR",
            "--field",
            "description=@/tmp/ryco-mr-body.md",
          ],
        }),
      );
    }),
  );

  it.effect("creates repositories under an explicit namespace", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(Effect.succeed(processOutput(JSON.stringify({ id: 1234 }))))
        .mockReturnValueOnce(
          Effect.succeed(
            processOutput(
              JSON.stringify({
                path_with_namespace: "octocat/ryco",
                web_url: "https://gitlab.com/octocat/ryco",
                http_url_to_repo: "https://gitlab.com/octocat/ryco.git",
                ssh_url_to_repo: "git@gitlab.com:octocat/ryco.git",
              }),
            ),
          ),
        );

      const glab = yield* GitLabCli.GitLabCli;
      const result = yield* glab.createRepository({
        cwd: "/repo",
        repository: "octocat/ryco",
        visibility: "public",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/ryco",
        url: "https://gitlab.com/octocat/ryco",
        sshUrl: "git@gitlab.com:octocat/ryco.git",
      });
      expect(mockedRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["api", "namespaces/octocat"],
        }),
      );
      expect(mockedRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects",
            "--raw-field",
            "path=ryco",
            "--raw-field",
            "name=ryco",
            "--raw-field",
            "visibility=public",
            "--raw-field",
            "namespace_id=1234",
          ],
        }),
      );
    }),
  );

  it.effect("does not pass unsupported force flags when checking out merge requests", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.checkoutMergeRequest({
        cwd: "/repo",
        reference: "42",
        force: true,
      });

      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "checkout", "42"],
        }),
      );
    }),
  );

  it.effect("surfaces a friendly error when the merge request is not found", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitLabCli.execute",
            command: "glab mr view 4888",
            cwd: "/repo",
            exitCode: 1,
            detail: "GET 404 merge request not found",
          }),
        ),
      );

      const error = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Merge request not found"), true);
      assert.strictEqual(error.failureKind, "not-found");
    }),
  );

  it.effect("types a rate limit even when a branch name says token", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitLabCli.execute",
            command: "glab mr list --source-branch fix/refresh-token --output json",
            cwd: "/repo",
            exitCode: 1,
            detail:
              "GET https://gitlab.com/api/v4/projects/1/merge_requests: 429 Too Many Requests",
          }),
        ),
      );
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["mr", "list", "--source-branch", "fix/refresh-token"] })
        .pipe(Effect.flip);
      assert.strictEqual(error.failureKind, "rate-limited");
      assert.strictEqual(
        error.detail,
        "GitLab is rate limiting requests. Ryco tries again shortly.",
      );
    }),
  );

  it.effect("does not type a sign-in failure from the command line", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitLabCli.execute",
            command: "glab mr list --source-branch fix/refresh-token --output json",
            cwd: "/repo",
            exitCode: 1,
            detail:
              "GET https://gitlab.com/api/v4/projects/1/merge_requests: 500 Internal Server Error",
          }),
        ),
      );
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .execute({ cwd: "/repo", args: ["mr", "list", "--source-branch", "fix/refresh-token"] })
        .pipe(Effect.flip);
      // The detail still matches the message (command line included), as before;
      // moving the detail rules to glab's own text is a follow-up.
      assert.strictEqual(
        error.detail,
        "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
      );
      assert.strictEqual(error.failureKind, undefined);
    }),
  );

  it.effect("does not type a sign-in failure from a project path glab echoes", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitLabCli.execute",
            command: "glab mr list --output json",
            cwd: "/repo",
            exitCode: 1,
            detail:
              "GET https://gitlab.com/api/v4/projects/group/token-service/merge_requests: 500 Internal Server Error",
          }),
        ),
      );
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab.execute({ cwd: "/repo", args: ["mr", "list"] }).pipe(Effect.flip);
      assert.strictEqual(error.failureKind, undefined);
    }),
  );

  it.effect("types a sign-in failure GitLab reports", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitLabCli.execute",
            command: "glab mr list --output json",
            cwd: "/repo",
            exitCode: 1,
            detail:
              "GET https://gitlab.com/api/v4/projects/group/app/merge_requests: 401 {error: invalid_token, error_description: Token is expired. You can either do re-authorization or token refresh.}",
          }),
        ),
      );
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab.execute({ cwd: "/repo", args: ["mr", "list"] }).pipe(Effect.flip);
      assert.strictEqual(error.failureKind, "unauthenticated");
      assert.strictEqual(
        error.detail,
        "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
      );
    }),
  );

  it.effect("getMergeRequestDetail decodes description and notes", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 99,
              title: "Add feature",
              web_url: "https://gitlab.com/owner/repo/-/merge_requests/99",
              target_branch: "main",
              source_branch: "feature/add",
              state: "opened",
              description: "MR body text",
              notes: [
                {
                  author: { username: "reviewer" },
                  body: "looks good",
                  created_at: "2026-03-01T10:00:00Z",
                },
              ],
            }),
          ),
        ),
      );
      const detail = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getMergeRequestDetail({ cwd: "/repo", reference: "99" });
      });
      expect(detail.body).toBe("MR body text");
      expect(detail.comments[0]?.author).toBe("reviewer");
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "view", "99", "--comments", "--output", "json"],
        }),
      );
    }),
  );

  it.effect("searchMergeRequests forwards query to glab mr list --search", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.searchMergeRequests({ cwd: "/repo", query: "fix" });
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["mr", "list", "--search", "fix", "--per-page", "20", "--output", "json"],
        }),
      );
    }),
  );

  it.effect("searchIssues forwards query and limit to glab issue list --search", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.searchIssues({ cwd: "/repo", query: "memory leak", limit: 30 });
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "issue",
            "list",
            "--search",
            "memory leak",
            "--per-page",
            "30",
            "--output",
            "json",
          ],
        }),
      );
    }),
  );

  it.effect("getIssue invokes glab issue view with --comments and decodes detail", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              iid: 7,
              title: "Detailed",
              web_url: "https://gitlab.com/owner/repo/-/issues/7",
              state: "opened",
              description: "issue body",
              notes: [
                { author: { username: "bob" }, body: "first", created_at: "2026-03-14T10:00:00Z" },
              ],
            }),
          ),
        ),
      );
      const detail = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.getIssue({ cwd: "/repo", reference: "7" });
      });
      expect(detail.body).toBe("issue body");
      expect(detail.comments[0]?.author).toBe("bob");
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["issue", "view", "7", "--comments", "--output", "json"],
        }),
      );
    }),
  );

  it.effect("listIssues invokes glab with correct args and decodes output", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                iid: 42,
                title: "Bug",
                web_url: "https://gitlab.com/owner/repo/-/issues/42",
                state: "opened",
                author: { username: "alice" },
                labels: ["bug"],
              },
            ]),
          ),
        ),
      );
      const issues = yield* Effect.gen(function* () {
        const glab = yield* GitLabCli.GitLabCli;
        return yield* glab.listIssues({ cwd: "/repo", state: "open", limit: 20 });
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.number).toBe(42);
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: ["issue", "list", "--per-page", "20", "--output", "json"],
          env: expect.objectContaining({ LC_ALL: "C" }),
        }),
      );
    }),
  );
  it.effect("opens draft merge requests with GitLab's title prefix", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      const glab = yield* GitLabCli.GitLabCli;
      yield* glab.createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        title: "Provider MR",
        bodyFile: "/tmp/ryco-mr-body.md",
        draft: true,
      });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining(["title=Draft: Provider MR"]),
        }),
      );
    }),
  );

  it.effect("api sends JSON bodies over stdin and returns stdout", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(processOutput('{"id":301}')));
      const glab = yield* GitLabCli.GitLabCli;
      const output = yield* glab.api({
        cwd: "/repo",
        operation: "addChangeRequestComment",
        request: {
          method: "POST",
          endpoint: "projects/:fullpath/merge_requests/7/notes",
          body: { body: "Looks good\n--force" },
        },
      });
      expect(output).toEqual({ stdout: '{"id":301}', stdoutTruncated: false });
      expect(mockedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "glab",
          cwd: "/repo",
          args: [
            "api",
            "--method",
            "POST",
            "projects/:fullpath/merge_requests/7/notes",
            "--header",
            "Content-Type: application/json",
            "--input",
            "-",
          ],
          stdin: JSON.stringify({ body: "Looks good\n--force" }),
          allowNonZeroExit: true,
        }),
      );
    }),
  );

  it.effect("api fails with GitLab's HTTP status and message", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(1),
          stdout: '{"message":"SHA does not match HEAD of source branch: e82eb4a0"}',
          stderr: "glab: SHA does not match HEAD of source branch: e82eb4a0 (HTTP 409)\n",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .api({
          cwd: "/repo",
          operation: "mergeChangeRequest",
          request: { method: "PUT", endpoint: "projects/:fullpath/merge_requests/7/merge" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.status, 409);
      assert.strictEqual(error.operation, "mergeChangeRequest");
      assert.strictEqual(
        error.detail,
        "GitLab API request failed (HTTP 409): SHA does not match HEAD of source branch: e82eb4a0",
      );
      assert.strictEqual(error.failureKind, undefined);
    }),
  );

  it.effect("api reads HTTP 429 as a rate limit", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(1),
          stdout: '{"message":"429 Too Many Requests"}',
          stderr: "glab: 429 Too Many Requests (HTTP 429)\n",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );
      const glab = yield* GitLabCli.GitLabCli;
      const error = yield* glab
        .api({
          cwd: "/repo",
          operation: "listChangeRequests",
          request: { method: "GET", endpoint: "projects/:fullpath/merge_requests" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.status, 429);
      assert.strictEqual(error.failureKind, "rate-limited");
      assert.strictEqual(error.detail, "GitLab is rate limiting requests (HTTP 429).");
    }),
  );
});
