import { messageTextColumns, decodeMessageText } from "../messageText.ts";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadMessageRepositoryLive } from "../Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";

it.effect(
  "upgrades saved streaming/completed bodies without changing text or cursors and resumes losslessly",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* ProjectionThreadMessageRepository;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 59 });
      for (const id of ["legacy-stream", "legacy-complete"]) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${id}, 'legacy-thread', NULL, 'assistant', ${"legacy\0漢字🚀"}, ${id === "legacy-stream" ? 1 : 0}, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`;
      }
      yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES ('projection.thread-messages', 42, '2026-09-01T00:00:00.000Z')`;
      yield* runMigrations();
      yield* runMigrations();
      assert.equal(
        (yield* sql<{
          sequence: number;
        }>`SELECT last_applied_sequence AS sequence FROM projection_state WHERE projector = 'projection.thread-messages'`)[0]
          ?.sequence,
        42,
      );
      for (const id of ["legacy-stream", "legacy-complete"]) {
        const row = Option.getOrThrow(
          yield* repo.getByMessageId({ messageId: MessageId.make(id) }),
        );
        assert.equal(row.text, "legacy\0漢字🚀");
        const bounded = yield* sql<{
          text: string;
          assembledText: string | null;
        }>`SELECT ${messageTextColumns(sql, "m", 64001)} FROM projection_thread_messages m WHERE message_id = ${id}`;
        assert.equal(
          bounded[0]!.assembledText === null
            ? bounded[0]!.text
            : decodeMessageText(bounded[0]!.assembledText),
          row.text,
        );
        yield* repo.applyEvent({ ...row, text: "\0 continued", isStreaming: true }, 43);
        assert.equal(
          Option.getOrThrow(yield* repo.getByMessageId(row)).text,
          "legacy\0漢字🚀\0 continued",
        );
        yield* repo.applyEvent({ ...row, text: "", isStreaming: false }, 44);
        assert.equal(
          Option.getOrThrow(yield* repo.getByMessageId(row)).text,
          "legacy\0漢字🚀\0 continued",
        );
      }
      yield* repo.deleteByThreadId({ threadId: ThreadId.make("legacy-thread") });
      assert.equal(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM projection_message_chunks`)[0]
          ?.count,
        0,
      );
    }).pipe(
      Effect.provide(
        ProjectionThreadMessageRepositoryLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    ),
);
