import {
  ProjectId,
  SourceControlProviderError,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
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
import { refreshWorktreeSourceControlState } from "./refreshWorktreeSourceControlState.ts";

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

    const dispatched = yield* Ref.get(dispatchRef);
    assert.equal(dispatched.length, 1);
    const cmd = dispatched[0];
    assert.equal(cmd?.type, "worktree.source-control-state.update");
    if (cmd?.type === "worktree.source-control-state.update") {
      assert.equal(cmd.prState, "merged");
      assert.equal(cmd.prIsDraft, false);
      assert.equal(cmd.issueState, null);
      assert.equal(cmd.worktreeId, worktreeId);
    }
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

it.effect("worktree with no prNumber or issueNumber → no-op", () =>
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
      return (yield* Ref.get(dispatchRef)).filter(
        (
          command,
        ): command is Extract<
          OrchestrationCommand,
          { type: "worktree.source-control-state.update" }
        > => command.type === "worktree.source-control-state.update",
      );
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
