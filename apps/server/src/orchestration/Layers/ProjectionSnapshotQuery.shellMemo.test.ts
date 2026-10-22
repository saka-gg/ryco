import type { OrchestrationShellSnapshot } from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Tracer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { pageShellSnapshot } from "../../ws/context/shellSnapshotPages.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  makeCurrentShellMemo,
  OrchestrationProjectionSnapshotQueryLive,
  SHELL_MEMO_IDLE_EVICTION_MS,
  SHELL_MEMO_MAX_AGE_MS,
} from "./ProjectionSnapshotQuery.ts";

const queryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const MODEL = '{"instanceId":"codex","model":"gpt-5-codex"}';
const PROJECT_ID = "project-memo";
const THREAD_IDS = ["thread-a", "thread-b", "thread-c"] as const;
const USABLE_UNTIL = "2099-01-01T00:00:00.000Z";

/** When the event at `sequence` happened: every event moves the times it touches. */
const eventTime = (sequence: number) =>
  new Date(Date.UTC(2026, 9, 1) + sequence * 1_000).toISOString();

/** Counts shell builds by the span each one opens. */
const makeBuildCounter = () => {
  let builds = 0;
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name === "ProjectionSnapshotQuery.buildShell") builds += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  return { tracer, builds: () => builds };
};

/** What the pipeline records with every projected event: each projector's cursor and time. */
const recordProgress = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projector}, ${sequence}, ${eventTime(sequence)})
        ON CONFLICT (projector) DO UPDATE SET
          last_applied_sequence = excluded.last_applied_sequence,
          updated_at = excluded.updated_at
      `;
    }
  });

const insertProjectAndThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at
    ) VALUES (
      ${PROJECT_ID}, 'Memo', '/workspace/memo', ${MODEL}, '[]', ${eventTime(0)}, ${eventTime(0)}
    )
  `;
  for (const threadId of THREAD_IDS) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at
      ) VALUES (
        ${threadId}, ${PROJECT_ID}, ${threadId}, ${MODEL}, 'full-access', 'default',
        ${eventTime(0)}, ${eventTime(0)}
      )
    `;
  }
});

/** A project with three threads, projected up to `sequence`. */
const seedProjection = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      insertProjectAndThreads.pipe(Effect.andThen(recordProgress(sequence))),
    );
  });

/** A rename projected as the pipeline projects it: its row and every cursor, in one transaction. */
const projectRename = (sequence: number, threadId: string, title: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE projection_threads SET title = ${title}, updated_at = ${eventTime(sequence)}
          WHERE thread_id = ${threadId}
        `;
        yield* recordProgress(sequence);
      }),
    );
  });

/** Replace the priority batch (one slot) with `batchId` ranking `threadIds`, or with nothing. */
const rankThreads = (batchId: string | null, threadIds: ReadonlyArray<string>, rankedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM thread_priority_rankings`;
        yield* sql`DELETE FROM thread_priority_batches`;
        if (batchId === null) return;
        yield* sql`
          INSERT INTO thread_priority_batches (
            slot, batch_id, input_fingerprint, model_selection_json, model_fingerprint,
            prompt_version, ranked_at, usable_until, checked_at
          ) VALUES (
            1, ${batchId}, 'fingerprint', ${MODEL}, 'model', 'v1', ${rankedAt}, ${USABLE_UNTIL},
            ${rankedAt}
          )
        `;
        for (const threadId of threadIds) {
          yield* sql`
            INSERT INTO thread_priority_rankings (
              thread_id, batch_id, tier, confidence, reason, input_fingerprint
            ) VALUES (${threadId}, ${batchId}, 'now', 'high', 'Waiting on you', 'thread-fp')
          `;
        }
      }),
    );
  });

const startBackgroundWork = (threadId: string, taskId: string) =>
  Effect.gen(function* () {
    const liveness = yield* ThreadBackgroundLivenessService;
    liveness.recordTaskLiveness({
      threadId,
      taskId,
      taskType: undefined,
      status: undefined,
      kind: "started",
    });
  });

const finishBackgroundWork = (threadId: string, taskId: string) =>
  Effect.gen(function* () {
    const liveness = yield* ThreadBackgroundLivenessService;
    liveness.recordTaskLiveness({
      threadId,
      taskId,
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
  });

/** A repository identity recorded as the background sync records it: outside the event log. */
const recordRepositoryIdentity = (canonicalKey: string, checkedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const identity = JSON.stringify({
      canonicalKey,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${canonicalKey}.git`,
      },
      remotes: [],
    });
    yield* sql`
      UPDATE projection_projects
      SET repository_identity_json = ${identity}, repository_identity_checked_at = ${checkedAt}
      WHERE project_id = ${PROJECT_ID}
    `;
  });

