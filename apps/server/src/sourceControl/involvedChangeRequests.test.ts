import { assert, describe, expect, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestInvolvement,
  type SourceControlListInvolvedChangeRequestsInput,
  type SourceControlProviderInfo,
} from "@ryco/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@ryco/shared/sourceControl";

import { ProcessLaneRef, type ProcessLane } from "../processGovernor.ts";
import {
  INVOLVED_ANSWER_DEADLINE_MS,
  INVOLVED_CACHE_TTL_MS,
  INVOLVED_REFRESH_MAX_AGE_MS,
  INVOLVED_SETTLE_TTL_MS,
  listInvolvedChangeRequests,
  summarizeSourceControlFailure,
  type InvolvedChangeRequestsDeps,
} from "./involvedChangeRequests.ts";
import { makeRepositoryListCache } from "./repositoryListCache.ts";
import type {
  SourceControlInvolvedSearchPage,
  SourceControlProviderShape,
} from "./SourceControlProvider.ts";
import type { SourceControlProviderHandle } from "./SourceControlProviderRegistry.ts";

const changeRequest = (
  url: string,
  updatedAt: string | null,
  overrides: Partial<ChangeRequest> = {},
): ChangeRequest => {
  const number = Number(/(\d+)$/u.exec(url)?.[1] ?? 1);
  return {
    provider: "github",
    number,
    title: `Change ${number}`,
    url,
    baseRefName: "main",
    headRefName: `feature/${number}`,
    state: "open",
    updatedAt: updatedAt === null ? Option.none() : Option.some(DateTime.makeUnsafe(updatedAt)),
    ...overrides,
  };
};

