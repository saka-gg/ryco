import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@ryco/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { readAlertExcerpt } from "./alertExcerptSource.ts";

const threadId = ThreadId.make("thread-excerpt");

const insert = (row: {
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
        ${JSON.stringify(row.payload)}, ${row.sequence},
        ${new Date(Date.UTC(2026, 10, 10, 12, 0, row.sequence)).toISOString()}
      )
    `;
  });

const identity = (id: string) => ({ requestEventId: id, runtimeSessionId: "runtime-1" });

describe("alert excerpt source", () => {
  it.effect("reads the approval the alert names, and only while it is open", () =>
    Effect.gen(function* () {
      yield* insert({
        id: "a1",
        kind: "approval.requested",
        sequence: 1,
        payload: {
          requestId: "approval-1",
          requestKind: "command",
          detail: "rm -rf build",
          approvalIdentity: identity("a1"),
        },
      });
      yield* insert({
        id: "a2",
        kind: "approval.requested",
        sequence: 2,
        payload: {
          requestId: "approval-2",
          requestType: "file_change_approval",
          detail: "src/main.ts",
          reason: "Applies the fix",
          approvalIdentity: identity("a2"),
        },
      });
      // Another thread's approval never leaks into this one.
      yield* insert({
        id: "other",
        kind: "approval.requested",
        sequence: 3,
        thread: "thread-other",
        payload: { requestId: "approval-9", requestKind: "command", detail: "secret" },
      });
      expect(
        yield* readAlertExcerpt({ threadId, kind: "approval", approvalRequestId: "approval-1" }),
      ).toEqual({ a: { k: "command", d: "rm -rf build" } });
      // Without a named request: the newest open one.
      expect(
        yield* readAlertExcerpt({ threadId, kind: "approval", approvalRequestId: null }),
      ).toEqual({ a: { k: "file-change", d: "src/main.ts", r: "Applies the fix" } });
      yield* insert({
        id: "a1-resolved",
        kind: "approval.resolved",
        sequence: 4,
        payload: { requestId: "approval-1", runtimeSessionId: "runtime-1" },
      });
      expect(
        yield* readAlertExcerpt({ threadId, kind: "approval", approvalRequestId: "approval-1" }),
      ).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("reads the newest blocking question with its draft key", () =>
    Effect.gen(function* () {
      yield* insert({
        id: "q1",
        kind: "user-input.requested",
        sequence: 1,
        payload: {
          requestId: "question-1",
          userInputIdentity: identity("q1"),
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
      yield* insert({
        id: "q2",
        kind: "user-input.requested",
        sequence: 2,
        payload: {
          requestId: "question-optional",
          nonBlocking: true,
          questions: [{ id: "x", header: "X", question: "Optional?", options: [] }],
        },
      });
      expect(
        yield* readAlertExcerpt({ threadId, kind: "input", approvalRequestId: null }),
      ).toEqual({
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
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
