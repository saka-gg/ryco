import {
  ProjectId,
  SourceControlProviderError,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, PubSub, Ref, Stream } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type {
  ProjectionWorktree,
  ProjectionWorktreeRepositoryShape,
} from "../persistence/Services/ProjectionWorktrees.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";
import type { SourceControlProviderRegistryShape } from "./SourceControlProviderRegistry.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import {
  refreshWorktreeSourceControlState,
  resetWorktreePullRequestDiscoveryForTests,
  type DiscoveredPullRequest,
} from "./refreshWorktreeSourceControlState.ts";

type LinksCommand = Extract<OrchestrationCommand, { type: "worktree.pull-requests.update" }>;

function linkCommands(commands: ReadonlyArray<OrchestrationCommand>): LinksCommand[] {
  return commands.filter(
    (command): command is LinksCommand => command.type === "worktree.pull-requests.update",
  );
}

beforeEach(() => resetWorktreePullRequestDiscoveryForTests());

const worktreeId = WorktreeId.make("wt-test-1");
const projectId = ProjectId.make("proj-test-1");

const baseWorktree: ProjectionWorktree = {
  worktreeId,
  projectId,
  title: null,
  branch: "feature/test",
  worktreePath: "/tmp/test-worktree",
  origin: "pr",
  prNumber: 10,
  issueNumber: null,
  prTitle: "Test PR",
  issueTitle: null,
  prState: null,
  prIsDraft: null,
  issueState: null,
  createdAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z",
  archivedAt: null,
  manualPosition: 0,
};

function makeWorktreeRepo(row: ProjectionWorktree | null): ProjectionWorktreeRepositoryShape {
  return {
    upsert: () => Effect.die("not used"),
    getById: (_input) => Effect.succeed(row === null ? Option.none() : Option.some(row)),
    listByProjectId: () => Effect.die("not used"),
    findByOrigin: () => Effect.die("not used"),
    findByWorkItem: () => Effect.die("not used"),
    findActiveByLinkedNumber: () => Effect.die("not used"),
    findActiveByWorktreePath: () => Effect.die("not used"),
    markArchived: () => Effect.die("not used"),
    markRestored: () => Effect.die("not used"),
    updateMeta: () => Effect.die("not used"),
    deleteById: () => Effect.die("not used"),
    setManualPosition: () => Effect.die("not used"),
  };
}

function makeProvider(overrides: Partial<SourceControlProviderShape>): SourceControlProviderShape {
  const notUsed = () => Effect.die("not used in this test");
  return {
    kind: "github",
    listChangeRequests: notUsed,
    getChangeRequest: notUsed,
    createChangeRequest: notUsed,
    getRepositoryCloneUrls: notUsed,
    createRepository: notUsed,
    getDefaultBranch: notUsed,
    checkoutChangeRequest: notUsed,
    listIssues: notUsed,
    getIssue: notUsed,
    addIssueComment: notUsed,
    addIssueCommentReaction: notUsed,
    searchIssues: notUsed,
    searchChangeRequests: notUsed,
    getChangeRequestDetail: notUsed,
    addChangeRequestComment: notUsed,
    addChangeRequestCommentReaction: notUsed,
    getChangeRequestDiff: notUsed,
    createIssue: notUsed,
    listLabels: notUsed,
    listAssignees: notUsed,
    getPullRequestState: notUsed,
    getIssueState: notUsed,
    ...overrides,
  };
}

function makeRegistry(provider: SourceControlProviderShape): SourceControlProviderRegistryShape {
  return {
    get: (_kind) => Effect.succeed(provider),
    resolveHandle: (_input) => Effect.succeed({ provider, context: null }),
    resolve: (_input) => Effect.succeed(provider),
    discover: Effect.succeed([]),
    detectProviderFromRemoteUrl: (_url) => null,
  };
}

function makeEngine(
  dispatchRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
): OrchestrationEngineShape {
  return {
    bootSequence: 0,
    readEvents: () => Stream.empty,
    readEventsPage: (fromSequenceExclusive) =>
      Effect.succeed({
        events: [],
        nextSequence: fromSequenceExclusive,
        hasMore: false,
      }),
    dispatch: (command) =>
      Ref.update(dispatchRef, (calls) => [...calls, command]).pipe(Effect.as({ sequence: 1 })),
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
      return yield* PubSub.subscribe(pubsub);
    }),
  } satisfies OrchestrationEngineShape;
}