interface FakeForge {
  /** Rows per involvement for the host search. */
  readonly search?: (input: {
    readonly cwd: string;
    readonly involvement: ChangeRequestInvolvement;
  }) => Effect.Effect<SourceControlInvolvedSearchPage, SourceControlProviderError>;
  /** Rows per checkout and involvement for repository lists. */
  readonly list?: (input: {
    readonly cwd: string;
    readonly involvement: ChangeRequestInvolvement;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
}

/**
 * Checkouts by path. `remote: null` has no recognized host; `fail` makes provider detection
 * fail. A real involvement cache (one per test) stands in for `GitManager.cachedInvolvedList`,
 * keyed by host (GitHub) or checkout. `detect` stands in for the registry's dynamic detectors.
 */
function makeHarness(
  checkouts: Readonly<Record<string, string | null | "fail">>,
  forge: FakeForge,
  detect?: (remote: string) => SourceControlProviderInfo | null,
) {
  const searches: Array<{
    readonly cwd: string;
    readonly involvement: string;
    readonly lane: ProcessLane;
  }> = [];
  const lists: Array<{
    readonly cwd: string;
    readonly involvement: string | undefined;
    readonly limit: number | undefined;
    readonly includeStackSummary: boolean | undefined;
    readonly lane: ProcessLane;
  }> = [];
  const cacheCalls: Array<
    Omit<Parameters<InvolvedChangeRequestsDeps["cachedInvolvedList"]>[0], "load">
  > = [];
  const cache = makeRepositoryListCache();

  const providerFor = (kind: "github" | "gitlab"): SourceControlProviderShape =>
    ({
      kind,
      listChangeRequests: (input) =>
        ProcessLaneRef.pipe(
          Effect.tap((lane) =>
            Effect.sync(() =>
              lists.push({
                cwd: input.cwd,
                involvement: input.involvement,
                limit: input.limit,
                includeStackSummary: input.includeStackSummary,
                lane,
              }),
            ),
          ),
          Effect.flatMap(() =>
            forge.list
              ? forge.list({ cwd: input.cwd, involvement: input.involvement! })
              : Effect.succeed([]),
          ),
        ),
      ...(kind === "github"
        ? {
            searchInvolvedChangeRequests: (input) =>
              ProcessLaneRef.pipe(
                Effect.tap((lane) =>
                  Effect.sync(() =>
                    searches.push({ cwd: input.cwd, involvement: input.involvement, lane }),
                  ),
                ),
                Effect.flatMap(() =>
                  forge.search
                    ? forge.search({ cwd: input.cwd, involvement: input.involvement })
                    : Effect.succeed({
                        host: "github.com",
                        viewerLogin: null,
                        items: [],
                        truncated: false,
                        skippedRows: 0,
                      }),
                ),
              ),
          }
        : {}),
    }) as SourceControlProviderShape;

  const resolutionLanes: ProcessLane[] = [];
  const resolve = (
    cwd: string,
  ): Effect.Effect<SourceControlProviderHandle, SourceControlProviderError> => {
    const remote = checkouts[cwd];
    if (remote === "fail" || remote === undefined) {
      return Effect.fail(
        new SourceControlProviderError({
          provider: "unknown",
          operation: "detectProvider",
          detail: `Failed to detect source control provider for ${cwd}.`,
        }),
      );
    }
    const info =
      remote === null
        ? null
        : (detect?.(remote) ?? detectSourceControlProviderFromRemoteUrl(remote));
    if (remote === null || info === null || info.kind === "unknown") {
      return Effect.succeed({
        provider: { kind: "unknown" } as SourceControlProviderShape,
        context: null,
      });
    }
    return Effect.succeed({
      provider: providerFor(info.kind === "github" ? "github" : "gitlab"),
      context: { provider: info, remoteName: "origin", remoteUrl: remote },
    });
  };

  const deps: InvolvedChangeRequestsDeps = {
    resolveHandle: (cwd) =>
      ProcessLaneRef.pipe(
        Effect.tap((lane) => Effect.sync(() => resolutionLanes.push(lane))),
        Effect.flatMap(() => resolve(cwd)),
      ),
    cachedInvolvedList: (input) => {
      const { load, ...rest } = input;
      cacheCalls.push(rest);
      const remote = checkouts[input.cwd] ?? "";
      const host = /github\.com/u.test(remote) ? "github.com" : remote;
      return cache.get({
        repository: input.scope === "host" ? host : input.cwd,
        key: input.key,
        load,
        ttlMs: input.ttlMs,
        ...(input.maxAgeMs !== undefined ? { maxAgeMs: input.maxAgeMs } : {}),
      });
    },
  };
  const run = (input: Partial<SourceControlListInvolvedChangeRequestsInput>) =>
    listInvolvedChangeRequests(deps, {
      cwds: Object.keys(checkouts),
      state: "open",
      involvements: ["review-requested", "authored"],
      ...input,
    });
  return { run, searches, lists, cacheCalls, resolutionLanes };
}

const github = (name: string) => `git@github.com:acme/${name}.git`;
const gitlab = (name: string) => `https://gitlab.com/acme/${name}.git`;

describe("listInvolvedChangeRequests", () => {
  it.effect("reads twelve GitHub repositories with one search per involvement", () =>
    Effect.gen(function* () {
      const checkouts = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`/work/repo-${index}`, github(`repo-${index}`)]),
      );
      const harness = makeHarness(checkouts, {
        search: ({ involvement }) =>
          Effect.succeed({
            host: "github.com",
            viewerLogin: "octocat",
            items: [
              changeRequest(
                `https://github.com/acme/repo-3/pull/${involvement === "authored" ? 1 : 2}`,
                "2026-10-27T10:00:00Z",
              ),
            ],
            truncated: false,
            skippedRows: 0,
          }),
      });
      const result = yield* harness.run({});

      // Today's per-checkout page would make 12 × 2 = 24 involvement reads.
      expect(harness.searches).toHaveLength(2);
      expect(harness.lists).toHaveLength(0);
      expect(harness.searches.map((search) => search.involvement)).toEqual([
        "review-requested",
        "authored",
      ]);
      assert.deepStrictEqual(result.sources, [
        {
          scope: "host",
          provider: "github",
          name: "github.com",
          status: "ok",
          viewerLogin: "octocat",
          truncated: false,
        },
      ]);
      expect(result.entries.map((entry) => entry.changeRequest.number).toSorted()).toEqual([1, 2]);
      expect(harness.cacheCalls.every((call) => call.scope === "host")).toBe(true);
      expect(harness.cacheCalls[0]).toMatchObject({
        ttlMs: INVOLVED_CACHE_TTL_MS,
        settleTtlMs: INVOLVED_SETTLE_TTL_MS,
      });
    }),
  );

  it.effect("reads each other repository's involvement lists, once per repository", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        {
          "/work/tools": gitlab("tools"),
          "/work/tools-worktree": gitlab("tools"),
        },
        {
          list: ({ involvement }) =>
            Effect.succeed([
              changeRequest(
                `https://gitlab.com/acme/tools/-/merge_requests/${involvement === "authored" ? 4 : 5}`,
                "2026-10-27T09:00:00Z",
                { provider: "gitlab" },
              ),
            ]),
        },
      );
      const result = yield* harness.run({});