type ShellForm = "full" | "stubbed";

/** The shell a subscriber of `form` gets. */
const readShell = (form: ShellForm) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    return yield* form === "full" ? query.getShellSnapshot() : query.getStubbedShellSnapshot!();
  });

/** A fresh build of `form`: a caller inside a transaction always builds its own. */
const buildShell = (form: ShellForm) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(readShell(form));
  });

const titleOf = (snapshot: OrchestrationShellSnapshot, threadId: string) =>
  snapshot.threads.find((thread) => thread.id === threadId)?.title;

/** Lets every fiber forked so far run until it waits. */
const settle = Effect.gen(function* () {
  for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
});

/**
 * A memo over builds that each hold until released, by their index; a build reads the version
 * as it starts, as a build's transaction reads its rows.
 */
const makeGatedMemo = (input: {
  readonly version: () => string;
  readonly fails?: (build: number) => boolean;
}) =>
  Effect.gen(function* () {
    const gates = Array.from({ length: 4 }, () => Deferred.makeUnsafe<void>());
    let builds = 0;
    const memo = yield* makeCurrentShellMemo({
      build: () =>
        Effect.gen(function* () {
          const build = builds++;
          const version = input.version();
          yield* Deferred.await(gates[build]!);
          if (input.fails?.(build) === true) return yield* Effect.fail("database is locked");
          return { snapshot: { build }, version };
        }),
      readVersion: Effect.sync(input.version),
    });
    return {
      memo,
      builds: () => builds,
      release: (build: number) => Deferred.succeed(gates[build]!, undefined),
    };
  });

