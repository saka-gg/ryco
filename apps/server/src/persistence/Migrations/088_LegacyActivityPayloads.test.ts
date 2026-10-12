import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ACTIVITY_DATA_STRING_CAP } from "../../orchestration/activityDataCap.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY,
  reprojectLegacyActivityPayloads,
} from "./088_LegacyActivityPayloads.ts";

const LEGACY_OUTPUT = `${"start ".repeat(20)}${"x".repeat(1_000_000)}${" end".repeat(20)}`;

const insertActivity = (input: {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly sequence: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (
        ${input.id}, 'thread-legacy', NULL, 'tool', ${input.kind}, 'Ran command',
        ${JSON.stringify(input.payload)}, ${input.sequence}, '2026-08-01T00:00:00.000Z'
      )
    `;
  });

const readPayload = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payloadJson: string }>`
      SELECT payload_json AS "payloadJson" FROM projection_thread_activities
      WHERE activity_id = ${id}
    `;
    return rows[0]!.payloadJson;
  });

it.layer(NodeSqliteClient.layerMemory())("088 legacy activity payloads", (it) => {
  it.effect("re-projects oversized pre-#481 tool rows and leaves everything else alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 86 });

      const commandPayload = (kind: string) => ({
        itemType: "command_execution",
        status: kind === "tool.updated" ? "inProgress" : "completed",
        providerItemId: "item-1",
        data: {
          item: {
            command: "cat huge.log",
            exitCode: 0,
            aggregatedOutput: LEGACY_OUTPUT,
          },
        },
      });
      yield* insertActivity({
        id: "legacy-completed",
        kind: "tool.completed",
        payload: commandPayload("tool.completed"),
        sequence: 1,
      });
      yield* insertActivity({
        id: "legacy-updated",
        kind: "tool.updated",
        payload: commandPayload("tool.updated"),
        sequence: 2,
      });
      // A large diff is exempt from the cap: a cut hunk would render as a broken diff.
      const diffPayload = {
        itemType: "file_change",
        data: { item: { changes: [{ path: "a.ts", diff: "+".repeat(50_000) }] } },
      };
      yield* insertActivity({
        id: "legacy-diff",
        kind: "tool.completed",
        payload: diffPayload,
        sequence: 3,
      });
      const smallPayload = { itemType: "command_execution", data: { item: { command: "ls" } } };
      yield* insertActivity({
        id: "small",
        kind: "tool.updated",
        payload: smallPayload,
        sequence: 4,
      });
      const approvalPayload = { requestId: "r1", detail: "d".repeat(40_000) };
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'approval', 'thread-legacy', NULL, 'approval', 'approval.requested', 'Approve',
          ${JSON.stringify(approvalPayload)}, 5, '2026-08-01T00:00:00.000Z'
        )
      `;
      const untouched = {
        diff: yield* readPayload("legacy-diff"),
        small: yield* readPayload("small"),
        approval: yield* readPayload("approval"),
      };

      yield* runMigrations({ toMigrationInclusive: 88 });

      const completed = JSON.parse(yield* readPayload("legacy-completed"));
      assert.equal(completed.itemType, "command_execution");
      assert.equal(completed.providerItemId, "item-1");
      assert.equal(completed.data.item.command, "cat huge.log");
      assert.equal(completed.data.item.exitCode, 0);
      const output: string = completed.data.item.aggregatedOutput;
      assert.isBelow(output.length, ACTIVITY_DATA_STRING_CAP + 100);
      assert.isTrue(output.startsWith("start start"));
      assert.isTrue(output.endsWith(" end end"));
      assert.include(output, "chars truncated");

      // tool.updated rows are projected like ingestion projects them since #481.
      const updated = JSON.parse(yield* readPayload("legacy-updated"));
      assert.equal(updated.status, "inProgress");
      assert.equal(updated.data.item.command, "cat huge.log");
      assert.isBelow(updated.data.item.aggregatedOutput.length, 100);

      assert.equal(yield* readPayload("legacy-diff"), untouched.diff);
      assert.equal(yield* readPayload("small"), untouched.small);
      assert.equal(yield* readPayload("approval"), untouched.approval);

      const marker = yield* sql`
        SELECT repair_key FROM ryco_compatibility_repairs
        WHERE repair_key = ${LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY}
      `;
      assert.equal(marker.length, 1);
    }),
  );

  it.effect("runs once: the repair pass after a recorded 088 finds nothing to do", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // A row written after the migration (as an older binary might) is not revisited.
      yield* insertActivity({
        id: "after-migration",
        kind: "tool.completed",
        payload: { itemType: "command_execution", data: { output: "z".repeat(40_000) } },
        sequence: 10,
      });
      assert.equal(yield* reprojectLegacyActivityPayloads, 0);
      yield* runMigrations();
      assert.equal(JSON.parse(yield* readPayload("after-migration")).data.output.length, 40_000);

      // Without the marker (another branch recorded 088 first) the repair re-projects it.
      yield* sql`DELETE FROM ryco_compatibility_repairs WHERE repair_key = ${LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY}`;
      yield* runMigrations();
      assert.isBelow(
        JSON.parse(yield* readPayload("after-migration")).data.output.length,
        ACTIVITY_DATA_STRING_CAP + 100,
      );
    }),
  );
});