it.effect("state changed → command dispatched", () =>
  Effect.gen(function* () {
    const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const provider = makeProvider({
      getPullRequestState: (_input) => Effect.succeed({ state: "merged" as const, isDraft: false }),
    });

    yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
      Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(baseWorktree)),
      Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
      Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
    );

    const dispatched = linkCommands(yield* Ref.get(dispatchRef));
    assert.equal(dispatched.length, 1);
    const cmd = dispatched[0];
    assert.equal(cmd?.worktreeId, worktreeId);
    assert.equal(cmd?.upserts?.[0]?.number, 10);
    assert.equal(cmd?.upserts?.[0]?.state, "merged");
    assert.equal(cmd?.upserts?.[0]?.isDraft, false);
    assert.equal(cmd?.upserts?.[0]?.source, "origin");
    assert.isUndefined(cmd?.issueState);
  }),
);

it.effect("state already matches → no-op (no dispatch)", () =>
  Effect.gen(function* () {
    const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const worktreeWithState: ProjectionWorktree = {
      ...baseWorktree,
      prState: "open",
      prIsDraft: false,
    };

    const provider = makeProvider({
      getPullRequestState: (_input) => Effect.succeed({ state: "open" as const, isDraft: false }),
    });

    yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
      Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(worktreeWithState)),
      Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
      Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
    );

    const dispatched = yield* Ref.get(dispatchRef);
    assert.equal(dispatched.length, 0);
  }),
);

it.effect("provider error → swallowed, helper succeeds", () =>
  Effect.gen(function* () {
    const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const provider = makeProvider({
      getPullRequestState: (_input) =>
        Effect.fail(
          new SourceControlProviderError({
            provider: "github",
            operation: "getPullRequestState",
            detail: "simulated network error",
          }),
        ),
    });

    // Should not throw
    yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
      Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(baseWorktree)),
      Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
      Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
    );

    const dispatched = yield* Ref.get(dispatchRef);
    // No dispatch because provider errored and we have no new state to compare
    assert.equal(dispatched.length, 0);
  }),
);

it.effect("missing projection row → no-op", () =>
  Effect.gen(function* () {
    const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const provider = makeProvider({});

    yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
      Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(null)),
      Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
      Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
    );

    const dispatched = yield* Ref.get(dispatchRef);
    assert.equal(dispatched.length, 0);
  }),
);

it.effect("worktree with nothing linked and no discovery → no-op", () =>
  Effect.gen(function* () {
    const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const worktreeNoLinks: ProjectionWorktree = {
      ...baseWorktree,
      prNumber: null,
      issueNumber: null,
    };
    const provider = makeProvider({});

    yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
      Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(worktreeNoLinks)),
      Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
      Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
    );

    const dispatched = yield* Ref.get(dispatchRef);
    assert.equal(dispatched.length, 0);
  }),
);

it.effect("worktreePath is null → no-op, provider never called", () =>
  Effect.gen(function* () {
    const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const worktreeNullPath: ProjectionWorktree = {
      ...baseWorktree,
      worktreePath: null,
      prNumber: 42,
    };

    let providerCalled = false;
    const provider = makeProvider({
      getPullRequestState: (_input) => {
        providerCalled = true;
        return Effect.succeed({ state: "merged" as const, isDraft: false });
      },
    });

    yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
      Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(worktreeNullPath)),
      Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
      Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
    );

    const dispatched = yield* Ref.get(dispatchRef);
    assert.equal(dispatched.length, 0);
    assert.equal(providerCalled, false);
  }),
);

