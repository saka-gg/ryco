import type { OrchestrationCommand } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadPurgeReactor } from "../Services/ThreadPurgeReactor.ts";
import { makeThreadPurgeReactorLive, threadPurgeCommandId } from "./ThreadPurgeReactor.ts";
import {
  createMarkerTable,
  iso,
  makeFakeEngine,
  removedProjectId,
  settle,
  thread,
  trashedAt,
  worktree,
  writeMarker,
  type FakeThread,
  type FakeWorktree,
} from "./threadPurge.testSupport.ts";

const GRACE_MS = 10_000;

/** Starts the reactor over a fake engine; `marker` pre-records the Trash retirement. */
const startReactor = (input: {
  readonly nowMs: number;
  readonly marker?: string;
  readonly threads?: ReadonlyArray<FakeThread>;
  readonly worktrees?: ReadonlyArray<FakeWorktree>;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(input.nowMs);
    yield* createMarkerTable;
    if (input.marker !== undefined) yield* writeMarker(input.marker);
    const fake = yield* makeFakeEngine(input);
    const context = yield* Layer.build(
      makeThreadPurgeReactorLive({ graceMs: GRACE_MS, sweepInterval: "1 hour" }).pipe(
        Layer.provide(Layer.succeed(OrchestrationEngineService, fake.engine)),
        Layer.provide(Layer.mock(ProjectionSnapshotQuery)({})),
      ),
    );
    const reactor = yield* Effect.service(ThreadPurgeReactor).pipe(Effect.provide(context));
    yield* reactor.start();
    const retiredAt = yield* reactor.awaitStartupSweep;
    yield* settle;
    return { ...fake, retiredAt };
  });

const advance = (ms: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(Duration.millis(ms));
    yield* settle;
  });

const purges = (applied: ReadonlyArray<OrchestrationCommand>) =>
  applied.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.delete" }> =>
      command.type === "thread.delete",
  );

