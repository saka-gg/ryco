import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";

import {
  type AuthRecordRetentionOptions,
  DEFAULT_AUTH_RECORD_RETENTION_OPTIONS,
  runAuthRecordRetentionPass,
} from "./AuthRecordRetention.ts";
import {
  DEFAULT_DATABASE_MAINTENANCE_OPTIONS,
  type EventCompactionSetting,
  loadedAuthRecordRetentionPass,
  makeAuthRecordRetention,
} from "./DatabaseMaintenance.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW_MS = Date.parse("2026-11-17T12:00:00.000Z");
/** An ISO time `days` before NOW (after it when negative). */
const daysAgo = (days: number) => new Date(NOW_MS - days * DAY).toISOString();

const insertSession = (row: {
  readonly id: string;
  readonly chainId?: string | null;
  readonly rotatedFrom?: string;
  readonly expiresDaysAgo: number;
  readonly revokedDaysAgo?: number;
  readonly supersededDaysAgo?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const chainId = row.chainId === undefined ? row.id : row.chainId;
    yield* sql`
      INSERT INTO auth_sessions (
        session_id, subject, role, method, issued_at, expires_at, revoked_at,
        rotated_from, chain_id, chain_issued_at, superseded_at, client_ip_address
      ) VALUES (
        ${row.id}, 'phone', 'client', 'bearer-session-token',
        ${daysAgo(row.expiresDaysAgo + 30)}, ${daysAgo(row.expiresDaysAgo)},
        ${row.revokedDaysAgo === undefined ? null : daysAgo(row.revokedDaysAgo)},
        ${row.rotatedFrom ?? null}, ${chainId},
        ${chainId === null ? null : daysAgo(row.expiresDaysAgo + 30)},
        ${row.supersededDaysAgo === undefined ? null : daysAgo(row.supersededDaysAgo)},
        '192.0.2.1'
      )
    `;
  });

