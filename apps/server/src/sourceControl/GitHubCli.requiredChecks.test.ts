import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { GITHUB_REQUIRED_CHECKS_MAX_PAGES } from "./gitHubRequiredChecks.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

/** One `gh api graphql` page, shaped like GitHub's answer to the required-checks query. */
function requiredPage(input: {
  readonly names: ReadonlyArray<readonly [string, boolean]>;
  readonly hasNextPage: boolean;
  readonly endCursor?: string | null;
}) {
  return output(
    JSON.stringify({
      data: {
        repository: {
          object: {
            statusCheckRollup: {
              contexts: {
                nodes: input.names.map(([name, isRequired], index) => ({
                  __typename: "CheckRun",
                  name,
                  detailsUrl: `https://github.com/acme/widgets/actions/runs/1/job/${index + 1}`,
                  isRequired,
                })),
                pageInfo: { hasNextPage: input.hasNextPage, endCursor: input.endCursor ?? null },
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

const lookup = {
  cwd: "/repo",
  host: "github.example.com",
  repository: "acme/widgets",
  number: 42,
  headSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
} as const;

describe("GitHubCli required checks", () => {
  it.effect("pages through the head commit's checks", () =>
    Effect.gen(function* () {
      mockRun
        .mockReturnValueOnce(
          Effect.succeed(
            requiredPage({ names: [["Typecheck", true]], hasNextPage: true, endCursor: "MQ" }),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(requiredPage({ names: [["Bundle", false]], hasNextPage: false })),
        );

      const gh = yield* GitHubCli.GitHubCli;
      const checks = yield* gh.getPullRequestRequiredChecks(lookup);

      assert.deepStrictEqual(
        checks.map((check) => [check.name, check.isRequired]),
        [
          ["Typecheck", true],
          ["Bundle", false],
        ],
      );
      const firstArgs = mockRun.mock.calls[0]?.[0].args ?? [];
      expect(firstArgs).toEqual(
        expect.arrayContaining([
          "--hostname",
          "github.example.com",
          "owner=acme",
          "repo=widgets",
          "number=42",
          `oid=${lookup.headSha}`,
          "first=100",
        ]),
      );
      expect(firstArgs.some((arg) => arg.includes("isRequired(pullRequestNumber: $number)"))).toBe(
        true,
      );
      expect(mockRun.mock.calls[1]?.[0].args).toContain("after=MQ");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stops at the page bound and on a repeated cursor", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation(() =>
        Effect.succeed(
          requiredPage({ names: [["Lint", true]], hasNextPage: true, endCursor: "same" }),
        ),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const repeated = yield* gh.getPullRequestRequiredChecks(lookup);
      // The second page repeats the first cursor, so paging stops after it.
      assert.equal(repeated.length, 2);
      assert.equal(mockRun.mock.calls.length, 2);

      mockRun.mockReset();
      let page = 0;
      mockRun.mockImplementation(() => {
        page += 1;
        return Effect.succeed(
          requiredPage({ names: [["Lint", true]], hasNextPage: true, endCursor: `c${page}` }),
        );
      });
      const bounded = yield* gh.getPullRequestRequiredChecks(lookup);
      assert.equal(bounded.length, GITHUB_REQUIRED_CHECKS_MAX_PAGES);
      assert.equal(mockRun.mock.calls.length, GITHUB_REQUIRED_CHECKS_MAX_PAGES);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a repository that is not owner/name", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequestRequiredChecks({ ...lookup, repository: "widgets" })
        .pipe(Effect.flip);
      assert.include(error.detail, "owner/repository");
      assert.equal(mockRun.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );
});
