import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  FLAVOR_IMPORT_REWRITES,
  FLAVOR_IMPORT_TABLE_POLICY,
  scrubFlavorImportCopy,
} from "./flavorImportTablePolicy.ts";

const NOW = "2026-10-31T12:00:00.000Z";

const migratedTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  return new Set(rows.map((row) => row.name));
});

let filled = 0;

/** Inserts a row, filling every required column without a default that `values` leaves out. */
const insertRow = (table: string, values: Record<string, string | number | null>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{
      readonly name: string;
      readonly type: string;
      readonly required: number;
      readonly defaultValue: unknown;
      readonly pk: number;
    }>`SELECT name, type, "notnull" AS required, dflt_value AS defaultValue, pk FROM pragma_table_info(${table})`;
    const row: Record<string, string | number | null> = { ...values };
    for (const column of columns) {
      if (column.name in row || column.required === 0 || column.defaultValue !== null) continue;
      row[column.name] = /INT/i.test(column.type) ? 1 : `${table}-${column.name}-${(filled += 1)}`;
    }
    const names = Object.keys(row);
    yield* sql.unsafe(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      names.map((name) => row[name] ?? null),
    );
  });

const count = (table: string, where = "1 = 1") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ readonly count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

describe("FLAVOR_IMPORT_TABLE_POLICY", () => {
  it.effect("classifies every table of the fully migrated schema", () =>
    Effect.gen(function* () {
      const tables = yield* migratedTables;
      const unclassified = [...tables].filter(
        (table) => !Object.hasOwn(FLAVOR_IMPORT_TABLE_POLICY, table),
      );
      expect(
        unclassified,
        "classify it in FLAVOR_IMPORT_TABLE_POLICY (apps/server/src/flavorImport/flavorImportTablePolicy.ts): may Ryco Nightly keep, clear or rewrite Ryco's rows?",
      ).toEqual([]);
      const stale = Object.keys(FLAVOR_IMPORT_TABLE_POLICY).filter((table) => !tables.has(table));
      expect(stale, "remove tables the schema no longer has").toEqual([]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it("has statements for exactly the rewritten tables", () => {
    expect(Object.keys(FLAVOR_IMPORT_REWRITES).toSorted()).toEqual(
      Object.entries(FLAVOR_IMPORT_TABLE_POLICY)
        .filter(([, policy]) => policy === "rewrite")
        .map(([table]) => table)
        .toSorted(),
    );
  });

  it.effect("clears and rewrites what would act as Ryco's node, and keeps the person's work", () =>
    Effect.gen(function* () {
      yield* insertRow("projection_threads", {
        thread_id: "thread-1",
        project_id: "project-1",
        goal_json: JSON.stringify({ objective: "Ship it", status: "active" }),
        usage_limit_json: JSON.stringify({
          limitId: "usage-limit:thread-1:turn-1",
          autoResume: null,
        }),
      });
      yield* insertRow("projection_thread_messages", {
        message_id: "message-1",
        thread_id: "thread-1",
      });
      yield* insertRow("projection_thread_sessions", {
        thread_id: "thread-1",
        status: "running",
        provider_session_id: "provider-session",
        provider_thread_id: "provider-thread",
        runtime_session_id: "runtime-session",
        active_turn_id: "turn-1",
      });
      yield* insertRow("auth_sessions", { session_id: "session-1" });
      yield* insertRow("auth_pairing_links", { id: "link-1", credential: "pairing-credential" });
      yield* insertRow("provider_session_runtime", { thread_id: "thread-1" });
      yield* insertRow("restart_continuations", {
        thread_id: "thread-1",
        source_turn_id: "turn-1",
        kind: "in-flight",
        status: "pending",
      });
      yield* insertRow("storage_owned_entries", { id: "owned-1", path: "/somewhere/worktree" });
      yield* insertRow("projection_thread_pull_request_watches", { thread_id: "thread-1" });
      yield* insertRow("agent_control_external_integrations", {
        integration_id: "integration-1",
        client_kind: "codex",
        rate_limit_per_minute: 1,
        active_task_limit: 1,
        pairing_state: "paired",
      });
      yield* insertRow("agent_control_mcp_installations", {
        installation_id: "installation-1",
        integration_id: "integration-1",
        state: "connected",
      });
      yield* insertRow("agent_control_automations", {
        automation_id: "automation-1",
        definition_json: JSON.stringify({ title: "Nightly report", enabled: true }),
        revision: 3,
        enabled: 1,
        cancelled: 0,
        next_run_at: "2026-11-01T08:00:00.000Z",
      });
      yield* insertRow("agent_control_proposals", {
        proposal_id: "proposal-pending",
        status: "pending-user-approval",
      });
      yield* insertRow("agent_control_proposals", {
        proposal_id: "proposal-done",
        status: "completed",
      });
      yield* insertRow("agent_control_operations", {
        operation_id: "operation-1",
        status: "running",
      });
      yield* insertRow("agent_control_automation_runs", {
        run_id: "run-1",
        automation_revision: 3,
        status: "executing",
      });
      yield* insertRow("provider_context_handoffs", {
        handoff_id: "handoff-1",
        thread_id: "thread-1",
        status: "dispatching",
      });
      yield* insertRow("project_atlassian_links", {
        project_id: "project-1",
        jira_connection_id: "connection-1",
      });

      const report = yield* scrubFlavorImportCopy(NOW);
      expect(report.unknownCleared).toEqual([]);

      for (const table of [
        "auth_sessions",
        "auth_pairing_links",
        "provider_session_runtime",
        "restart_continuations",
        "storage_owned_entries",
        "projection_thread_pull_request_watches",
        "agent_control_external_integrations",
        "agent_control_mcp_installations",
      ]) {
        expect(yield* count(table), table).toBe(0);
      }
      // The person's work stays.
      expect(yield* count("projection_threads")).toBe(1);
      expect(yield* count("projection_thread_messages")).toBe(1);

      const sql = yield* SqlClient.SqlClient;
      const [automation] = yield* sql<{
        readonly enabled: number;
        readonly nextRunAt: string | null;
        readonly revision: number;
        readonly definition: string;
      }>`SELECT enabled, next_run_at AS "nextRunAt", revision, definition_json AS definition FROM agent_control_automations`;
      expect(automation).toMatchObject({ enabled: 0, nextRunAt: null, revision: 4 });
      expect(JSON.parse(automation!.definition)).toEqual({
        title: "Nightly report",
        enabled: false,
      });

      const [session] = yield* sql`SELECT status, provider_session_id AS "providerSessionId",
        provider_thread_id AS "providerThreadId", runtime_session_id AS "runtimeSessionId",
        active_turn_id AS "activeTurnId" FROM projection_thread_sessions`;
      // Startup releases a session that claims to run; nothing is left to resume or continue.
      expect(session).toEqual({
        status: "running",
        providerSessionId: null,
        providerThreadId: null,
        runtimeSessionId: null,
        activeTurnId: null,
      });

      expect(
        yield* sql`SELECT proposal_id AS id, status FROM agent_control_proposals ORDER BY proposal_id`,
      ).toEqual([
        { id: "proposal-done", status: "completed" },
        { id: "proposal-pending", status: "cancelled" },
      ]);
      expect(yield* count("agent_control_operations", "status = 'cancelled'")).toBe(1);
      expect(yield* count("agent_control_automation_runs", "status = 'cancelled'")).toBe(1);
      expect(yield* count("provider_context_handoffs", "status = 'failed'")).toBe(1);
      expect(yield* count("project_atlassian_links", "jira_connection_id IS NULL")).toBe(1);

      const [thread] = yield* sql<{ readonly goal: string; readonly limit: string }>`
        SELECT goal_json AS goal, usage_limit_json AS "limit" FROM projection_threads
      `;
      expect(JSON.parse(thread!.goal)).toMatchObject({ status: "paused" });
      expect(JSON.parse(thread!.limit)).toMatchObject({ autoResume: false });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("empties a table it does not know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE another_branch_table (secret TEXT)`;
      yield* sql`INSERT INTO another_branch_table (secret) VALUES ('token')`;
      const report = yield* scrubFlavorImportCopy(NOW);
      expect(report.unknownCleared).toEqual(["another_branch_table"]);
      expect(yield* count("another_branch_table")).toBe(0);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
