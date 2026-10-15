import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

const unusedStoreMethods = {
  isGitRepository: () => Effect.succeed(true),
  hasHeadCommit: () => Effect.succeed(true),
  captureCheckpoint: () => Effect.void,
  hasCheckpointRef: () => Effect.die("CheckpointDiffQuery resolves refs in one batch"),
  restoreCheckpoint: () => Effect.succeed(true),
  diffCheckpoints: () => Effect.die("CheckpointDiffQuery diffs resolved commits"),
  deleteCheckpointRefs: () => Effect.void,
  resolveCommit: () => Effect.succeed(null),
  pinRef: () => Effect.void,
} satisfies Partial<CheckpointStoreShape>;

function makeLayer(
  checkpointStore: CheckpointStoreShape,
  threadCheckpointContext: ProjectionThreadCheckpointContext | null,
) {
  return CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () =>
          Effect.die("CheckpointDiffQuery should not request the command read model"),
        getSnapshot: () =>
          Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
        getShellSnapshot: () =>
          Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
        getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () =>
          Effect.succeed(Option.fromNullishOr(threadCheckpointContext)),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
        searchThreadMessages: () => Effect.succeed([]),
      }),
    ),
  );
}

describe("CheckpointDiffQueryLive", () => {
  it("resolves both canonical refs in one batch and diffs the resolved commits", async () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const resolveCalls: Array<ReadonlyArray<CheckpointRef>> = [];
    const diffCalls: Array<Parameters<CheckpointStoreShape["diffCheckpointCommits"]>[0]> = [];

    const checkpointStore: CheckpointStoreShape = {
      ...unusedStoreMethods,
      resolveCheckpointCommits: ({ checkpointRefs }) =>
        Effect.sync(() => {
          resolveCalls.push(checkpointRefs);
          return checkpointRefs.map((_, index) => `oid-${index}`);
        }),
      diffCheckpointCommits: (input) =>
        Effect.sync(() => {
          diffCalls.push(input);
          return "diff patch";
        }),
    };

    const layer = makeLayer(
      checkpointStore,
      makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      }),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(resolveCalls).toEqual([[checkpointRefForThreadTurn(threadId, 0), toCheckpointRef]]);
    expect(diffCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCommitOid: "oid-0",
        toCommitOid: "oid-1",
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff patch",
    });
  });

  it("defaults to hide whitespace changes", async () => {
    const projectId = ProjectId.make("project-default-whitespace");
    const threadId = ThreadId.make("thread-default-whitespace");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCalls: Array<{ readonly ignoreWhitespace: boolean }> = [];

    const checkpointStore: CheckpointStoreShape = {
      ...unusedStoreMethods,
      resolveCheckpointCommits: ({ checkpointRefs }) =>
        Effect.succeed(checkpointRefs.map((_, index) => `oid-${index}`)),
      diffCheckpointCommits: ({ ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCalls.push({ ignoreWhitespace });
          return "diff patch";
        }),
    };

    const layer = makeLayer(
      checkpointStore,
      makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCalls).toEqual([{ ignoreWhitespace: true }]);
  });

  it("reuses a diff for the same commits and recomputes once a ref moves", async () => {
    const projectId = ProjectId.make("project-cache");
    const threadId = ThreadId.make("thread-cache");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    let toOid = "to-a";
    let diffRuns = 0;

    const checkpointStore: CheckpointStoreShape = {
      ...unusedStoreMethods,
      resolveCheckpointCommits: () => Effect.sync(() => ["from", toOid]),
      diffCheckpointCommits: (input) =>
        Effect.sync(() => {
          diffRuns += 1;
          return `patch ${input.toCommitOid} ${input.ignoreWhitespace}`;
        }),
    };

    const layer = makeLayer(
      checkpointStore,
      makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      }),
    );

    const diffs = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        const read = (ignoreWhitespace: boolean) =>
          query
            .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1, ignoreWhitespace })
            .pipe(Effect.map((result) => result.diff));
        const first = yield* read(true);
        const repeated = yield* read(true);
        const whitespaceVisible = yield* read(false);
        // A revert rewrites the checkpoint ref; the new commit must not hit the old entry.
        toOid = "to-b";
        const moved = yield* read(true);
        return [first, repeated, whitespaceVisible, moved];
      }).pipe(Effect.provide(layer)),
    );

    expect(diffs).toEqual([
      "patch to-a true",
      "patch to-a true",
      "patch to-a false",
      "patch to-b true",
    ]);
    expect(diffRuns).toBe(3);
  });

  it("reports the turn whose filesystem checkpoint is missing", async () => {
    const projectId = ProjectId.make("project-missing-ref");
    const threadId = ThreadId.make("thread-missing-ref");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

    const checkpointStore: CheckpointStoreShape = {
      ...unusedStoreMethods,
      resolveCheckpointCommits: () => Effect.succeed(["from", null]),
      diffCheckpointCommits: () => Effect.die("must not diff a missing checkpoint"),
    };

    const layer = makeLayer(
      checkpointStore,
      makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Filesystem checkpoint is unavailable for turn 1.");
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.make("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      ...unusedStoreMethods,
      resolveCheckpointCommits: () => Effect.succeed(["from", "to"]),
      diffCheckpointCommits: () => Effect.succeed(""),
    };

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(makeLayer(checkpointStore, null))),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});
