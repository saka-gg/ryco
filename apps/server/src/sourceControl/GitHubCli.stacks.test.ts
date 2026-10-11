import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

const output = (
  stdout: string,
  options: { readonly exitCode?: number; readonly stderr?: string } = {},
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(options.exitCode ?? 0),
  stdout,
  stderr: options.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const pending = (uuid: string | null = "merge-uuid") =>
  output(JSON.stringify({ status: "pending", details: { uuid } }));
const terminal = (status: "merged" | "enqueued" | "failed", message?: string) =>
  output(JSON.stringify({ status, details: { uuid: "merge-uuid", message } }));

const stackEntry = (position: number, number: number) => ({
  position,
  pullRequest: {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName: `feature/${number}`,
    baseRefName: position === 1 ? "main" : `feature/${number - 1}`,
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
  },
});

function stackPage(input: {
  readonly nodes: ReadonlyArray<ReturnType<typeof stackEntry>>;
  readonly hasNextPage: boolean;
  readonly endCursor?: string | null;
}) {
  return output(
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            stackEntry: { position: 2 },
            stack: {
              number: 7,
              size: 3,
              baseRefName: "main",
              entries: {
                totalCount: 3,
                nodes: input.nodes,
                pageInfo: {
                  hasNextPage: input.hasNextPage,
                  endCursor: input.endCursor ?? null,
                },
              },
            },
          },
        },
      },
    }),
  );
}

const mockRun = vi.fn<VcsProcess.VcsProcessShape["run"]>();
const layer = GitHubCli.layer.pipe(
  Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockRun })),
);

afterEach(() => mockRun.mockReset());

