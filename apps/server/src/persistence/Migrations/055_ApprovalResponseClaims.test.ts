import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { derivePendingApprovals } from "@ryco/client-runtime/state/session";
import { EventId } from "@ryco/contracts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
layer("055_ApprovalResponseClaims", (it) => {
  it.effect("expires legacy callbacks honestly and permits thread-scoped provider ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO projection_pending_approvals
      (request_id, thread_id, status, decision, created_at) VALUES
      ('legacy', 'thread-a', 'pending', NULL, '2026-09-01T00:00:00.000Z'),
      ('settled', 'thread-a', 'resolved', 'decline', '2026-09-01T00:00:00.000Z')`;
      yield* runMigrations({ toMigrationInclusive: 55 });
      const rows = yield* sql<{
        request_id: string;
        status: string;
        decision: string | null;
        response_state: string | null;
        resolved_at: string | null;
      }>`SELECT * FROM projection_pending_approvals ORDER BY request_id`;
      assert.equal(rows[0]?.status, "resolved");
      assert.equal(rows[0]?.decision, null);
      assert.equal(rows[0]?.response_state, "invalidated");
      assert.isNotNull(rows[0]?.resolved_at);
      assert.equal(rows[1]?.decision, "decline");
      const failures = yield* sql<{
        payload_json: string;
        created_at: string;
      }>`SELECT * FROM projection_thread_activities WHERE kind = 'provider.approval.respond.failed'`;
      assert.equal(failures.length, 1);
      assert.deepEqual(
        derivePendingApprovals([
          {
            id: EventId.make("legacy-open"),
            kind: "approval.requested",
            tone: "approval",
            summary: "Request",
            turnId: null,
            createdAt: "2026-09-01T00:00:00.000Z",
            payload: { requestId: "legacy", requestKind: "command" },
          },
          {
            id: EventId.make("legacy-expired"),
            kind: "provider.approval.respond.failed",
            tone: "error",
            summary: "Expired",
            turnId: null,
            createdAt: failures[0]!.created_at,
            payload: JSON.parse(failures[0]!.payload_json),
          },
        ]),
        [],
      );
      yield* sql`INSERT INTO projection_pending_approvals (thread_id, request_id, status, created_at) VALUES ('thread-b', 'legacy', 'pending', '2026-09-15T00:00:00.000Z')`;
      const count = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM projection_pending_approvals WHERE request_id = 'legacy'`;
      assert.equal(count[0]?.count, 2);
      yield* runMigrations({ toMigrationInclusive: 55 });
      const repeated = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM projection_thread_activities WHERE kind = 'provider.approval.respond.failed'`;
      assert.equal(repeated[0]?.count, 1);
    }),
  );
});