describe("shell memo", () => {
  it.effect("serves the last shell again while nothing changed", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      const first = yield* readShell("stubbed");
      assert.equal(counter.builds(), 1);
      assert.strictEqual(yield* readShell("stubbed"), first);
      assert.equal(counter.builds(), 1);

      // Each form has a memo of its own.
      const full = yield* readShell("full");
      assert.strictEqual(yield* readShell("full"), full);
      assert.equal(counter.builds(), 2);

      // What it serves is what a fresh build at the same sequence produces.
      assert.deepStrictEqual(first, yield* buildShell("stubbed"));
      assert.deepStrictEqual(full, yield* buildShell("full"));
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("builds again after a projected event", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      yield* readShell("stubbed");
      yield* projectRename(2, "thread-a", "Renamed");

      const after = yield* readShell("stubbed");
      assert.equal(counter.builds(), 2);
      assert.equal(after.snapshotSequence, 2);
      assert.equal(titleOf(after, "thread-a"), "Renamed");
      assert.strictEqual(yield* readShell("stubbed"), after);
      assert.equal(counter.builds(), 2);
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("builds again after the priority batch changes", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      yield* readShell("stubbed");

      yield* rankThreads("batch-1", ["thread-b"], eventTime(10));
      const ranked = yield* readShell("stubbed");
      assert.equal(counter.builds(), 2);
      assert.equal(
        ranked.threads.find((thread) => thread.id === "thread-b")?.priority?.batchId,
        "batch-1",
      );

      // A re-rank of the same threads is a new batch.
      yield* rankThreads("batch-2", ["thread-b"], eventTime(11));
      const reranked = yield* readShell("stubbed");
      assert.equal(counter.builds(), 3);
      assert.equal(
        reranked.threads.find((thread) => thread.id === "thread-b")?.priority?.batchId,
        "batch-2",
      );

      yield* rankThreads(null, [], eventTime(12));
      const unranked = yield* readShell("stubbed");
      assert.equal(counter.builds(), 4);
      assert.isUndefined(unranked.threads.find((thread) => thread.id === "thread-b")?.priority);
      assert.deepStrictEqual(unranked, yield* buildShell("stubbed"));
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("builds again after background liveness changes", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      yield* readShell("stubbed");

      yield* startBackgroundWork("thread-c", "task-1");
      const working = yield* readShell("stubbed");
      assert.equal(counter.builds(), 2);
      assert.equal(
        working.threads.find((thread) => thread.id === "thread-c")?.backgroundLiveness,
        "working",
      );
      assert.strictEqual(yield* readShell("stubbed"), working);

      yield* finishBackgroundWork("thread-c", "task-1");
      const idle = yield* readShell("stubbed");
      assert.equal(counter.builds(), 3);
      assert.isNull(
        idle.threads.find((thread) => thread.id === "thread-c")?.backgroundLiveness ?? null,
      );
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("builds again after a project's repository identity is recorded", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      const before = yield* readShell("stubbed");
      assert.isNull(before.projects[0]?.repositoryIdentity ?? null);

      // Recorded at an unchanged sequence: the event announcing it comes after.
      yield* recordRepositoryIdentity("github.com/acme/memo", eventTime(20));
      const after = yield* readShell("stubbed");
      assert.equal(counter.builds(), 2);
      assert.equal(after.snapshotSequence, 1);
      assert.equal(after.projects[0]?.repositoryIdentity?.canonicalKey, "github.com/acme/memo");
      assert.strictEqual(yield* readShell("stubbed"), after);

      yield* recordRepositoryIdentity("github.com/acme/moved", eventTime(21));
      const moved = yield* readShell("stubbed");
      assert.equal(counter.builds(), 3);
      assert.equal(moved.projects[0]?.repositoryIdentity?.canonicalKey, "github.com/acme/moved");
      assert.deepStrictEqual(moved, yield* buildShell("stubbed"));
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("builds again once the memo is older than 2 s", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      const first = yield* readShell("stubbed");
      yield* TestClock.adjust(SHELL_MEMO_MAX_AGE_MS);
      assert.strictEqual(yield* readShell("stubbed"), first);
      assert.equal(counter.builds(), 1);

      yield* TestClock.adjust(1);
      const rebuilt = yield* readShell("stubbed");
      assert.equal(counter.builds(), 2);
      assert.notStrictEqual(rebuilt, first);
      assert.deepStrictEqual(rebuilt, first);
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("leaves callers inside a transaction building their own", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      const memoized = yield* readShell("full");
      const own = yield* buildShell("full");
      assert.equal(counter.builds(), 2);
      assert.notStrictEqual(own, memoized);
      assert.deepStrictEqual(own, memoized);
      // Their build does not replace the memo.
      assert.strictEqual(yield* readShell("full"), memoized);
      assert.equal(counter.builds(), 2);
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("never serves a shell whose projection has not recorded its progress", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      // Rows without cursors: no sequence to compare, so every read builds.
      yield* insertProjectAndThreads;
      yield* readShell("stubbed");
      yield* readShell("stubbed");
      assert.equal(counter.builds(), 2);
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("serves a snapshot that nothing it is handed to changes", () => {
    const counter = makeBuildCounter();
    return Effect.gen(function* () {
      yield* seedProjection(1);
      yield* rankThreads("batch-1", ["thread-a"], eventTime(10));
      yield* startBackgroundWork("thread-b", "task-1");
      const served = yield* readShell("stubbed");
      const asBuilt = structuredClone(served);

      // Paging and encoding, as subscribers do, then served again to another.
      pageShellSnapshot(served);
      JSON.stringify(served);
      const again = yield* readShell("stubbed");
      pageShellSnapshot(again);
      assert.strictEqual(again, served);
      assert.equal(counter.builds(), 1);
      assert.deepStrictEqual(served, asBuilt);
      assert.deepStrictEqual(served, yield* buildShell("stubbed"));
    }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
  });

  it.effect("drops a memo 30 s after its last use", () =>
    Effect.gen(function* () {
      let builds = 0;
      const memo = yield* makeCurrentShellMemo({
        build: () => Effect.sync(() => ({ snapshot: { build: ++builds }, version: "v1" })),
        readVersion: Effect.succeed("v1"),
      });

      yield* memo.read();
      assert.isTrue(memo.holding());
      yield* TestClock.adjust(SHELL_MEMO_MAX_AGE_MS);
      assert.deepStrictEqual(yield* memo.read(), { build: 1 });

      // Idle for less than 30 s since that use: still held.
      yield* TestClock.adjust(SHELL_MEMO_IDLE_EVICTION_MS - 1);
      yield* settle;
      assert.isTrue(memo.holding());
      yield* TestClock.adjust(1);
      yield* settle;
      assert.isFalse(memo.holding());

      // The next read builds again and holds the new shell.
      assert.deepStrictEqual(yield* memo.read(), { build: 2 });
      assert.isTrue(memo.holding());
    }).pipe(Effect.scoped),
  );

  it.effect("never serves a build whose version could not be read", () =>
    Effect.gen(function* () {
      let builds = 0;
      const memo = yield* makeCurrentShellMemo({
        build: () => Effect.sync(() => ({ snapshot: ++builds, version: "v1" })),
        readVersion: Effect.fail("projection state unreadable"),
      });
      yield* memo.read();
      yield* memo.read();
      assert.equal(builds, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("serves a build already under way once it turns out current, without a second", () =>
    Effect.gen(function* () {
      const gated = yield* makeGatedMemo({ version: () => "v1" });
      // A channel open warms the shell; its client subscribes while that build runs.
      const warming = yield* Effect.forkChild(gated.memo.read());
      yield* settle;
      assert.equal(gated.builds(), 1);
      const subscribing = yield* Effect.forkChild(gated.memo.read());
      yield* settle;

      yield* gated.release(0);
      const warmed = yield* Fiber.join(warming);
      yield* settle;
      assert.equal(gated.builds(), 1);
      assert.strictEqual(yield* Fiber.join(subscribing), warmed);
    }).pipe(Effect.scoped),
  );

  it.effect("builds once more for every read that waited out a build the shell moved past", () =>
    Effect.gen(function* () {
      let version = "v1";
      const gated = yield* makeGatedMemo({ version: () => version });
      const warming = yield* Effect.forkChild(gated.memo.read());
      yield* settle;
      // An event lands after the build under way read its rows; three clients subscribe.
      version = "v2";
      const subscribing = yield* Effect.forEach([1, 2, 3], () =>
        Effect.forkChild(gated.memo.read()),
      );
      yield* settle;

      yield* gated.release(0);
      assert.deepStrictEqual(yield* Fiber.join(warming), { build: 0 });
      yield* settle;
      assert.equal(gated.builds(), 2);
      yield* gated.release(1);
      yield* settle;
      assert.equal(gated.builds(), 2);
      for (const fiber of subscribing) {
        assert.deepStrictEqual(yield* Fiber.join(fiber), { build: 1 });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("builds for a read that waited out a build that failed", () =>
    Effect.gen(function* () {
      const gated = yield* makeGatedMemo({ version: () => "v1", fails: (build) => build === 0 });
      const warming = yield* Effect.forkChild(Effect.exit(gated.memo.read()));
      yield* settle;
      const subscribing = yield* Effect.forkChild(gated.memo.read());
      yield* settle;

      yield* gated.release(0);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(warming)));
      yield* settle;
      yield* gated.release(1);
      assert.deepStrictEqual(yield* Fiber.join(subscribing), { build: 1 });
      assert.equal(gated.builds(), 2);
    }).pipe(Effect.scoped),
  );
});

/** mulberry32: a small seeded generator, so a failing interleaving replays from its seed. */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const SEEDS = [0x5eed_0001, 0x5eed_0002, 0x5eed_0003] as const;
const RUNS_PER_SEED = 200;
const STEPS_PER_RUN = 40;

interface RenameEvent {
  readonly sequence: number;
  readonly threadId: string;
  readonly title: string;
}

/** A subscriber's view: the snapshot's titles with the events after its sequence replayed. */
const replayTitles = (
  snapshot: OrchestrationShellSnapshot,
  events: ReadonlyArray<RenameEvent>,
): Record<string, string> => {
  const titles: Record<string, string> = Object.fromEntries(
    snapshot.threads.map((thread) => [thread.id, thread.title]),
  );
  for (const event of events) {
    if (event.sequence > snapshot.snapshotSequence) titles[event.threadId] = event.title;
  }
  return titles;
};

describe("shell memo under random interleavings", () => {
  it.effect(
    "serves what a fresh build serves, replay included, after every step",
    () => {
      const counter = makeBuildCounter();
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const liveness = yield* ThreadBackgroundLivenessService;
        // Never reused across runs, so no run can meet another run's version.
        let sequence = 0;
        let batch = 0;
        let task = 0;
        let identity = 0;
        let hits = 0;
        let subscriptions = 0;

        for (const seed of SEEDS) {
          const random = mulberry32(seed);
          const pick = <A>(values: ReadonlyArray<A>): A =>
            values[Math.floor(random() * values.length)]!;
          for (let run = 0; run < RUNS_PER_SEED; run += 1) {
            const at = `seed ${seed.toString(16)} run ${run}`;
            // A new projection, past any memo the previous run left.
            yield* sql`DELETE FROM thread_priority_rankings`;
            yield* sql`DELETE FROM thread_priority_batches`;
            yield* sql`DELETE FROM projection_threads`;
            yield* sql`DELETE FROM projection_projects`;
            for (const threadId of THREAD_IDS) liveness.clearThreadLiveness(threadId);
            yield* TestClock.adjust(SHELL_MEMO_MAX_AGE_MS + 1);
            sequence += 1;
            yield* seedProjection(sequence);
            const events: RenameEvent[] = [];
            const titles: Record<string, string> = Object.fromEntries(
              THREAD_IDS.map((threadId) => [threadId, threadId]),
            );
            const working = new Map<string, string>();

            for (let step = 0; step < STEPS_PER_RUN; step += 1) {
              const action = random();
              if (action < 0.25) {
                sequence += 1;
                const threadId = pick(THREAD_IDS);
                const title = `title ${sequence}`;
                yield* projectRename(sequence, threadId, title);
                events.push({ sequence, threadId, title });
                titles[threadId] = title;
              } else if (action < 0.37) {
                batch += 1;
                const ranked = THREAD_IDS.filter(() => random() < 0.5);
                yield* rankThreads(
                  random() < 0.2 ? null : `batch-${batch}`,
                  ranked,
                  eventTime(batch),
                );
              } else if (action < 0.49) {
                const threadId = pick(THREAD_IDS);
                const running = working.get(threadId);
                if (running === undefined) {
                  task += 1;
                  const taskId = `task-${task}`;
                  working.set(threadId, taskId);
                  yield* startBackgroundWork(threadId, taskId);
                } else {
                  working.delete(threadId);
                  yield* finishBackgroundWork(threadId, running);
                }
              } else if (action < 0.57) {
                identity += 1;
                yield* recordRepositoryIdentity(
                  `github.com/acme/repo-${identity}`,
                  eventTime(identity),
                );
              } else if (action < 0.7) {
                yield* TestClock.adjust(
                  random() < 0.1
                    ? SHELL_MEMO_IDLE_EVICTION_MS + 1
                    : Math.floor(random() * (SHELL_MEMO_MAX_AGE_MS + 500)),
                );
              } else {
                const form = pick<ShellForm>(["full", "stubbed"]);
                const buildsBefore = counter.builds();
                const served = yield* readShell(form);
                if (counter.builds() === buildsBefore) hits += 1;
                subscriptions += 1;
                const fresh = yield* buildShell(form);
                assert.deepStrictEqual(served, fresh, `${at} step ${step}: shell`);
                assert.deepStrictEqual(
                  replayTitles(served, events),
                  replayTitles(fresh, events),
                  `${at} step ${step}: replay`,
                );
                assert.deepStrictEqual(
                  replayTitles(served, events),
                  titles,
                  `${at} step ${step}: titles`,
                );
              }
            }
          }
        }
        // Both paths ran: the memo served some subscriptions and builds served others.
        assert.isAbove(hits, 0);
        assert.isBelow(hits, subscriptions);
      }).pipe(Effect.provide(queryLayer), Effect.withTracer(counter.tracer));
    },
    60_000,
  );
});
