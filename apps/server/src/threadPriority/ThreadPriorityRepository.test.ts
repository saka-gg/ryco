import { ProviderInstanceId, ThreadId, ThreadPriorityBatchSnapshot } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ThreadPriorityRepository,
  ThreadPriorityRepositoryLive,
} from "./ThreadPriorityRepository.ts";

const layer = it.layer(
  ThreadPriorityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const decodeSnapshot = Schema.decodeSync(ThreadPriorityBatchSnapshot);

function makeSnapshot(batchId = "batch-1", usableUntil = "2026-08-26T12:00:00.000Z") {
  return decodeSnapshot({
    batchId,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    modelFingerprint: "model-fingerprint-1",
    promptVersion: "thread-priority-v1",
    freshness: {
      rankedAt: "2026-08-25T12:00:00.000Z",
      usableUntil,
      checkedAt: "2026-08-25T12:00:00.000Z",
    },
    entries: [
      {
        threadId: ThreadId.make("thread-priority-a"),
        tier: "now",
        confidence: "high",
        reason: "Needs immediate attention",
        inputFingerprint: "input-fingerprint-a",
      },
      {
        threadId: ThreadId.make("thread-priority-b"),
        tier: "later",
        confidence: "medium",
        reason: "Safe to defer",
        inputFingerprint: "input-fingerprint-b",
      },
    ],
  });
}

const insertThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR REPLACE INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        token_mode, manual_position, created_at, updated_at, pending_approval_count,
        pending_user_input_count, has_actionable_proposed_plan
      ) VALUES (
        ${threadId}, 'project-1', ${threadId},
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        'balanced', 0, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', 0, 0, 0
      )
    `;
  });

layer("ThreadPriorityRepository", (it) => {
  it.effect("round-trips complete snapshots and hydrates them from sqlite", () =>
    Effect.gen(function* () {
      yield* insertThread("thread-priority-a");
      yield* insertThread("thread-priority-b");
      const repository = yield* ThreadPriorityRepository;
      const snapshot = makeSnapshot();
      yield* repository.replace({ snapshot, inputFingerprint: "batch-input-1" });

      const hydrated = yield* repository.readLatest();
      assert.isTrue(Option.isSome(hydrated));
      if (Option.isSome(hydrated)) {
        assert.deepEqual(hydrated.value, { snapshot, inputFingerprint: "batch-input-1" });
      }
    }),
  );

  it.effect("replaces batches transactionally", () =>
    Effect.gen(function* () {
      yield* insertThread("thread-priority-a");
      yield* insertThread("thread-priority-b");
      const repository = yield* ThreadPriorityRepository;
      const original = makeSnapshot();
      yield* repository.replace({ snapshot: original, inputFingerprint: "batch-input-1" });

      const invalidReplacement = {
        ...makeSnapshot("batch-2"),
        entries: [original.entries[0]!, original.entries[0]!],
      };
      const result = yield* repository
        .replace({ snapshot: invalidReplacement, inputFingerprint: "batch-input-2" })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));

      const hydrated = yield* repository.readLatest();
      assert.isTrue(Option.isSome(hydrated));
      if (Option.isSome(hydrated)) assert.deepEqual(hydrated.value.snapshot, original);
    }),
  );

  it.effect("keeps inactive rows auditable but excludes them from usable rankings", () =>
    Effect.gen(function* () {
      yield* insertThread("thread-priority-a");
      yield* insertThread("thread-priority-b");
      const repository = yield* ThreadPriorityRepository;
      yield* repository.replace({ snapshot: makeSnapshot(), inputFingerprint: "batch-input-1" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_threads SET settled_override = 'settled',
          settled_at = '2026-08-25T13:00:00.000Z'
        WHERE thread_id = 'thread-priority-a'
      `;
      yield* sql`
        UPDATE projection_threads SET archived_at = '2026-08-25T13:00:00.000Z'
        WHERE thread_id = 'thread-priority-b'
      `;

      const auditable = yield* repository.readLatest();
      const usable = yield* repository.readUsable("2026-08-25T13:30:00.000Z");
      assert.equal(Option.getOrThrow(auditable).snapshot.entries.length, 2);
      assert.equal(Option.getOrThrow(usable).snapshot.entries.length, 0);
    }),
  );

  it.effect("retains expired rows for audit but never returns them as usable", () =>
    Effect.gen(function* () {
      yield* insertThread("thread-priority-a");
      yield* insertThread("thread-priority-b");
      const repository = yield* ThreadPriorityRepository;
      yield* repository.replace({
        snapshot: makeSnapshot("expired-batch", "2026-08-25T12:30:00.000Z"),
        inputFingerprint: "batch-input-expired",
      });
      assert.isTrue(Option.isSome(yield* repository.readLatest()));
      assert.isTrue(Option.isNone(yield* repository.readUsable("2026-08-25T12:30:00.000Z")));
    }),
  );

  it.effect("deletes cache rows with their owning thread", () =>
    Effect.gen(function* () {
      yield* insertThread("thread-priority-a");
      yield* insertThread("thread-priority-b");
      const repository = yield* ThreadPriorityRepository;
      yield* repository.replace({ snapshot: makeSnapshot(), inputFingerprint: "batch-input-1" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-priority-a'`;
      const rows = yield* repository.inspectRows();
      assert.deepEqual(
        rows.map((row) => row.threadId),
        [ThreadId.make("thread-priority-b")],
      );
    }),
  );
});