describe("GitHubCli stacked pull requests", () => {
  it.effect("returns null when GitHub verifies a standalone pull request", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: { stackEntry: null, stack: null },
                },
              },
            }),
          ),
        ),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const stack = yield* gh.getPullRequestStack({
        cwd: "/repo",
        host: "github.com",
        repository: "acme/widgets",
        number: 42,
      });
      assert.equal(stack, null);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("paginates and normalizes a complete stack", () =>
    Effect.gen(function* () {
      mockRun
        .mockReturnValueOnce(
          Effect.succeed(
            stackPage({
              nodes: [stackEntry(1, 41), stackEntry(2, 42)],
              hasNextPage: true,
              endCursor: "page-2",
            }),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(stackPage({ nodes: [stackEntry(3, 43)], hasNextPage: false })),
        );

      const gh = yield* GitHubCli.GitHubCli;
      const stack = yield* gh.getPullRequestStack({
        cwd: "/repo",
        host: "github.example.com",
        repository: "acme/widgets",
        number: 42,
      });

      assert.deepStrictEqual(
        stack?.entries.map((entry) => entry.number),
        [41, 42, 43],
      );
      expect(mockRun.mock.calls[1]?.[0].args).toContain("after=page-2");
      expect(mockRun.mock.calls[0]?.[0].args).toContain("--hostname");
      expect(mockRun.mock.calls[0]?.[0].args).toContain("github.example.com");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a repeated stack pagination cursor", () =>
    Effect.gen(function* () {
      mockRun
        .mockReturnValueOnce(
          Effect.succeed(
            stackPage({ nodes: [stackEntry(1, 41)], hasNextPage: true, endCursor: "same" }),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            stackPage({ nodes: [stackEntry(2, 42)], hasNextPage: true, endCursor: "same" }),
          ),
        );
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestStack({
          cwd: "/repo",
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
        })
        .pipe(Effect.flip);
      assert.include(error.detail, "repeated stack pagination cursor");
      assert.equal(mockRun.mock.calls.length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("batches summary lookups and maps aliases by pull request number", () =>
    Effect.gen(function* () {
      mockRun
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                data: {
                  repository: {
                    pr_1: {
                      stackEntry: { position: 1 },
                      stack: { number: 9, size: 2, baseRefName: "main" },
                    },
                  },
                },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                data: {
                  repository: {
                    pr_41: {
                      stackEntry: { position: 2 },
                      stack: { number: 9, size: 2, baseRefName: "main" },
                    },
                  },
                },
              }),
            ),
          ),
        );

      const gh = yield* GitHubCli.GitHubCli;
      const summaries = yield* gh.getPullRequestStackSummaries({
        cwd: "/repo",
        host: "github.com",
        repository: "acme/widgets",
        numbers: Array.from({ length: 41 }, (_, index) => index + 1),
      });

      assert.equal(mockRun.mock.calls.length, 2);
      assert.equal(summaries.get(1)?.position, 1);
      assert.equal(summaries.get(41)?.position, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("normalizes repository merge capabilities", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              allow_merge_commit: true,
              allow_squash_merge: false,
              allow_rebase_merge: true,
            }),
          ),
        ),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const capabilities = yield* gh.getRepositoryMergeCapabilities({
        cwd: "/repo",
        host: "github.example.com",
        repository: "acme/widgets",
      });
      assert.deepStrictEqual(capabilities, { merge: true, squash: false, rebase: true });
      assert.include(mockRun.mock.calls[0]?.[0].args.join(" ") ?? "", "github.example.com");
      assert.include(mockRun.mock.calls[0]?.[0].args.join(" ") ?? "", "repos/acme/widgets");
    }).pipe(Effect.provide(layer)),
  );

  for (const [terminalStatus, expectedOutcome] of [
    ["merged", "merged"],
    ["enqueued", "enqueued"],
  ] as const) {
    it.effect(`polls pending requests through ${terminalStatus}`, () =>
      Effect.gen(function* () {
        mockRun
          .mockReturnValueOnce(Effect.succeed(pending()))
          .mockReturnValueOnce(Effect.succeed(terminal(terminalStatus)));
        const gh = yield* GitHubCli.GitHubCli;
        const fiber = yield* Effect.forkChild(
          gh.mergePullRequestAsync({
            cwd: "/repo",
            host: "github.com",
            repository: "acme/widgets",
            number: 42,
            mergeMethod: "squash",
            stackMembership: "stacked",
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.join(fiber);

        assert.equal(result.outcome, expectedOutcome);
        const submission = mockRun.mock.calls[0]?.[0];
        assert.equal(submission?.stdin, '{"merge_method":"squash","merge_action":"default"}');
        assert.notInclude(submission?.args.join(" ") ?? "", "merge_method");
        assert.include(submission?.args.join(" ") ?? "", "--input -");
      }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
    );
  }

  it.effect("accepts an existing 409 request when GitHub returns its UUID", () =>
    Effect.gen(function* () {
      mockRun
        .mockReturnValueOnce(
          Effect.succeed(
            output(JSON.stringify({ status: "pending", details: { uuid: "existing" } }), {
              exitCode: 1,
              stderr: "HTTP 409: Conflict",
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(terminal("merged")));
      const gh = yield* GitHubCli.GitHubCli;
      const fiber = yield* Effect.forkChild(
        gh.mergePullRequestAsync({
          cwd: "/repo",
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
          mergeMethod: "merge",
          stackMembership: "stacked",
        }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal((yield* Fiber.join(fiber)).outcome, "merged");
      assert.include(mockRun.mock.calls[1]?.[0].args.join(" ") ?? "", "/existing");
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
  );

  it.effect("surfaces terminal failure and a missing pending UUID", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(terminal("failed", "Rules blocked this stack")));
      const gh = yield* GitHubCli.GitHubCli;
      const failed = yield* gh
        .mergePullRequestAsync({
          cwd: "/repo",
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
          mergeMethod: "merge",
          stackMembership: "stacked",
        })
        .pipe(Effect.flip);
      assert.include(failed.detail, "Rules blocked this stack");

      mockRun.mockReturnValueOnce(Effect.succeed(pending(null)));
      const missingUuid = yield* gh
        .mergePullRequestAsync({
          cwd: "/repo",
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
          mergeMethod: "merge",
          stackMembership: "stacked",
        })
        .pipe(Effect.flip);
      assert.include(missingUuid.detail, "without an identifier");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces malformed asynchronous merge responses", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(output('{"status":"completed"}')));
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .mergePullRequestAsync({
          cwd: "/repo",
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
          mergeMethod: "merge",
          stackMembership: "stacked",
        })
        .pipe(Effect.flip);
      assert.include(error.detail, "Invalid GitHub asynchronous merge response");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("times out after five minutes without sleeping in real time", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation(() => Effect.succeed(pending()));
      const gh = yield* GitHubCli.GitHubCli;
      const fiber = yield* Effect.forkChild(
        Effect.result(
          gh.mergePullRequestAsync({
            cwd: "/repo",
            host: "github.com",
            repository: "acme/widgets",
            number: 42,
            mergeMethod: "merge",
            stackMembership: "stacked",
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.minutes(5));
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.include(result.failure.detail, "within five minutes");
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))),
  );

  it.effect("uses legacy merge only for a verified standalone pull request", () =>
    Effect.gen(function* () {
      mockRun
        .mockReturnValueOnce(Effect.succeed(output("", { exitCode: 1, stderr: "HTTP 404" })))
        .mockReturnValueOnce(Effect.succeed(output("Merged pull request")));
      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.mergePullRequestAsync({
        cwd: "/repo",
        host: "github.example.com",
        repository: "acme/widgets",
        number: 42,
        mergeMethod: "rebase",
        stackMembership: "standalone",
      });
      assert.equal(result.outcome, "merged");
      assert.deepStrictEqual(mockRun.mock.calls[1]?.[0].args, [
        "pr",
        "merge",
        "42",
        "--repo",
        "github.example.com/acme/widgets",
        "--rebase",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never falls back to legacy merge for a known stack", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(output("", { exitCode: 1, stderr: "HTTP 404: Not Found" })),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .mergePullRequestAsync({
          cwd: "/repo",
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
          mergeMethod: "merge",
          stackMembership: "stacked",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "async-merge-unavailable");
      assert.equal(mockRun.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not treat authorization failures as preview unavailability", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(output("", { exitCode: 1, stderr: "HTTP 403: Forbidden" })),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .mergePullRequestAsync({
          cwd: "/repo",
          host: "github.com",
          repository: "acme/widgets",
          number: 42,
          mergeMethod: "merge",
          stackMembership: "standalone",
        })
        .pipe(Effect.flip);
      assert.include(error.detail, "HTTP 403");
      assert.equal(mockRun.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );
});