it.layer(NodeSqliteClient.layerMemory())("ThreadPurgeReactor", (it) => {
  it.effect("deletes a trashed conversation once the grace period passed", () =>
    Effect.gen(function* () {
      const fake = yield* startReactor({ nowMs: 1_000, threads: [thread("t1")] });
      assert.strictEqual(fake.retiredAt, iso(1_000));

      yield* advance(1_000);
      yield* fake.userCommand("thread.trash", "t1");
      yield* settle;
      const trashed = fake.thread("t1")!.trashedAt!;

      yield* advance(GRACE_MS - 1);
      assert.deepStrictEqual(purges(fake.applied), []);

      yield* advance(1);
      assert.deepStrictEqual(
        purges(fake.applied).map((command) => command.commandId),
        [threadPurgeCommandId(fake.thread("t1")!.id, trashed)],
      );
      assert.strictEqual(fake.thread("t1")!.trashedAt, null);
      assert.isNotNull(fake.thread("t1")!.deletedAt);
    }).pipe(Effect.scoped),
  );

  it.effect("Undo wins: an untrashed conversation is never deleted, a re-trash restarts", () =>
    Effect.gen(function* () {
      const fake = yield* startReactor({ nowMs: 1_000, threads: [thread("t1")] });
      yield* advance(1_000);
      yield* fake.userCommand("thread.trash", "t1");
      yield* settle;

      yield* advance(5_000);
      yield* fake.userCommand("thread.untrash", "t1");
      yield* advance(GRACE_MS * 2);
      assert.deepStrictEqual(purges(fake.applied), []);
      // Refused before the decider: no rejected receipt blocks a later purge of the same id.
      assert.deepStrictEqual(fake.rejected, []);
      assert.strictEqual(fake.thread("t1")!.deletedAt, null);

      yield* fake.userCommand("thread.trash", "t1");
      yield* settle;
      yield* advance(GRACE_MS - 1);
      assert.deepStrictEqual(purges(fake.applied), []);
      yield* advance(1);
      assert.strictEqual(purges(fake.applied).length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("startup purges overdue conversations and schedules the rest", () =>
    Effect.gen(function* () {
      const fake = yield* startReactor({
        nowMs: 20_000,
        marker: iso(1_000),
        threads: [thread("overdue", trashedAt(5_000)), thread("pending", trashedAt(15_000))],
      });
      assert.deepStrictEqual(
        purges(fake.applied).map((command) => command.threadId),
        [fake.thread("overdue")!.id],
      );

      yield* advance(4_999);
      assert.strictEqual(purges(fake.applied).length, 1);
      yield* advance(1);
      assert.deepStrictEqual(
        purges(fake.applied).map((command) => command.threadId as string),
        ["overdue", "pending"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("never purges conversations trashed before the Trash retirement", () =>
    Effect.gen(function* () {
      const fake = yield* startReactor({
        nowMs: 100_000,
        marker: iso(10_000),
        threads: [
          // Kept in Trash because its project is gone; older than the marker.
          thread("orphan", { ...trashedAt(5_000), projectId: removedProjectId }),
          thread("at-marker", trashedAt(10_000)),
        ],
      });
      yield* advance(GRACE_MS * 10);
      assert.deepStrictEqual(fake.applied, []);
      assert.isNotNull(fake.thread("orphan")!.trashedAt);
      assert.isNotNull(fake.thread("at-marker")!.trashedAt);
    }).pipe(Effect.scoped),
  );

  it.effect("retires Trash before anything is purged", () =>
    Effect.gen(function* () {
      const fake = yield* startReactor({
        nowMs: 50_000,
        threads: [
          thread("old", trashedAt(1_000)),
          thread("orphan", { ...trashedAt(2_000), projectId: removedProjectId }),
        ],
      });
      assert.strictEqual(fake.retiredAt, iso(50_000));
      yield* advance(GRACE_MS * 10);
      assert.deepStrictEqual(
        fake.applied.map((command) => command.type),
        ["thread.untrash", "thread.archive"],
      );
      assert.strictEqual(fake.thread("old")!.deletedAt, null);
      assert.isNotNull(fake.thread("old")!.archivedAt);
      assert.isNotNull(fake.thread("orphan")!.trashedAt);
    }).pipe(Effect.scoped),
  );

  it.effect("drops a deleted workspace's record with its last conversation", () =>
    Effect.gen(function* () {
      const tombstone = worktree("w-deleted");
      const fake = yield* startReactor({
        nowMs: 1_000,
        marker: iso(0),
        threads: [
          thread("first", { worktreeId: tombstone.worktreeId }),
          // Path-backed provenance counts as a reference too.
          thread("second", { worktreePath: tombstone.worktreePath }),
        ],
        worktrees: [tombstone],
      });

      yield* fake.userCommand("thread.trash", "first");
      yield* settle;
      yield* advance(GRACE_MS);
      assert.strictEqual(purges(fake.applied).length, 1);
      assert.deepStrictEqual(fake.worktreeIds(), ["w-deleted"]);

      yield* fake.userCommand("thread.trash", "second");
      yield* settle;
      // Still trashed (recoverable): the record stays.
      assert.deepStrictEqual(fake.worktreeIds(), ["w-deleted"]);
      yield* advance(GRACE_MS);
      assert.strictEqual(purges(fake.applied).length, 2);
      assert.deepStrictEqual(fake.worktreeIds(), []);
      const collected = fake.applied.filter((command) => command.type === "worktree.delete");
      assert.strictEqual(collected.length, 1);
      assert.deepInclude(collected[0], { worktreeId: tombstone.worktreeId, deletedBranch: false });
    }).pipe(Effect.scoped),
  );

  it.effect("startup drops unreferenced deleted workspace records only", () =>
    Effect.gen(function* () {
      const fake = yield* startReactor({
        nowMs: 1_000,
        marker: iso(0),
        threads: [
          thread("archived", {
            worktreeId: worktree("w-referenced").worktreeId,
            archivedAt: iso(0),
          }),
          thread("gone", { worktreeId: worktree("w-unreferenced").worktreeId, deletedAt: iso(0) }),
        ],
        worktrees: [
          worktree("w-unreferenced"),
          worktree("w-referenced"),
          worktree("w-removed", { checkoutRemovalReason: "removed" }),
          worktree("w-main", { origin: "main" }),
        ],
      });
      assert.deepStrictEqual(fake.worktreeIds(), ["w-referenced", "w-removed", "w-main"]);
    }).pipe(Effect.scoped),
  );
});
