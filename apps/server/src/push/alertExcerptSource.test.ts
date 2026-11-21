import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@ryco/contracts";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readAlertExcerpt } from "./alertExcerptSource.ts";

const threadId = ThreadId.make("thread-excerpt");
const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, second)).toISOString();

const activity = (row: {
  readonly id: string;
  readonly kind: string;
  readonly sequence: number;
  readonly payload: unknown;
  readonly thread?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      ) VALUES (
        ${row.id}, ${row.thread ?? threadId}, ${"turn-1"}, ${"approval"}, ${row.kind}, ${"s"},
        ${JSON.stringify(row.payload)}, ${row.sequence}, ${at(row.sequence)}
      )
    `;
  });

const approval = (row: {
  readonly requestId: string;
  readonly status: "pending" | "resolved";
  readonly second: number;
  readonly thread?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_pending_approvals (thread_id, request_id, turn_id, status, created_at)
      VALUES (${row.thread ?? threadId}, ${row.requestId}, ${"turn-1"}, ${row.status}, ${at(row.second)})
      ON CONFLICT (thread_id, request_id) DO UPDATE SET status = excluded.status
    `;
  });

const question = (row: {
  readonly requestId: string;
  readonly pending: boolean;
  readonly nonBlocking?: boolean;
  readonly identity?: unknown;
  readonly second: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_user_input_requests (
        thread_id, request_id, is_pending, updated_at, identity_json, non_blocking
      ) VALUES (
        ${threadId}, ${row.requestId}, ${row.pending ? 1 : 0}, ${at(row.second)},
        ${row.identity === undefined ? null : JSON.stringify(row.identity)},
        ${row.nonBlocking === true ? 1 : 0}
      )
    `;
  });

describe("alert excerpt source", () => {
  it.effect("reads the approval the alert names, and only while it is open", () =>
    Effect.gen(function* () {
      yield* activity({
        id: "a1",
        kind: "approval.requested",
        sequence: 1,
        payload: { requestId: "approval-1", requestKind: "command", detail: "rm -rf build" },
      });
      yield* approval({ requestId: "approval-1", status: "pending", second: 1 });
      yield* activity({
        id: "a2",
        kind: "approval.requested",
        sequence: 2,
        payload: {
          requestId: "approval-2",
          requestKind: "file-change",
          requestType: "file_change_approval",
          detail: "src/main.ts",
          reason: "Applies the fix",
        },
      });
      yield* approval({ requestId: "approval-2", status: "pending", second: 2 });
      // Another thread's approval never leaks into this one.
      yield* activity({
        id: "other",
        kind: "approval.requested",
        sequence: 3,
        thread: "thread-other",
        payload: { requestId: "approval-9", requestKind: "command", detail: "secret" },
      });
      yield* approval({
        requestId: "approval-9",
        status: "pending",
        second: 3,
        thread: "thread-other",
      });

      expect(
        yield* readAlertExcerpt({ threadId, kind: "approval", approvalRequestId: "approval-1" }),
      ).toEqual({ a: { k: "command", d: "rm -rf build" } });
      // Without a named request: the newest open one.
      expect(
        yield* readAlertExcerpt({ threadId, kind: "approval", approvalRequestId: null }),
      ).toEqual({ a: { k: "file-change", d: "src/main.ts", r: "Applies the fix" } });
      // Answered: nothing to show.
      yield* approval({ requestId: "approval-1", status: "resolved", second: 4 });
      expect(
        yield* readAlertExcerpt({ threadId, kind: "approval", approvalRequestId: "approval-1" }),
      ).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("reads the newest blocking question with its draft key", () =>
    Effect.gen(function* () {
      yield* activity({
        id: "q1",
        kind: "user-input.requested",
        sequence: 1,
        payload: {
          requestId: "question-1",
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Where should it deploy?",
              options: [
                { label: "Staging", description: "Safe" },
                { label: "Production", description: "Live" },
              ],
            },
          ],
        },
      });
      yield* question({
        requestId: "question-1",
        pending: true,
        identity: { requestEventId: "q1", runtimeSessionId: "runtime-1" },
        second: 1,
      });
      // An optional question never alerts, so it is never the excerpt.
      yield* activity({
        id: "q2",
        kind: "user-input.requested",
        sequence: 2,
        payload: {
          requestId: "question-optional",
          nonBlocking: true,
          questions: [{ id: "x", header: "X", question: "Optional?", options: [] }],
        },
      });
      yield* question({
        requestId: "question-optional",
        pending: true,
        nonBlocking: true,
        second: 2,
      });

      expect(yield* readAlertExcerpt({ threadId, kind: "input", approvalRequestId: null })).toEqual(
        {
          u: {
            rq: "question-1",
            ev: "q1",
            qs: [
              {
                id: "target",
                h: "Target",
                q: "Where should it deploy?",
                o: ["Staging", "Production"],
              },
            ],
          },
        },
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("names a pending user action request by its fixed label only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at(30)));
      const requestId = (letter: string) => `user-action-${letter.repeat(32)}`;
      const requested = (row: {
        readonly id: string;
        readonly sequence: number;
        readonly letter: string;
        readonly surface: string;
        readonly need: string;
        readonly expiresAt?: string;
        readonly thread?: string;
      }) =>
        activity({
          id: row.id,
          kind: "user-action.requested",
          sequence: row.sequence,
          ...(row.thread === undefined ? {} : { thread: row.thread }),
          payload: {
            requestId: requestId(row.letter),
            surface: row.surface,
            need: row.need,
            message: "Sign in at https://example.test/login?token=SECRET",
            target: "tab-1",
            expiresAt: row.expiresAt ?? "2026-11-10T13:00:00.000Z",
          },
        });
      const resolved = (id: string, sequence: number, letter: string) =>
        activity({
          id,
          kind: "user-action.resolved",
          sequence,
          payload: { requestId: requestId(letter), outcome: "done" },
        });
      const read = readAlertExcerpt({ threadId, kind: "input", approvalRequestId: null });

      expect(yield* read).toBeNull();
      yield* requested({ id: "u1", sequence: 1, letter: "a", surface: "browser", need: "sign-in" });
      expect(yield* read).toEqual({ l: { t: "Login required in browser" } });
      // The newest unanswered one; an answered one never names the alert.
      yield* requested({
        id: "u2",
        sequence: 2,
        letter: "b",
        surface: "terminal",
        need: "verification",
      });
      expect(yield* read).toEqual({ l: { t: "Verification required in terminal" } });
      yield* resolved("u2-done", 3, "b");
      expect(yield* read).toEqual({ l: { t: "Login required in browser" } });
      // An expired one, and another thread's, are left out.
      yield* requested({
        id: "u3",
        sequence: 4,
        letter: "c",
        surface: "browser",
        need: "captcha",
        expiresAt: at(10),
      });
      yield* requested({
        id: "u4",
        sequence: 5,
        letter: "d",
        surface: "browser",
        need: "consent",
        thread: "thread-other",
      });
      expect(yield* read).toEqual({ l: { t: "Login required in browser" } });
      // Nothing of the agent's message reaches the alert.
      expect(JSON.stringify(yield* read)).not.toContain("example.test");
      yield* resolved("u1-done", 6, "a");
      expect(yield* read).toBeNull();
      // Never for an approval alert.
      yield* requested({ id: "u5", sequence: 7, letter: "e", surface: "browser", need: "sign-in" });
      expect(
        yield* readAlertExcerpt({ threadId, kind: "approval", approvalRequestId: null }),
      ).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("prefers an open question over a user action request", () =>
    Effect.gen(function* () {
      yield* activity({
        id: "u1",
        kind: "user-action.requested",
        sequence: 1,
        payload: {
          requestId: `user-action-${"a".repeat(32)}`,
          surface: "browser",
          need: "sign-in",
          message: "Sign in",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
      yield* activity({
        id: "q1",
        kind: "user-input.requested",
        sequence: 2,
        payload: {
          requestId: "question-1",
          questions: [
            {
              id: "x",
              header: "Pick",
              question: "Which one?",
              options: [{ label: "A", description: "First" }],
            },
          ],
        },
      });
      yield* question({ requestId: "question-1", pending: true, second: 2 });
      expect(
        yield* readAlertExcerpt({ threadId, kind: "input", approvalRequestId: null }),
      ).toMatchObject({ u: { rq: "question-1" } });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
