import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_AgentControl", (it) => {
  it.effect("creates the proposal, operation, and audit tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'agent_control_proposals',
            'agent_control_operations',
            'agent_control_audit'
          )
      `;

      assert.deepStrictEqual(tables.map((table) => table.name).toSorted(), [
        "agent_control_audit",
        "agent_control_operations",
        "agent_control_proposals",
      ]);
    }),
  );

  it.effect("creates the idempotency, queue, and recovery indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });

      const indices = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_agent_control_proposals_scope_request',
            'idx_agent_control_proposals_status_expires',
            'idx_agent_control_operations_proposal',
            'idx_agent_control_operations_recovery',
            'idx_agent_control_audit_proposal'
          )
      `;

      assert.deepStrictEqual(indices.map((index) => index.name).toSorted(), [
        "idx_agent_control_audit_proposal",
        "idx_agent_control_operations_proposal",
        "idx_agent_control_operations_recovery",
        "idx_agent_control_proposals_scope_request",
        "idx_agent_control_proposals_status_expires",
      ]);
    }),
  );

  it.effect("enforces request-id idempotency and one operation per proposal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });

      yield* sql`
        INSERT INTO agent_control_proposals (
          proposal_id, request_id, principal_scope, principal_json, action_kind,
          plan_version, plan_json, plan_digest, risk_tags_json, prompt_summary,
          status, created_at, updated_at, expires_at, decided_at, result_json
        ) VALUES (
          'proposal-1', 'request-1', 'provider-session:thread-1', '{}', 'createThreads',
          1, '{}', 'digest', '[]', NULL,
          'pending-user-approval', 't0', 't0', 't1', NULL, NULL
        )
      `;
      const duplicateRequest = yield* Effect.exit(sql`
        INSERT INTO agent_control_proposals (
          proposal_id, request_id, principal_scope, principal_json, action_kind,
          plan_version, plan_json, plan_digest, risk_tags_json, prompt_summary,
          status, created_at, updated_at, expires_at, decided_at, result_json
        ) VALUES (
          'proposal-2', 'request-1', 'provider-session:thread-1', '{}', 'createThreads',
          1, '{}', 'digest', '[]', NULL,
          'pending-user-approval', 't0', 't0', 't1', NULL, NULL
        )
      `);
      assert.strictEqual(duplicateRequest._tag, "Failure");

      yield* sql`
        INSERT INTO agent_control_operations (
          operation_id, proposal_id, action_kind, status, attempt,
          state_json, result_json, created_at, updated_at
        ) VALUES ('operation-1', 'proposal-1', 'createThreads', 'pending', 0, '{}', NULL, 't0', 't0')
      `;
      const duplicateOperation = yield* Effect.exit(sql`
        INSERT INTO agent_control_operations (
          operation_id, proposal_id, action_kind, status, attempt,
          state_json, result_json, created_at, updated_at
        ) VALUES ('operation-2', 'proposal-1', 'createThreads', 'pending', 0, '{}', NULL, 't0', 't0')
      `);
      assert.strictEqual(duplicateOperation._tag, "Failure");
    }),
  );

  it.effect("is idempotent when the full migration set is requested again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'agent_control_proposals'
      `;

      assert.strictEqual(tables.length, 1);
    }),
  );
});