      expect(harness.lists.map((list) => [list.cwd, list.involvement])).toEqual([
        ["/work/tools", "review-requested"],
        ["/work/tools", "authored"],
      ]);
      expect(harness.lists[0]).toMatchObject({ limit: 100, includeStackSummary: false });
      expect(harness.cacheCalls.map((call) => call.scope)).toEqual(["repository", "repository"]);
      expect(harness.cacheCalls[0]?.settleTtlMs).toBeUndefined();
      assert.deepStrictEqual(result.sources, [
        {
          scope: "repository",
          provider: "gitlab",
          name: "acme/tools",
          status: "ok",
          truncated: false,
        },
      ]);
      expect(result.entries.map((entry) => entry.repositoryLabel)).toEqual([
        "acme/tools",
        "acme/tools",
      ]);
    }),
  );

  it.effect("reports a failed repository and keeps every other source's rows", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        {
          "/work/tools": gitlab("tools"),
          "/work/docs": gitlab("docs"),
          "/work/app": github("app"),
        },
        {
          search: () =>
            Effect.succeed({
              host: "github.com",
              viewerLogin: "octocat",
              items: [changeRequest("https://github.com/acme/app/pull/12", "2026-10-27T08:00:00Z")],
              truncated: false,
              skippedRows: 0,
            }),
          list: ({ cwd }) =>
            cwd === "/work/docs"
              ? Effect.fail(
                  new SourceControlProviderError({
                    provider: "gitlab",
                    operation: "listChangeRequests",
                    detail:
                      "glab: 401 Unauthorized\n$ glab api projects/acme%2Fdocs/merge_requests --paginate",
                  }),
                )
              : Effect.succeed([
                  changeRequest("https://gitlab.com/acme/tools/-/merge_requests/3", null, {
                    provider: "gitlab",
                  }),
                ]),
        },
      );
      const result = yield* harness.run({ involvements: ["authored"] });

      const docs = result.sources.find((source) => source.name === "acme/docs");
      expect(docs).toMatchObject({
        scope: "repository",
        status: "failed",
        message: "401 Unauthorized",
      });
      expect(docs?.message).not.toContain("glab api");
      expect(result.sources.filter((source) => source.status === "ok")).toHaveLength(2);
      expect(result.entries.map((entry) => entry.changeRequest.url)).toEqual([
        "https://github.com/acme/app/pull/12",
        "https://gitlab.com/acme/tools/-/merge_requests/3",
      ]);
    }),
  );

  it.effect("skips checkouts without a host that lists change requests", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        { "/scratch": null, "/broken": "fail", "/work/app": github("app") },
        {},
      );
      const result = yield* harness.run({});
      expect(result.skippedCwds).toEqual(["/scratch", "/broken"]);
      expect(result.sources.map((source) => source.name)).toEqual(["github.com"]);
    }),
  );

  it.effect("names the SSH host alias a host search resolved from", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        { "/work/app": "git@github.com-work:acme/app.git", "/work/site": github("site") },
        {
          search: () =>
            Effect.succeed({
              host: "github.com",
              viewerLogin: "octocat",
              items: [changeRequest("https://github.com/acme/app/pull/12", "2026-10-27T08:00:00Z")],
              truncated: false,
              skippedRows: 0,
            }),
        },
      );
      const result = yield* harness.run({ involvements: ["authored"], sources: "hosts" });
      expect(
        result.sources.map((source) => [source.name, source.checkoutHost ?? null]).toSorted(),
      ).toEqual([
        ["github.com", null],
        ["github.com", "github.com-work"],
      ]);
      expect(result.entries.map((entry) => entry.repositoryKey)).toEqual(["github.com/acme/app"]);
    }),
  );

  it.effect("merges a row both involvements return, the later update winning", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        { "/work/app": github("app") },
        {
          search: ({ involvement }) =>
            Effect.succeed({
              host: "github.com",
              viewerLogin: "octocat",
              items: [
                changeRequest(
                  "https://github.com/Acme/App/pull/12",
                  involvement === "authored" ? "2026-10-27T10:00:00Z" : "2026-10-27T09:00:00Z",
                  { title: involvement === "authored" ? "Newer title" : "Older title" },
                ),
              ],
              truncated: false,
              skippedRows: 0,
            }),
        },
      );
      const result = yield* harness.run({});
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        repositoryKey: "github.com/acme/app",
        repositoryLabel: "Acme/App",
        involvements: ["review-requested", "authored"],
      });
      expect(result.entries[0]?.changeRequest.title).toBe("Newer title");
    }),
  );

  it.effect("returns the 300 most recently updated rows and says it cut the rest", () =>
    Effect.gen(function* () {
      const rows = (offset: number) =>
        Array.from({ length: 100 }, (_, index) =>
          changeRequest(
            `https://github.com/acme/app/pull/${offset + index + 1}`,
            new Date(Date.UTC(2026, 9, 1) + (offset + index) * 60_000).toISOString(),
          ),
        );
      const harness = makeHarness(
        { "/work/app": github("app") },
        {
          search: ({ involvement }) =>
            Effect.succeed({
              host: "github.com",
              viewerLogin: null,
              items:
                involvement === "authored"
                  ? rows(0)
                  : involvement === "review-requested"
                    ? rows(100)
                    : [...rows(200), ...rows(300)],
              truncated: involvement === "mentioned",
              skippedRows: involvement === "mentioned" ? 3 : 0,
            }),
        },
      );
      const result = yield* harness.run({
        involvements: ["authored", "review-requested", "mentioned"],
      });
      expect(result.truncated).toBe(true);
      expect(result.entries).toHaveLength(300);
      expect(result.entries[0]?.changeRequest.number).toBe(400);
      expect(result.entries.at(-1)?.changeRequest.number).toBe(101);
      expect(result.sources[0]).toMatchObject({ truncated: true, skippedRows: 3 });
    }),
  );

  it.effect(
    "reads in the background lane unless someone waits, and a refresh skips old reads",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness(
          { "/work/app": github("app"), "/work/tools": gitlab("tools") },
          {},
        );
        yield* harness.run({ involvements: ["authored"] });
        expect([...harness.searches, ...harness.lists].map((read) => read.lane)).toEqual([
          "background",
          "background",
        ]);
        expect(harness.resolutionLanes).toEqual(["background", "background"]);
        expect(harness.cacheCalls.map((call) => call.maxAgeMs)).toEqual([undefined, undefined]);

        const interactive = makeHarness({ "/work/app": github("app") }, {});
        yield* interactive.run({ involvements: ["authored"], interactive: true });
        expect(interactive.searches.map((read) => read.lane)).toEqual(["interactive"]);
        expect(interactive.resolutionLanes).toEqual(["interactive"]);
        expect(interactive.cacheCalls[0]?.maxAgeMs).toBeUndefined();

        const refresh = makeHarness(
          { "/work/app": github("app"), "/work/tools": gitlab("tools") },
          {},
        );
        yield* refresh.run({ involvements: ["authored"], refresh: true });
        expect([...refresh.searches, ...refresh.lists].map((read) => read.lane)).toEqual([
          "interactive",
          "interactive",
        ]);
        expect(refresh.cacheCalls.map((call) => call.maxAgeMs)).toEqual([
          INVOLVED_REFRESH_MAX_AGE_MS,
          INVOLVED_REFRESH_MAX_AGE_MS,
        ]);
      }),
  );

  it.effect("reads only host searches or only repository lists when asked", () =>
    Effect.gen(function* () {
      const checkouts = { "/work/app": github("app"), "/work/tools": gitlab("tools") };
      const hosts = makeHarness(checkouts, {});
      const hostResult = yield* hosts.run({ sources: "hosts" });
      expect(hosts.lists).toHaveLength(0);
      expect(hostResult.sources.map((source) => source.scope)).toEqual(["host"]);

      const repositories = makeHarness(checkouts, {});
      const repositoryResult = yield* repositories.run({ sources: "repositories" });
      expect(repositories.searches).toHaveLength(0);
      expect(repositoryResult.sources.map((source) => source.scope)).toEqual(["repository"]);
    }),
  );

  it.effect(
    "does not let a slow repository hold back the host's rows, and caches it for later",
    () =>
      Effect.gen(function* () {
        const slow = yield* Deferred.make<ReadonlyArray<ChangeRequest>>();
        const harness = makeHarness(
          { "/work/app": github("app"), "/work/tools": gitlab("tools") },
          {
            search: () =>
              Effect.succeed({
                host: "github.com",
                viewerLogin: "octocat",
                items: [
                  changeRequest("https://github.com/acme/app/pull/12", "2026-10-27T10:00:00Z"),
                ],
                truncated: false,
                skippedRows: 0,
              }),
            list: () => Deferred.await(slow),
          },
        );
        const fiber = yield* Effect.forkChild(harness.run({ involvements: ["authored"] }));
        yield* TestClock.adjust(INVOLVED_ANSWER_DEADLINE_MS);
        const result = yield* Fiber.join(fiber);
        expect(result.entries.map((entry) => entry.changeRequest.number)).toEqual([12]);
        assert.deepStrictEqual(
          result.sources.find((source) => source.scope === "repository"),
          {
            scope: "repository",
            provider: "gitlab",
            name: "acme/tools",
            status: "loading",
            truncated: false,
          },
        );

        // The read kept running and fills the cache: the next answer has it without a new read.
        yield* Deferred.succeed(slow, [
          changeRequest(
            "https://gitlab.com/acme/tools/-/merge_requests/3",
            "2026-10-27T11:00:00Z",
            {
              provider: "gitlab",
            },
          ),
        ]);
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
        const next = yield* harness.run({ involvements: ["authored"] });
        expect(harness.lists).toHaveLength(1);
        expect(next.sources.every((source) => source.status === "ok")).toBe(true);
        expect(next.entries.map((entry) => entry.changeRequest.number)).toEqual([3, 12]);
      }),
  );

  it.effect("answers by the deadline however many reads hang, reading at most four at a time", () =>
    Effect.gen(function* () {
      const checkouts = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`/work/tool-${index}`, gitlab(`tool-${index}`)]),
      );
      // An unreachable self-hosted forge: no list ever answers.
      const harness = makeHarness(checkouts, { list: () => Effect.never });
      const fiber = yield* Effect.forkChild(harness.run({}));
      yield* TestClock.adjust(INVOLVED_ANSWER_DEADLINE_MS);
      const result = yield* Fiber.join(fiber);

      // One deadline for the whole answer, not one per read (24 reads would take 6 rounds).
      expect(result.sources).toHaveLength(12);
      expect(result.sources.every((source) => source.status === "loading")).toBe(true);
      expect(result.entries).toEqual([]);
      expect(harness.lists).toHaveLength(4);
    }),
  );
});

