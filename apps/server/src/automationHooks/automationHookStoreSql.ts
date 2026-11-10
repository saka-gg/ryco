/**
 * automationHookStoreSql - The hook store's queries and secret handling, loaded with the first
 * hook operation so they stay off boot (`Layers/AutomationHookStore.ts` holds the listeners and
 * the Hub sync state).
 *
 * @module automationHooks/automationHookStoreSql
 */
import { randomBytes } from "node:crypto";

import { NODE_AUTOMATION_HOOKS_MAX_HOOKS } from "@ryco/contracts/automation-hooks";
import {
  AgentControlAutomationId,
  AutomationHookRequestOutcome,
  type AgentControlAutomation,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import {
  AutomationHookStoreError,
  type AutomationHookRecord,
  type AutomationHookStoreShape,
} from "./Services/AutomationHookStore.ts";

/** A hook's public id: 16 random bytes, unpadded base64url (22 characters). */
export const newAutomationHookId = (): string => randomBytes(16).toString("base64url");

/** Secrets live in the server secret store under the hook's id (base64url: a safe file name). */
export const automationHookSecretName = (hookId: string): string => `automation-hooks/${hookId}`;

const SECRET_BYTES = 32;

const decodeOutcome = Schema.decodeUnknownOption(AutomationHookRequestOutcome);

interface HookRow {
  readonly automationId: string;
  readonly hookId: string;
  readonly createdAt: string;
  readonly secretUpdatedAt: string;
  readonly lastRequestAt: string | null;
  readonly lastRequestVia: string | null;
  readonly lastRequestOutcome: string | null;
}

const toRecord = (row: HookRow): AutomationHookRecord => {
  const outcome = Option.getOrNull(decodeOutcome(row.lastRequestOutcome));
  return {
    automationId: AgentControlAutomationId.make(row.automationId),
    hookId: row.hookId,
    createdAt: row.createdAt,
    secretUpdatedAt: row.secretUpdatedAt,
    lastRequest:
      row.lastRequestAt !== null &&
      outcome !== null &&
      (row.lastRequestVia === "cloud" || row.lastRequestVia === "direct")
        ? { at: row.lastRequestAt, via: row.lastRequestVia, outcome }
        : null,
  };
};

const fail = (operation: string) => (cause: unknown) =>
  new AutomationHookStoreError({ operation, cause });

export type AutomationHookStoreOps = Omit<
  AutomationHookStoreShape,
  "hubSyncState" | "setHubSyncState" | "onChange" | "notifyChanged"
>;

export function makeAutomationHookStoreOps(
  sql: SqlClient.SqlClient,
  secrets: ServerSecretStoreShape,
): AutomationHookStoreOps {
  const selectByAutomation = (automationId: string) =>
    sql<HookRow>`
      SELECT automation_id AS "automationId", hook_id AS "hookId", created_at AS "createdAt",
        secret_updated_at AS "secretUpdatedAt", last_request_at AS "lastRequestAt",
        last_request_via AS "lastRequestVia", last_request_outcome AS "lastRequestOutcome"
      FROM automation_hooks WHERE automation_id = ${automationId} LIMIT 1
    `.pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toRecord)));

  const get: AutomationHookStoreOps["get"] = (automationId) =>
    selectByAutomation(automationId).pipe(Effect.mapError(fail("get")));

  const findByHookId: AutomationHookStoreOps["findByHookId"] = (hookId) =>
    sql<HookRow>`
      SELECT automation_id AS "automationId", hook_id AS "hookId", created_at AS "createdAt",
        secret_updated_at AS "secretUpdatedAt", last_request_at AS "lastRequestAt",
        last_request_via AS "lastRequestVia", last_request_outcome AS "lastRequestOutcome"
      FROM automation_hooks WHERE hook_id = ${hookId} LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toRecord)),
      Effect.mapError(fail("findByHookId")),
    );

  const ensure = (automationId: string) =>
    Effect.gen(function* () {
      const existing = yield* selectByAutomation(automationId);
      const hook = Option.isSome(existing)
        ? existing.value
        : yield* Effect.gen(function* () {
            const now = new Date().toISOString();
            yield* sql`
              INSERT INTO automation_hooks (automation_id, hook_id, created_at, secret_updated_at)
              VALUES (${automationId}, ${newAutomationHookId()}, ${now}, ${now})
              ON CONFLICT (automation_id) DO NOTHING
            `;
            const inserted = yield* selectByAutomation(automationId);
            if (Option.isNone(inserted)) {
              return yield* Effect.fail(new Error("The hook row is missing after its insert."));
            }
            return inserted.value;
          });
      // Also after a crash between the row and its secret: the secret follows the row.
      yield* secrets.getOrCreateRandom(automationHookSecretName(hook.hookId), SECRET_BYTES);
      return hook;
    });

  const remove = (automationId: string) =>
    Effect.gen(function* () {
      const deleted = yield* sql<{ readonly hookId: string }>`
        DELETE FROM automation_hooks WHERE automation_id = ${automationId}
        RETURNING hook_id AS "hookId"
      `;
      for (const { hookId } of deleted) {
        yield* sql`DELETE FROM automation_hook_deliveries WHERE hook_id = ${hookId}`;
        yield* secrets.remove(automationHookSecretName(hookId));
      }
    });

  const reconcile: AutomationHookStoreOps["reconcile"] = (automation: AgentControlAutomation) =>
    (automation.definition.schedule.kind === "webhook" && !automation.cancelled
      ? ensure(automation.automationId).pipe(Effect.map(Option.some))
      : remove(automation.automationId).pipe(Effect.as(Option.none<AutomationHookRecord>()))
    ).pipe(Effect.mapError(fail("reconcile")));

  const secret: AutomationHookStoreOps["secret"] = (hook) =>
    secrets.get(automationHookSecretName(hook.hookId)).pipe(
      Effect.map((bytes) =>
        bytes === null || bytes.length !== SECRET_BYTES
          ? Option.none()
          : Option.some(Buffer.from(bytes).toString("base64url")),
      ),
      Effect.mapError(fail("secret")),
    );

  const regenerate: AutomationHookStoreOps["regenerate"] = (automationId) =>
    Effect.gen(function* () {
      const hook = yield* selectByAutomation(automationId);
      if (Option.isNone(hook)) return Option.none<AutomationHookRecord>();
      const fresh = randomBytes(SECRET_BYTES);
      try {
        yield* secrets.set(automationHookSecretName(hook.value.hookId), fresh);
      } finally {
        fresh.fill(0);
      }
      const now = new Date().toISOString();
      yield* sql`UPDATE automation_hooks SET secret_updated_at = ${now}
        WHERE automation_id = ${automationId}`;
      return yield* selectByAutomation(automationId);
    }).pipe(Effect.mapError(fail("regenerate")));

  const recordRequest: AutomationHookStoreOps["recordRequest"] = (input) =>
    sql`
      UPDATE automation_hooks SET last_request_at = ${input.at},
        last_request_via = ${input.via}, last_request_outcome = ${input.outcome}
      WHERE automation_id = ${input.automationId}
    `.pipe(Effect.asVoid, Effect.mapError(fail("recordRequest")));

  const seenDelivery: AutomationHookStoreOps["seenDelivery"] = (input) =>
    input.keys.length === 0
      ? Effect.succeed(false)
      : sql<{ readonly found: number }>`
          SELECT 1 AS found FROM automation_hook_deliveries
          WHERE hook_id = ${input.hookId} AND received_at >= ${input.since}
            AND ${sql.in("delivery_key", input.keys)}
          LIMIT 1
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(fail("seenDelivery")),
        );

  const rememberDelivery: AutomationHookStoreOps["rememberDelivery"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM automation_hook_deliveries WHERE received_at < ${input.pruneBefore}`;
          for (const [index, key] of input.keys.entries()) {
            // The first key (the delivery id) carries `started`, so the rate limit counts a
            // request once however many keys it has.
            const started = input.started && index === 0 ? 1 : 0;
            yield* sql`
              INSERT INTO automation_hook_deliveries (hook_id, delivery_key, received_at, started)
              VALUES (${input.hookId}, ${key}, ${input.at}, ${started})
              ON CONFLICT (hook_id, delivery_key) DO UPDATE SET
                received_at = excluded.received_at, started = MAX(started, excluded.started)
            `;
          }
        }),
      )
      .pipe(Effect.mapError(fail("rememberDelivery")));

  const forgetDelivery: AutomationHookStoreOps["forgetDelivery"] = (input) =>
    input.keys.length === 0
      ? Effect.void
      : sql`
          DELETE FROM automation_hook_deliveries
          WHERE hook_id = ${input.hookId} AND ${sql.in("delivery_key", input.keys)}
        `.pipe(Effect.asVoid, Effect.mapError(fail("forgetDelivery")));

  const startedSince: AutomationHookStoreOps["startedSince"] = (input) =>
    sql<{ readonly count: number; readonly oldest: string | null }>`
      SELECT COUNT(*) AS count, MIN(received_at) AS oldest FROM automation_hook_deliveries
      WHERE hook_id = ${input.hookId} AND started = 1 AND received_at >= ${input.since}
    `.pipe(
      Effect.map((rows) => ({ count: rows[0]?.count ?? 0, oldest: rows[0]?.oldest ?? null })),
      Effect.mapError(fail("startedSince")),
    );

  const enabledHookIds: AutomationHookStoreOps["enabledHookIds"] = sql<{
    readonly hookId: string;
  }>`
    SELECT h.hook_id AS "hookId" FROM automation_hooks AS h
    JOIN agent_control_automations AS a ON a.automation_id = h.automation_id
    WHERE a.enabled = 1 AND a.cancelled = 0
      AND json_extract(a.definition_json, '$.schedule.kind') = 'webhook'
      AND NOT EXISTS (SELECT 1 FROM agent_control_automation_quarantine q
        WHERE q.kind = 'automation' AND q.id = a.automation_id)
    ORDER BY h.created_at ASC, h.hook_id ASC
    LIMIT ${NODE_AUTOMATION_HOOKS_MAX_HOOKS}
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.hookId)),
    Effect.mapError(fail("enabledHookIds")),
  );

  const hubRegistered: AutomationHookStoreOps["hubRegistered"] = sql<{
    readonly registered: string;
  }>`SELECT registered_json AS "registered" FROM automation_hook_hub_state WHERE id = 1`.pipe(
    Effect.map((rows) => {
      try {
        const parsed: unknown = JSON.parse(rows[0]?.registered ?? "[]");
        return Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === "string")
          : [];
      } catch {
        return [];
      }
    }),
    Effect.mapError(fail("hubRegistered")),
  );

  const setHubRegistered: AutomationHookStoreOps["setHubRegistered"] = (hookIds) =>
    sql`
      INSERT INTO automation_hook_hub_state (id, registered_json) VALUES (1, ${JSON.stringify(hookIds)})
      ON CONFLICT (id) DO UPDATE SET registered_json = excluded.registered_json
    `.pipe(Effect.asVoid, Effect.mapError(fail("setHubRegistered")));

  return {
    reconcile,
    get,
    findByHookId,
    secret,
    regenerate,
    recordRequest,
    seenDelivery,
    rememberDelivery,
    forgetDelivery,
    startedSince,
    enabledHookIds,
    hubRegistered,
    setHubRegistered,
  };
}
