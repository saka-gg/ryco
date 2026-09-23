import { messageTextForSearch } from "../messageText.ts";
import { MessageId, ThreadId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer, Option } from "effect";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("persists the steer dispatch marker across upserts", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-steer-marker");
      const messageId = MessageId.make("message-steer-marker");
      const createdAt = "2026-08-17T10:00:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "Steered message",
        dispatchMode: "steer",
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "Steered message",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-08-17T10:00:01.000Z",
      });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") assert.equal(row.value.dispatchMode, "steer");
    }),
  );
});

layer("durable message chunks", (it) => {
  const makeRow = (id: string, text: string, isStreaming = true) => ({
    messageId: MessageId.make(id),
    threadId: ThreadId.make(id),
    turnId: null,
    role: "assistant" as const,
    text,
    isStreaming,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

  it.effect(
    "appends exactly once in sequence, joins split Unicode/NUL, and settles empty/replacement finals",
    () =>
      Effect.gen(function* () {
        const repo = yield* ProjectionThreadMessageRepository;
        const sql = yield* SqlClient.SqlClient;
        const id = "chunk-semantics";
        const get = () =>
          repo
            .getByMessageId({ messageId: MessageId.make(id) })
            .pipe(Effect.map(Option.getOrThrow));
        const parts = ["hello\0", "\ud83d", "\ude80 café e\u0301", "\ud800"];
        for (const [index, part] of parts.entries()) {
          const row = makeRow(id, part);
          yield* repo.applyEvent(row, index + 1);
          yield* repo.applyEvent(row, index + 1);
          assert.equal((yield* get()).text, parts.slice(0, index + 1).join(""));
        }
        assert.equal(
          (yield* sql<{
            text: string;
          }>`SELECT text FROM projection_thread_messages WHERE message_id = ${id}`)[0]?.text,
          "",
        );
        yield* repo.applyEvent(makeRow(id, "", false), 5);
        assert.equal((yield* get()).text, parts.join(""));
        assert.isFalse((yield* get()).isStreaming);
        yield* repo.applyEvent(makeRow(id, "stale"), 4);
        assert.equal((yield* get()).text, parts.join(""));
        assert.equal(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM projection_message_chunks WHERE message_id = ${id}`)[0]
            ?.count,
          0,
        );
        yield* repo.applyEvent(makeRow(id, " resumed"), 6);
        assert.equal((yield* get()).text, parts.join("") + " resumed");
        yield* repo.applyEvent(makeRow(id, "replacement\0\ud800", false), 7);
        yield* repo.applyEvent(makeRow(id, "late"), 6);
        assert.equal((yield* get()).text, "replacement\0\ud800");
        yield* repo.applyEvent(makeRow(id, " after replacement"), 8);
        assert.equal((yield* get()).text, "replacement\0\ud800 after replacement");
        yield* repo.applyEvent(makeRow("empty-final", "", false), 9);
        assert.equal(
          Option.getOrThrow(
            yield* repo.getByMessageId({ messageId: MessageId.make("empty-final") }),
          ).text,
          "",
        );
      }),
  );

  it.effect(
    "SQL search assembles split Unicode and escaped JSON without introducing separators",
    () =>
      Effect.gen(function* () {
        const repo = yield* ProjectionThreadMessageRepository;
        const sql = yield* SqlClient.SqlClient;
        const first = makeRow("chunk-search", '"quoted" \\ café \ud83d');
        yield* repo.applyEvent(first, 1);
        yield* repo.applyEvent({ ...first, text: "\ude80" }, 2);
        const rows = yield* sql<{
          text: string;
        }>`SELECT json_quote(${messageTextForSearch(sql, "m")}) AS text FROM projection_thread_messages m WHERE message_id = ${first.messageId}`;
        assert.equal(JSON.parse(rows[0]!.text), first.text + "\ude80");
      }),
  );

  it.effect("rolls back chunks, metadata and the caller's event transaction together", () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const row = makeRow("chunk-rollback", "durable");
      yield* repo.applyEvent(row, 1);
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* repo.applyEvent({ ...row, text: " must roll back", attachments: [] }, 2);
            return yield* Effect.fail("injected failure");
          }),
        )
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(Option.getOrThrow(yield* repo.getByMessageId(row)).text, "durable");
      yield* repo.applyEvent({ ...row, text: " retried" }, 2);
      assert.equal(Option.getOrThrow(yield* repo.getByMessageId(row)).text, "durable retried");
    }),
  );

  it.effect("preserves metadata and creation order; replacement/fork/delete own their chunks", () =>
    Effect.gen(function* () {
      const repo = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const row = {
        ...makeRow("chunk-metadata", "prefix"),
        role: "user" as const,
        dispatchMode: "steer" as const,
        attachments: [
          {
            type: "image" as const,
            id: "attachment",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      };
      yield* repo.upsert(row);
      const delta = {
        ...makeRow("chunk-metadata", " suffix"),
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      };
      yield* repo.applyEvent(delta, 1);
      const assembled = Option.getOrThrow(yield* repo.getByMessageId(row));
      assert.equal(assembled.text, "prefix suffix");
      assert.equal(assembled.createdAt, row.createdAt);
      assert.deepEqual(assembled.attachments, row.attachments);
      assert.equal(assembled.dispatchMode, "steer");
      assert.equal(assembled.role, "assistant");
      const fork = {
        ...assembled,
        messageId: MessageId.make("fork-message"),
        threadId: ThreadId.make("fork-thread"),
      };
      yield* repo.upsert(fork);
      yield* repo.applyEvent({ ...delta, text: "", attachments: [] }, 2);
      assert.deepEqual(Option.getOrThrow(yield* repo.getByMessageId(row)).attachments, []);
      yield* repo.upsert({ ...row, text: "replaced" });
      assert.equal(Option.getOrThrow(yield* repo.getByMessageId(row)).text, "replaced");
      assert.equal(Option.getOrThrow(yield* repo.getByMessageId(fork)).text, "prefix suffix");
      yield* repo.applyEvent({ ...row, text: " delete me" }, 3);
      yield* repo.deleteByThreadId(row);
      assert.isTrue(Option.isNone(yield* repo.getByMessageId(row)));
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM projection_message_chunks WHERE message_id = ${row.messageId}`)[0]
          ?.count,
        0,
      );
      assert.equal(Option.getOrThrow(yield* repo.getByMessageId(fork)).text, "prefix suffix");
    }),
  );
});