describe("involved change request labels", () => {
  it.effect(
    "labels rows as their host spells the repository and drops non-change-request links",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness(
          { "/work/azure": "https://org@dev.azure.com/org/Proj/_git/Repo" },
          {
            list: () =>
              Effect.succeed([
                changeRequest(
                  "https://gitlab.com/Group/Sub/Tools/-/merge_requests/3",
                  "2026-10-27T04:00:00Z",
                ),
                changeRequest(
                  "https://bitbucket.example.com/projects/PRJ/repos/widget/pull-requests/5",
                  "2026-10-27T03:00:00Z",
                ),
                changeRequest(
                  "https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7",
                  "2026-10-27T02:00:00Z",
                ),
                changeRequest("https://github.com/Acme/App/issues/9", "2026-10-27T01:00:00Z"),
              ]),
          },
        );
        const result = yield* harness.run({ involvements: ["authored"] });
        expect(result.sources.map((source) => source.name)).toEqual(["proj/repo"]);
        expect(result.entries.map((entry) => [entry.repositoryKey, entry.repositoryLabel])).toEqual(
          [
            ["gitlab.com/group/sub/tools", "Group/Sub/Tools"],
            ["bitbucket.example.com/projects/prj/repos/widget", "PRJ/widget"],
            ["azure:org/proj/repo", "proj/repo"],
          ],
        );
      }),
  );
});