describe("prTerminalAt", () => {
  const FORGE_MERGED_AT = "2026-05-17T03:00:00.000Z";
  const runRefresh = (
    stored: ProjectionWorktree,
    result: {
      readonly state: "open" | "merged" | "closed";
      readonly terminalAt?: DateTime.Utc | null;
    },
  ) =>
    Effect.gen(function* () {
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const provider = makeProvider({
        getPullRequestState: (_input) => Effect.succeed({ isDraft: false, ...result }),
      });
      yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
        Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(stored)),
        Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
        Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
      );
      return linkCommands(yield* Ref.get(dispatchRef)).map((command) => ({
        prState: command.upserts?.[0]?.state,
        prTerminalAt: command.upserts?.[0]?.terminalAt,
        updatedAt: command.updatedAt,
      }));
    });
  const openWorktree: ProjectionWorktree = {
    ...baseWorktree,
    prState: "open",
    prIsDraft: false,
    prTerminalAt: null,
  };

  it.effect("records the forge close time on open to merged", () =>
    Effect.gen(function* () {
      const dispatched = yield* runRefresh(openWorktree, {
        state: "merged",
        terminalAt: DateTime.makeUnsafe(FORGE_MERGED_AT),
      });
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]?.prState, "merged");
      assert.equal(dispatched[0]?.prTerminalAt, FORGE_MERGED_AT);
    }),
  );

  it.effect("records the observation time when the forge reports none", () =>
    Effect.gen(function* () {
      const dispatched = yield* runRefresh(openWorktree, { state: "merged" });
      assert.equal(dispatched.length, 1);
      assert.isString(dispatched[0]?.prTerminalAt);
      assert.equal(dispatched[0]?.prTerminalAt, dispatched[0]?.updatedAt);
    }),
  );

  it.effect("corrects a backfilled time even though the PR state did not change", () =>
    Effect.gen(function* () {
      const dispatched = yield* runRefresh(
        { ...openWorktree, prState: "merged", prTerminalAt: "2026-05-18T00:00:00.000Z" },
        { state: "merged", terminalAt: DateTime.makeUnsafe(FORGE_MERGED_AT) },
      );
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]?.prState, "merged");
      assert.equal(dispatched[0]?.prTerminalAt, FORGE_MERGED_AT);
    }),
  );

  it.effect("keeps a stored time when the forge reports none", () =>
    Effect.gen(function* () {
      const dispatched = yield* runRefresh(
        { ...openWorktree, prState: "merged", prTerminalAt: "2026-05-18T00:00:00.000Z" },
        { state: "merged", terminalAt: null },
      );
      assert.equal(dispatched.length, 0);
    }),
  );

  it.effect("clears the time when a merged PR reopens", () =>
    Effect.gen(function* () {
      const dispatched = yield* runRefresh(
        { ...openWorktree, prState: "merged", prTerminalAt: FORGE_MERGED_AT },
        { state: "open", terminalAt: null },
      );
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]?.prState, "open");
      assert.isNull(dispatched[0]?.prTerminalAt);
    }),
  );
});