const insertLink = (row: {
  readonly id: string;
  readonly expiresDaysAgo: number;
  readonly consumedDaysAgo?: number;
  readonly revokedDaysAgo?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_pairing_links (
        id, credential, method, role, subject, created_at, expires_at, consumed_at, revoked_at
      ) VALUES (
        ${row.id}, ${`credential-${row.id}`}, 'one-time-token', 'client', 'phone',
        ${daysAgo(row.expiresDaysAgo + 1)}, ${daysAgo(row.expiresDaysAgo)},
        ${row.consumedDaysAgo === undefined ? null : daysAgo(row.consumedDaysAgo)},
        ${row.revokedDaysAgo === undefined ? null : daysAgo(row.revokedDaysAgo)}
      )
    `;
  });

const sessionIds = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ readonly id: string }>`SELECT session_id AS id FROM auth_sessions ORDER BY session_id`,
).pipe(Effect.map((rows) => rows.map((row) => row.id)));

const linkIds = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly id: string }>`SELECT id FROM auth_pairing_links ORDER BY id`,
).pipe(Effect.map((rows) => rows.map((row) => row.id)));

/** A fresh in-memory database per test. */
const database = () => SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer), Layer.fresh);

const options: AuthRecordRetentionOptions = {
  ...DEFAULT_AUTH_RECORD_RETENTION_OPTIONS,
  batchPauseMs: 0,
};

describe("AuthRecordRetention", () => {
  it.live("removes pairing links consumed, revoked or expired more than 30 days ago", () =>
    Effect.gen(function* () {
      yield* insertLink({ id: "consumed-old", expiresDaysAgo: 25, consumedDaysAgo: 31 });
      yield* insertLink({ id: "consumed-recent", expiresDaysAgo: 5, consumedDaysAgo: 10 });
      yield* insertLink({ id: "revoked-old", expiresDaysAgo: -5, revokedDaysAgo: 40 });
      yield* insertLink({ id: "revoked-recent", expiresDaysAgo: -5, revokedDaysAgo: 2 });
      yield* insertLink({ id: "expired-old", expiresDaysAgo: 31 });
      yield* insertLink({ id: "expired-recent", expiresDaysAgo: 29 });
      yield* insertLink({ id: "active", expiresDaysAgo: -1 });

      const result = yield* runAuthRecordRetentionPass(options, NOW_MS);

      assert.deepEqual(result, { deletedPairingLinks: 3, deletedSessions: 0, backlog: false });
      assert.deepEqual(yield* linkIds, [
        "active",
        "consumed-recent",
        "expired-recent",
        "revoked-recent",
      ]);
    }).pipe(Effect.provide(database())),
  );

  it.live(
    "removes ended pairings' sessions 90 days after they ended, and a live pairing's old rows",
    () =>
      Effect.gen(function* () {
        yield* insertSession({ id: "revoked-old", expiresDaysAgo: -20, revokedDaysAgo: 100 });
        yield* insertSession({ id: "revoked-recent", expiresDaysAgo: -20, revokedDaysAgo: 10 });
        yield* insertSession({ id: "expired-old", expiresDaysAgo: 91 });
        yield* insertSession({ id: "expired-recent", expiresDaysAgo: 89 });
        // A pairing renewed for months: a superseded row that expired long ago goes (its bearer is
        // refused as expired before reuse is checked), but the head's predecessor stays.
        yield* insertSession({ id: "live-1", expiresDaysAgo: 120, supersededDaysAgo: 150 });
        yield* insertSession({
          id: "live-2",
          chainId: "live-1",
          rotatedFrom: "live-1",
          expiresDaysAgo: 95,
          supersededDaysAgo: 120,
        });
        yield* insertSession({
          id: "live-3",
          chainId: "live-1",
          rotatedFrom: "live-2",
          expiresDaysAgo: -20,
        });
        // A session from before rotation has no chain id; its successor names it as the chain,
        // and as the head's predecessor it stays.
        yield* insertSession({
          id: "legacy",
          chainId: null,
          expiresDaysAgo: 100,
          supersededDaysAgo: 110,
        });
        yield* insertSession({
          id: "legacy-next",
          chainId: "legacy",
          rotatedFrom: "legacy",
          expiresDaysAgo: -10,
        });
        // A pairing whose sessions all expired goes row by row.
        yield* insertSession({ id: "ended-1", expiresDaysAgo: 120, supersededDaysAgo: 121 });
        yield* insertSession({
          id: "ended-2",
          chainId: "ended-1",
          rotatedFrom: "ended-1",
          expiresDaysAgo: 60,
        });

        const result = yield* runAuthRecordRetentionPass(options, NOW_MS);

        assert.deepEqual(result, { deletedPairingLinks: 0, deletedSessions: 4, backlog: false });
        assert.deepEqual(yield* sessionIds, [
          "ended-2",
          "expired-recent",
          "legacy",
          "legacy-next",
          "live-2",
          "live-3",
          "revoked-recent",
        ]);
      }).pipe(Effect.provide(database())),
  );

  it.live(
    "shrinks a live pairing to its head, the rows it reads and the bearers reuse can catch",
    () =>
      Effect.gen(function* () {
        // A phone renewing every day for 200 days: row `n` was issued `200 - n` days ago and
        // expired 30 days later; each was superseded the day after it was issued.
        for (let n = 0; n <= 200; n += 1) {
          const age = 200 - n;
          yield* insertSession({
            id: `day-${String(n).padStart(3, "0")}`,
            chainId: "day-000",
            ...(n === 0 ? {} : { rotatedFrom: `day-${String(n - 1).padStart(3, "0")}` }),
            expiresDaysAgo: age - 30,
            ...(n === 200 ? {} : { supersededDaysAgo: age - 1 }),
          });
        }
        // The head renewed once more and its successor is not used yet: the head stays its
        // predecessor, and the successor does not count as superseded.
        yield* insertSession({
          id: "day-201",
          chainId: "day-000",
          rotatedFrom: "day-200",
          expiresDaysAgo: -30,
        });
        // A row expired long ago but never superseded (a successor nobody used) is not part of
        // the renewal trail this pass prunes.
        yield* insertSession({
          id: "unused",
          chainId: "day-000",
          rotatedFrom: "day-010",
          expiresDaysAgo: 150,
        });

        const result = yield* runAuthRecordRetentionPass(options, NOW_MS);

        // Rows 0 to 79 expired more than 90 days ago (row 80 exactly at the cutoff stays).
        assert.deepEqual(result, { deletedPairingLinks: 0, deletedSessions: 80, backlog: false });
        const kept = yield* sessionIds;
        assert.strictEqual(kept.length, 202 - 80 + 1);
        assert.strictEqual(kept[0], "day-080");
        assert.includeMembers(kept, ["day-199", "day-200", "day-201", "unused"]);
        // A second pass finds nothing more.
        assert.deepEqual(yield* runAuthRecordRetentionPass(options, NOW_MS), {
          deletedPairingLinks: 0,
          deletedSessions: 0,
          backlog: false,
        });
      }).pipe(Effect.provide(database())),
  );

  it.live("keeps a live pairing's old row that an unexpired row names as its predecessor", () =>
    Effect.gen(function* () {
      // Data no renewal writes today, guarded anyway: a head whose predecessor expired long ago.
      yield* insertSession({ id: "old", expiresDaysAgo: 200, supersededDaysAgo: 210 });
      yield* insertSession({
        id: "head",
        chainId: "old",
        rotatedFrom: "old",
        expiresDaysAgo: -10,
      });

      const result = yield* runAuthRecordRetentionPass(options, NOW_MS);

      assert.deepEqual(result, { deletedPairingLinks: 0, deletedSessions: 0, backlog: false });
      assert.deepEqual(yield* sessionIds, ["head", "old"]);
    }).pipe(Effect.provide(database())),
  );

  it.live("stops at the pass bound and reports the rest as backlog", () =>
    Effect.gen(function* () {
      for (const id of ["a", "b", "c", "d"]) {
        yield* insertLink({ id, expiresDaysAgo: 40 });
      }
      yield* insertSession({ id: "old", expiresDaysAgo: 200 });
      const bounded = { ...options, deleteBatch: 2, maxRowsPerPass: 3 };

      assert.deepEqual(yield* runAuthRecordRetentionPass(bounded, NOW_MS), {
        deletedPairingLinks: 3,
        deletedSessions: 0,
        backlog: true,
      });
      assert.deepEqual(yield* runAuthRecordRetentionPass(bounded, NOW_MS), {
        deletedPairingLinks: 1,
        deletedSessions: 1,
        backlog: false,
      });
      assert.deepEqual(yield* linkIds, []);
      assert.deepEqual(yield* sessionIds, []);
    }).pipe(Effect.provide(database())),
  );

  /**
   * Runs the schedule for `forMs` of virtual time against a pass that reports `outcomes` in turn
   * (the last one repeats; `"fail"` fails the pass), and returns the virtual times of passes.
   */
  const runSchedule = (input: {
    readonly setting: EventCompactionSetting;
    readonly outcomes: ReadonlyArray<"backlog" | "done" | "fail">;
    readonly forMs: number;
  }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const calls: Array<number> = [];
      const runPass = Effect.gen(function* () {
        calls.push((yield* Clock.currentTimeMillis) - NOW_MS);
        const outcome = input.outcomes[Math.min(calls.length, input.outcomes.length) - 1]!;
        if (outcome === "fail") {
          return yield* new SqlError({
            reason: new ConnectionError({
              cause: new Error("database is locked"),
              message: "boom",
            }),
          });
        }
        return { deletedPairingLinks: 1, deletedSessions: 0, backlog: outcome === "backlog" };
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* makeAuthRecordRetention({
            ...DEFAULT_DATABASE_MAINTENANCE_OPTIONS,
            setting: input.setting,
            runPass,
          });
          yield* Effect.yieldNow;
          for (let elapsed = 0; elapsed < input.forMs; elapsed += MINUTE) {
            yield* TestClock.adjust(MINUTE);
            yield* Effect.yieldNow;
          }
        }),
      );
      return calls;
    }).pipe(Effect.provide(database()));

  it.effect(
    "runs 10 minutes after startup, every 2 minutes with a backlog, else every 6 hours",
    () =>
      Effect.gen(function* () {
        const calls = yield* runSchedule({
          setting: "on",
          outcomes: ["backlog", "done", "fail", "done"],
          forMs: 19 * 60 * MINUTE,
        });
        assert.deepEqual(calls, [
          10 * MINUTE,
          12 * MINUTE,
          12 * MINUTE + 6 * 60 * MINUTE,
          12 * MINUTE + 12 * 60 * MINUTE,
          12 * MINUTE + 18 * 60 * MINUTE,
        ]);
      }),
  );

  it.effect("never runs when compaction is off or a dry run", () =>
    Effect.gen(function* () {
      for (const setting of ["off", "dry-run"] as const) {
        const calls = yield* runSchedule({ setting, outcomes: ["done"], forMs: 7 * 60 * MINUTE });
        assert.deepEqual(calls, []);
      }
    }),
  );

  it.effect("loads the pass on first use and prunes the database", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      yield* insertLink({ id: "expired-old", expiresDaysAgo: 40 });
      yield* insertLink({ id: "active", expiresDaysAgo: -1 });
      const result = yield* loadedAuthRecordRetentionPass;
      assert.deepEqual(result, { deletedPairingLinks: 1, deletedSessions: 0, backlog: false });
      assert.deepEqual(yield* linkIds, ["active"]);
    }).pipe(Effect.provide(database())),
  );
});
