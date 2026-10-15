import {
  OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell as ThreadShell,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  scopeShellSnapshot,
  threadKeyPageOf,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { listThreadsPage } from "./threadReads.ts";

const thread = (index: number, options: { archived?: boolean; projectId?: string } = {}) =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: `thread-${String(index).padStart(3, "0")}`,
    projectId: options.projectId ?? "project-1",
    title: `Thread ${index}`,
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    // Pairs share a creation time, so the id breaks ties.
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(index / 2))).toISOString(),
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: options.archived === true ? "2026-10-02T00:00:00.000Z" : null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

// Shuffled storage order, every third thread archived, every fifth hidden from the caller.
const threads = Array.from({ length: 250 }, (_, index) =>
  thread(index, { archived: index % 3 === 0 }),
).toReversed();
const visible = (shell: ThreadShell) => Number(shell.id.slice("thread-".length)) % 5 !== 0;

const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 9,
  projects: [],
  threads,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const makeProjections = () => {
  const calls = { keys: 0, scoped: 0 };
  const projections = {
    getShellSnapshot: () => Effect.die("an unscoped listing must not build the whole shell"),
    listThreadKeyPage: (input) =>
      Effect.sync(() => {
        calls.keys += 1;
        return threadKeyPageOf(snapshot, input);
      }),
    getScopedShellSnapshot: (scope) =>
      Effect.sync(() => {
        calls.scoped += 1;
        // Bounded by the key batch, never the whole shell.
        assert.isAtMost(scope.threadIds?.length ?? Number.POSITIVE_INFINITY, 100);
        return scopeShellSnapshot(snapshot, scope);
      }),
  } as Partial<ProjectionSnapshotQueryShape> as ProjectionSnapshotQueryShape;
  return { projections, calls };
};

const pageThrough = (projections: ProjectionSnapshotQueryShape, includeArchived: boolean) =>
  Effect.gen(function* () {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = yield* listThreadsPage(
        projections,
        { limit: 40, includeArchived, ...(cursor === undefined ? {} : { cursor }) },
        visible,
      );
      pages += 1;
      ids.push(...page.threads.map((entry) => entry.threadId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return { ids, pages };
  });

it.effect("pages an unscoped thread listing by keyset reads, never a whole shell", () =>
  Effect.gen(function* () {
    for (const includeArchived of [false, true]) {
      const { projections, calls } = makeProjections();
      const { ids, pages } = yield* pageThrough(projections, includeArchived);
      const expected = threads
        .filter((entry) => visible(entry) && (includeArchived || entry.archivedAt === null))
        .toSorted((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .map((entry) => entry.id);
      assert.deepEqual(ids, expected);
      assert.equal(pages, Math.ceil(expected.length / 40));
      // About one keyset batch and one bounded scoped read per page.
      assert.isAtMost(calls.keys, pages + 1);
      assert.isAtMost(calls.scoped, calls.keys);
    }
  }),
);

it.effect("rejects a malformed cursor on an unscoped listing", () =>
  Effect.gen(function* () {
    const { projections } = makeProjections();
    const failure = yield* listThreadsPage(projections, { cursor: "not-a-cursor" }).pipe(
      Effect.flip,
    );
    assert.equal(failure.reason, "Invalid cursor.");
  }),
);