describe("several pull requests per workspace", () => {
  const MERGED_AT = "2026-05-18T00:00:00.000Z";
  const shippedWorktree: ProjectionWorktree = {
    ...baseWorktree,
    origin: "branch",
    prNumber: 677,
    prTitle: "Follow-up",
    prState: "open",
    prIsDraft: false,
    prTerminalAt: null,
    pullRequests: [
      {
        number: 675,
        title: "Shipped",
        url: null,
        state: "merged",
        isDraft: false,
        terminalAt: MERGED_AT,
        headRefName: "feature/test",
        baseRefName: "main",
        source: "created",
        linkedAt: "2026-05-17T00:00:00.000Z",
        dismissedAt: null,
      },
      {
        number: 677,
        title: "Follow-up",
        url: null,
        state: "open",
        isDraft: false,
        terminalAt: null,
        headRefName: "feature/test",
        baseRefName: "main",
        source: "manual",
        linkedAt: "2026-05-19T00:00:00.000Z",
        dismissedAt: null,
      },
    ],
  };

  const run = (
    stored: ProjectionWorktree,
    options: {
      readonly states?: Record<number, { state: "open" | "merged" | "closed"; mergedAt?: string }>;
      readonly discovered?: DiscoveredPullRequest | null;
      readonly actedOnPullRequestNumber?: number;
    },
  ) =>
    Effect.gen(function* () {
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const read: number[] = [];
      let discoverCalls = 0;
      const provider = makeProvider({
        getPullRequestState: ({ number }) => {
          read.push(number);
          const entry = options.states?.[number] ?? { state: "open" as const };
          return Effect.succeed({
            state: entry.state,
            isDraft: false,
            ...(entry.mergedAt ? { terminalAt: DateTime.makeUnsafe(entry.mergedAt) } : {}),
          });
        },
      });
      const discoverPullRequest =
        options.discovered === undefined
          ? undefined
          : () => {
              discoverCalls += 1;
              return Effect.succeed(options.discovered ?? null);
            };
      const refresh = () =>
        refreshWorktreeSourceControlState({
          worktreeId,
          discoverPullRequest,
          actedOnPullRequestNumber: options.actedOnPullRequestNumber,
        }).pipe(
          Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(stored)),
          Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
          Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
        );
      yield* refresh();
      yield* refresh();
      return {
        commands: linkCommands(yield* Ref.get(dispatchRef)),
        read,
        discoverCalls: () => discoverCalls,
      };
    });

  it.effect("re-reads the current pull request but leaves shipped history alone", () =>
    Effect.gen(function* () {
      const { commands, read } = yield* run(shippedWorktree, {
        states: { 677: { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z" } },
      });
      assert.deepStrictEqual([...new Set(read)], [677]);
      assert.equal(commands[0]?.upserts?.[0]?.number, 677);
      assert.equal(commands[0]?.upserts?.[0]?.terminalAt, "2026-05-20T00:00:00.000Z");
    }),
  );

  it.effect("links the open pull request the checkout's branch gained, once a minute", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { ...baseWorktree, origin: "branch", prNumber: null, prTitle: null },
        {
          discovered: {
            number: 680,
            title: "Second pass",
            url: "https://example.test/pull/680",
            state: "open",
            headRef: "feature/test",
            baseRef: "main",
          },
        },
      );
      assert.equal(result.discoverCalls(), 1);
      const upsert = result.commands[0]?.upserts?.[0];
      assert.equal(upsert?.number, 680);
      assert.equal(upsert?.source, "discovered");
      assert.equal(upsert?.title, "Second pass");
      assert.equal(upsert?.url, "https://example.test/pull/680");
      assert.equal(upsert?.headRefName, "feature/test");
      assert.equal(upsert?.state, "open");
    }),
  );

  it.effect("never re-links a known (or dismissed) pull request", () =>
    Effect.gen(function* () {
      const dismissed: ProjectionWorktree = {
        ...shippedWorktree,
        pullRequests: shippedWorktree.pullRequests?.map((link) =>
          link.number === 677 ? { ...link, dismissedAt: "2026-05-19T01:00:00.000Z" } : link,
        ),
      };
      const { commands } = yield* run(dismissed, {
        // With #677 dismissed, shipped #675 is current again and is re-read.
        states: { 675: { state: "merged", mergedAt: MERGED_AT } },
        discovered: {
          number: 677,
          title: "Follow-up",
          url: "https://example.test/pull/677",
          state: "open",
          headRef: "feature/test",
          baseRef: "main",
        },
      });
      assert.equal(commands.length, 0);
    }),
  );

  it.effect("ignores a reused branch's pull request that finished before the workspace", () =>
    Effect.gen(function* () {
      const fresh = { ...baseWorktree, origin: "branch" as const, prNumber: null, prTitle: null };
      const stale = yield* run(fresh, {
        states: { 12: { state: "merged", mergedAt: "2026-01-01T00:00:00.000Z" } },
        discovered: {
          number: 12,
          title: "Old",
          url: "u",
          state: "merged",
          headRef: "feature/test",
          baseRef: "main",
        },
      });
      assert.equal(stale.commands.length, 0);
      resetWorktreePullRequestDiscoveryForTests();
      const recent = yield* run(fresh, {
        states: { 13: { state: "merged", mergedAt: "2026-05-17T05:00:00.000Z" } },
        discovered: {
          number: 13,
          title: "New",
          url: "u",
          state: "merged",
          headRef: "feature/test",
          baseRef: "main",
        },
      });
      assert.equal(recent.commands[0]?.upserts?.[0]?.number, 13);
    }),
  );

  it.effect("leaves a finished pull request with no forge close time to a manual link", () =>
    Effect.gen(function* () {
      const fresh = { ...baseWorktree, origin: "branch" as const, prNumber: null, prTitle: null };
      const discovered: DiscoveredPullRequest = {
        number: 12,
        title: "Old",
        url: "u",
        state: "merged",
        headRef: "feature/test",
        baseRef: "main",
      };
      // No close time from the forge (Bitbucket): our own "now" proves nothing.
      const unknown = yield* run(fresh, { states: { 12: { state: "merged" } }, discovered });
      assert.equal(unknown.commands.length, 0);
      resetWorktreePullRequestDiscoveryForTests();
      // Unless the user just merged it from Ryco.
      const actedOn = yield* run(fresh, {
        states: { 12: { state: "merged" } },
        discovered,
        actedOnPullRequestNumber: 12,
      });
      assert.equal(actedOn.commands[0]?.upserts?.[0]?.number, 12);
    }),
  );

  it.effect("does not discover for the project's main checkout", () =>
    Effect.gen(function* () {
      const result = yield* run(
        { ...baseWorktree, origin: "main", prNumber: null, prTitle: null },
        { discovered: null },
      );
      assert.equal(result.discoverCalls(), 0);
      assert.equal(result.commands.length, 0);
    }),
  );
});
