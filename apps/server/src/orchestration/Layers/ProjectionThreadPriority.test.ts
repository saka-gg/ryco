import {
  ProviderInstanceId,
  ThreadId,
  ThreadPriorityBatchId,
  ThreadPriorityFingerprint,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("ProjectionThreadPriority", (it) => {
  it.effect("projects usable rankings into shell rows and keeps legacy rows optional", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, project_metadata_dir,
          default_model_selection_json, scripts_json, created_at, updated_at
        ) VALUES (
          'priority-shell-project', 'Priority Shell', '/tmp/priority-shell', '.ryco', NULL, '[]',
          '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z'
        )
      `;
      for (const threadId of ["priority-shell-ranked", "priority-shell-legacy"]) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            token_mode, manual_position, created_at, updated_at, pending_approval_count,
            pending_user_input_count, has_actionable_proposed_plan
          ) VALUES (
            ${threadId}, 'priority-shell-project', ${threadId},
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', 'balanced',
            0, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', 0, 0, 0
          )
        `;
      }
      yield* sql`
        INSERT INTO thread_priority_batches (
          slot, batch_id, input_fingerprint, model_selection_json, model_fingerprint,
          prompt_version, ranked_at, usable_until, checked_at
        ) VALUES (
          1, 'priority-shell-batch', 'batch-input',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'model-input', 'thread-priority-v1',
          '2026-08-25T12:00:00.000Z', '2099-08-26T12:00:00.000Z',
          '2026-08-25T12:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO thread_priority_rankings (
          thread_id, batch_id, tier, confidence, reason, input_fingerprint
        ) VALUES (
          'priority-shell-ranked', 'priority-shell-batch', 'now', 'high',
          'Ready for action', 'thread-input'
        )
      `;

      const query = yield* ProjectionSnapshotQuery;
      const shell = yield* query.getShellSnapshot();
      const ranked = shell.threads.find((thread) => thread.id === "priority-shell-ranked");
      const legacy = shell.threads.find((thread) => thread.id === "priority-shell-legacy");
      assert.deepEqual(ranked?.priority, {
        tier: "now",
        confidence: "high",
        reason: "Ready for action",
        inputFingerprint: ThreadPriorityFingerprint.make("thread-input"),
        batchId: ThreadPriorityBatchId.make("priority-shell-batch"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        rankedAt: "2026-08-25T12:00:00.000Z",
        usableUntil: "2099-08-26T12:00:00.000Z",
      });
      assert.isUndefined(legacy?.priority);
      assert.equal(ranked?.id, ThreadId.make("priority-shell-ranked"));
    }),
  );
});
