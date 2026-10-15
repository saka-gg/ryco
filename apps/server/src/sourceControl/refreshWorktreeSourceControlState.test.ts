import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProjectId,
  SourceControlProviderError,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { DateTime, Effect, Option, PubSub, Ref, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type {
  ProjectionWorktree,
  ProjectionWorktreeRepositoryShape,
} from "../persistence/Services/ProjectionWorktrees.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { canonicalStoragePath } from "../storage/lifecycle.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";
import type { SourceControlProviderRegistryShape } from "./SourceControlProviderRegistry.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import {
  isWorktreeLinkRefreshDue,
  LIFECYCLE_OWNED_CHECKOUT_RETRY_MS,
  makeSweepLinkStates,
  refreshWorktreeSourceControlState,
  resetWorktreePullRequestDiscoveryForTests,
  type BatchedLinkStates,
  type DiscoveredPullRequest,
  type KnownPullRequestState,
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

describe("checkouts missing on disk", () => {
  const failingRegistry = (provider: SourceControlProviderShape) => ({
    ...makeRegistry(provider),
    resolve: () =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "unknown",
          operation: "detectProvider",
          detail: "ENOENT: no such file or directory",
        }),
      ),
  });

  it.effect("records a deleted checkout once and stops asking the forge", () =>
    Effect.gen(function* () {
      const parent = mkdtempSync(path.join(os.tmpdir(), "ryco-missing-checkout-"));
      const checkout = path.join(parent, "deleted-workspace");
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      let forgeCalls = 0;
      const provider = makeProvider({
        getPullRequestState: () =>
          Effect.sync(() => {
            forgeCalls += 1;
            return { state: "open" as const, isDraft: false };
          }),
      });
      const run = refreshWorktreeSourceControlState({ worktreeId }).pipe(
        Effect.provideService(
          ProjectionWorktreeRepository,
          makeWorktreeRepo({ ...baseWorktree, worktreePath: checkout }),
        ),
        Effect.provideService(SourceControlProviderRegistry, failingRegistry(provider)),
        Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
      );

      yield* run;
      yield* run;

      const removals = (yield* Ref.get(dispatchRef)).filter(
        (command) => command.type === "worktree.checkout.remove",
      );
      assert.equal(removals.length, 1);
      assert.deepInclude(removals[0], { worktreeId, reason: "missing" });
      assert.equal(forgeCalls, 0);
      rmSync(parent, { recursive: true, force: true });
    }),
  );

  it.effect("leaves a checkout alone when its parent is missing too (an unmounted volume)", () =>
    Effect.gen(function* () {
      const volume = path.join(
        mkdtempSync(path.join(os.tmpdir(), "ryco-unmounted-")),
        "ryco-no-such-volume",
      );
      const checkout = path.join(volume, "workspace");
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      let resolves = 0;
      const registry = failingRegistry(makeProvider({}));
      const run = refreshWorktreeSourceControlState({ worktreeId }).pipe(
        Effect.provideService(
          ProjectionWorktreeRepository,
          makeWorktreeRepo({ ...baseWorktree, worktreePath: checkout }),
        ),
        Effect.provideService(SourceControlProviderRegistry, {
          ...registry,
          resolve: () => Effect.suspend(() => (resolves++, registry.resolve())),
        }),
        Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
        Effect.exit,
      );

      // Not a failure (no stack per sweep), never recorded as deleted, and
      // not re-resolved while it stays unavailable.
      assert.isTrue((yield* run)._tag === "Success");
      assert.isTrue((yield* run)._tag === "Success");
      assert.equal(resolves, 1);
      assert.equal((yield* Ref.get(dispatchRef)).length, 0);

      // Back (the volume is mounted again): refreshed at once.
      mkdirSync(checkout, { recursive: true });
      yield* run;
      assert.equal(resolves, 2);
      rmSync(path.dirname(volume), { recursive: true, force: true });
    }),
  );

  it.effect("retries a missing-checkout record that failed", () =>
    Effect.gen(function* () {
      const parent = mkdtempSync(path.join(os.tmpdir(), "ryco-missing-checkout-"));
      const checkout = path.join(parent, "deleted-workspace");
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      let attempts = 0;
      const engine = makeEngine(dispatchRef);
      const run = refreshWorktreeSourceControlState({ worktreeId }).pipe(
        Effect.provideService(
          ProjectionWorktreeRepository,
          makeWorktreeRepo({ ...baseWorktree, worktreePath: checkout }),
        ),
        Effect.provideService(SourceControlProviderRegistry, failingRegistry(makeProvider({}))),
        Effect.provideService(OrchestrationEngineService, {
          ...engine,
          dispatch: (command) =>
            Effect.suspend(() =>
              ++attempts === 1 ? Effect.die("dispatch unavailable") : engine.dispatch(command),
            ),
        }),
      );

      yield* run;
      yield* run;
      yield* run;
      assert.equal(attempts, 2);
      const removals = (yield* Ref.get(dispatchRef)).filter(
        (command) => command.type === "worktree.checkout.remove",
      );
      assert.equal(removals.length, 1);
      rmSync(parent, { recursive: true, force: true });
    }),
  );

  const lifecycleOwnedRun = (
    checkout: string,
    dispatchRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
    resolved: { count: number },
  ) => {
    const registry = failingRegistry(makeProvider({}));
    return refreshWorktreeSourceControlState({ worktreeId }).pipe(
      Effect.provideService(
        ProjectionWorktreeRepository,
        makeWorktreeRepo({ ...baseWorktree, worktreePath: checkout }),
      ),
      Effect.provideService(SourceControlProviderRegistry, {
        ...registry,
        resolve: () => Effect.suspend(() => (resolved.count++, registry.resolve())),
      }),
      Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
    );
  };
  const insertTombstone = (checkout: string, parent: string, state: "removing" | "removed") =>
    Effect.gen(function* () {
      const canonical = yield* Effect.promise(() => canonicalStoragePath(checkout));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO storage_owned_entries (id, path, repository_path, project_id, category, identity_json, created_at, state)
        VALUES ('fence-1', ${canonical}, ${parent}, ${projectId}, 'worktree', '{}', '2026-10-15T00:00:00.000Z', ${state})`;
    });

  it.effect("leaves a checkout Ryco's own removal is fencing to that removal", () =>
    Effect.gen(function* () {
      const parent = mkdtempSync(path.join(os.tmpdir(), "ryco-missing-checkout-"));
      const checkout = path.join(parent, "removing-workspace");
      yield* insertTombstone(checkout, parent, "removing");
      const sql = yield* SqlClient.SqlClient;
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const resolved = { count: 0 };
      const run = lifecycleOwnedRun(checkout, dispatchRef, resolved);
      const startMs = Date.now();
      const now = vi.spyOn(Date, "now");
      try {
        now.mockReturnValue(startMs);
        yield* run;
        // Not re-resolved on every sweep while the lifecycle owns it.
        yield* run;
        assert.equal(resolved.count, 1);
        assert.equal((yield* Ref.get(dispatchRef)).length, 0);

        // The removal gave the path back without recording it: now it is ours to record.
        yield* sql`DELETE FROM storage_owned_entries WHERE id = 'fence-1'`;
        now.mockReturnValue(startMs + LIFECYCLE_OWNED_CHECKOUT_RETRY_MS);
        yield* run;
        assert.equal(resolved.count, 2);
        assert.deepEqual(
          (yield* Ref.get(dispatchRef)).map((command) => command.type),
          ["worktree.checkout.remove"],
        );
      } finally {
        now.mockRestore();
        rmSync(parent, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("records a checkout a removed tombstone kept owning once its record is overdue", () =>
    Effect.gen(function* () {
      const parent = mkdtempSync(path.join(os.tmpdir(), "ryco-missing-checkout-"));
      const checkout = path.join(parent, "partially-removed-workspace");
      // A cleanup removed the checkout, but its workspace record never landed.
      yield* insertTombstone(checkout, parent, "removed");
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const resolved = { count: 0 };
      const run = lifecycleOwnedRun(checkout, dispatchRef, resolved);
      const startMs = Date.now();
      const now = vi.spyOn(Date, "now");
      try {
        now.mockReturnValue(startMs);
        // Within the window the lifecycle's own record is still expected.
        yield* run;
        now.mockReturnValue(startMs + LIFECYCLE_OWNED_CHECKOUT_RETRY_MS - 1);
        yield* run;
        assert.equal(resolved.count, 1);
        assert.equal((yield* Ref.get(dispatchRef)).length, 0);

        now.mockReturnValue(startMs + LIFECYCLE_OWNED_CHECKOUT_RETRY_MS);
        yield* run;
        const removals = (yield* Ref.get(dispatchRef)).filter(
          (command) => command.type === "worktree.checkout.remove",
        );
        assert.equal(removals.length, 1);
        assert.equal(
          removals[0]?.type === "worktree.checkout.remove" ? removals[0].reason : null,
          "missing",
        );
      } finally {
        now.mockRestore();
        rmSync(parent, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

describe("link refreshes", () => {
  const openLinkedWorktree: ProjectionWorktree = {
    ...baseWorktree,
    prState: "open",
    prIsDraft: false,
  };

  it.effect("skips re-reading an open link the caller already knows is still open", () =>
    Effect.gen(function* () {
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const reads: number[] = [];
      const provider = makeProvider({
        getPullRequestState: (input) =>
          Effect.sync(() => {
            reads.push(input.number);
            return { state: "merged" as const, isDraft: false };
          }),
      });
      const run = (known: ReadonlyMap<number, KnownPullRequestState>) =>
        refreshWorktreeSourceControlState({
          worktreeId,
          knownPullRequestStates: () => Effect.succeed(known),
        }).pipe(
          Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(openLinkedWorktree)),
          Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
          Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
        );

      yield* run(new Map([[10, { state: "open", isDraft: false }]]));
      assert.deepStrictEqual(reads, []);

      // Known to have changed: read live for the close time.
      yield* run(new Map([[10, { state: "merged", isDraft: false }]]));
      assert.deepStrictEqual(reads, [10]);
    }),
  );

  it.effect("takes a batched forge read as the link's state and close time", () =>
    Effect.gen(function* () {
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const reads: number[] = [];
      const provider = makeProvider({
        getPullRequestState: (input) =>
          Effect.sync(() => {
            reads.push(input.number);
            return { state: "open" as const, isDraft: false };
          }),
      });
      yield* refreshWorktreeSourceControlState({
        worktreeId,
        knownPullRequestStates: () =>
          Effect.succeed(
            new Map([
              [
                10,
                {
                  state: "merged",
                  isDraft: false,
                  reported: { terminalAt: "2026-10-01T12:00:00.000Z" },
                },
              ],
            ]),
          ),
      }).pipe(
        Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(openLinkedWorktree)),
        Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
        Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
      );
      assert.deepStrictEqual(reads, []);
      const [command] = yield* Ref.get(dispatchRef);
      assert.equal(command?.type, "worktree.pull-requests.update");
      if (command?.type !== "worktree.pull-requests.update") return;
      assert.deepStrictEqual(
        command.upserts?.map((upsert) => [upsert.number, upsert.state, upsert.terminalAt]),
        [[10, "merged", "2026-10-01T12:00:00.000Z"]],
      );
    }),
  );

  it.effect("re-reads links at most once per interval for sweeps", () =>
    Effect.gen(function* () {
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      let reads = 0;
      const provider = makeProvider({
        getPullRequestState: () =>
          Effect.sync(() => {
            reads += 1;
            return { state: "open" as const, isDraft: false };
          }),
      });
      const run = refreshWorktreeSourceControlState({
        worktreeId,
        linkRefreshIntervalMs: 60_000,
      }).pipe(
        Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(openLinkedWorktree)),
        Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
        Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
      );

      yield* run;
      yield* run;
      assert.equal(reads, 1);
    }),
  );

  it.effect("takes a known issue state instead of reading the issue", () =>
    Effect.gen(function* () {
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      let issueReads = 0;
      const provider = makeProvider({
        getPullRequestState: () => Effect.succeed({ state: "open" as const, isDraft: false }),
        getIssueState: () =>
          Effect.sync(() => {
            issueReads += 1;
            return { state: "open" as const };
          }),
      });
      yield* refreshWorktreeSourceControlState({
        worktreeId,
        knownPullRequestStates: () =>
          Effect.succeed(new Map([[10, { state: "open", isDraft: false }]])),
        knownIssueStates: () => Effect.succeed(new Map([[5, "closed" as const]])),
      }).pipe(
        Effect.provideService(
          ProjectionWorktreeRepository,
          makeWorktreeRepo({ ...openLinkedWorktree, issueNumber: 5, issueState: "open" }),
        ),
        Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
        Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
      );
      assert.equal(issueReads, 0);
      const [command] = linkCommands(yield* Ref.get(dispatchRef));
      assert.equal(command?.issueState, "closed");
    }),
  );
});

describe("sweep link states", () => {
  const SWEEP_INTERVAL_MS = 5 * 60_000;
  const linked = (id: string, prNumber: number, issueNumber: number | null) =>
    ({
      ...baseWorktree,
      worktreeId: WorktreeId.make(id),
      prNumber,
      prState: "open",
      prIsDraft: false,
      issueNumber,
    }) satisfies ProjectionWorktree;
  const worktrees = [linked("wt-a", 10, 5), linked("wt-b", 11, null), linked("wt-c", 12, 6)];

  const plan = (input: {
    readonly known?: ReadonlyMap<number, KnownPullRequestState>;
    readonly knownIssues?: ReadonlyMap<number, "open" | "closed">;
  }) =>
    Effect.gen(function* () {
      const batches: Array<{ pullRequests: number[]; issues: number[] }> = [];
      const states = yield* makeSweepLinkStates({
        worktrees,
        linkRefreshIntervalMs: SWEEP_INTERVAL_MS,
        knownPullRequestStates: () => Effect.succeed(input.known ?? new Map()),
        knownIssues: input.knownIssues ?? new Map(),
        readLinkStates: (numbers) =>
          Effect.sync((): BatchedLinkStates => {
            batches.push({
              pullRequests: [...numbers.pullRequestNumbers],
              issues: [...numbers.issueNumbers],
            });
            return {
              pullRequests: new Map([
                [10, { state: "merged", isDraft: false, reported: { terminalAt: null } }],
              ]),
              issues: new Map([[6, "closed"]]),
            };
          }),
        cwd: "/repo",
      });
      return { states, batches };
    });

  it.effect("asks once, only for links and issues the known states cannot answer", () =>
    Effect.gen(function* () {
      const { states, batches } = yield* plan({
        known: new Map([[11, { state: "open", isDraft: false }]]),
        knownIssues: new Map([[5, "open"]]),
      });
      assert.deepStrictEqual(batches, []);
      const [pullRequests, issues] = yield* Effect.all(
        [states.knownPullRequestStates("/repo/wt-a"), states.knownIssueStates("/repo/wt-c")],
        { concurrency: "unbounded" },
      );
      yield* states.knownPullRequestStates("/repo/wt-b");
      assert.deepStrictEqual(batches, [{ pullRequests: [10, 12], issues: [6] }]);
      assert.equal(pullRequests.get(10)?.state, "merged");
      assert.equal(pullRequests.get(11)?.state, "open");
      assert.deepStrictEqual(
        [...issues],
        [
          [5, "open"],
          [6, "closed"],
        ],
      );
    }),
  );

  it.effect("makes no forge call while no workspace is due for a link refresh", () =>
    Effect.gen(function* () {
      const dispatchRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const provider = makeProvider({
        getPullRequestState: () => Effect.succeed({ state: "open" as const, isDraft: false }),
        getIssueState: () => Effect.succeed({ state: "open" as const }),
      });
      // Every workspace just refreshed its links.
      for (const worktree of worktrees) {
        yield* refreshWorktreeSourceControlState({
          worktreeId: worktree.worktreeId,
          linkRefreshIntervalMs: SWEEP_INTERVAL_MS,
        }).pipe(
          Effect.provideService(ProjectionWorktreeRepository, makeWorktreeRepo(worktree)),
          Effect.provideService(SourceControlProviderRegistry, makeRegistry(provider)),
          Effect.provideService(OrchestrationEngineService, makeEngine(dispatchRef)),
        );
        assert.isFalse(isWorktreeLinkRefreshDue(worktree.worktreeId, SWEEP_INTERVAL_MS));
      }
      const { states, batches } = yield* plan({});
      yield* states.knownPullRequestStates("/repo/wt-a");
      yield* states.knownIssueStates("/repo/wt-a");
      assert.deepStrictEqual(batches, []);
    }),
  );
});