describe("involved change request source names", () => {
  it.effect("names a repository source by its remote's path whatever the SSH user", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        { "/work/tools": "gitea@git.example.com:team/tools.git" },
        { list: () => Effect.never },
        (remote) =>
          remote.startsWith("gitea@")
            ? { kind: "forgejo", name: "Forgejo", baseUrl: "https://git.example.com" }
            : null,
      );
      const fiber = yield* Effect.forkChild(harness.run({ involvements: ["authored"] }));
      yield* TestClock.adjust(INVOLVED_ANSWER_DEADLINE_MS);
      const result = yield* Fiber.join(fiber);
      expect(result.sources.map((source) => [source.name, source.status])).toEqual([
        ["team/tools", "loading"],
      ]);
    }),
  );
});

describe("summarizeSourceControlFailure", () => {
  it("keeps one plain sentence without prefixes, command echoes or extra length", () => {
    expect(
      summarizeSourceControlFailure(
        new SourceControlProviderError({
          provider: "github",
          operation: "searchInvolvedChangeRequests",
          detail: "\n$ gh api graphql --hostname github.com --input -\ngh: Bad credentials",
        }),
      ),
    ).toBe("Bad credentials");
    expect(summarizeSourceControlFailure("GraphQL:   rate   limited")).toBe("rate limited");
    expect(summarizeSourceControlFailure({})).toBe("The host did not answer.");
    const long = summarizeSourceControlFailure("x".repeat(500));
    expect(long).toHaveLength(300);
    expect(long.endsWith("…")).toBe(true);
  });
});
