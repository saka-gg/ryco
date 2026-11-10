import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@ryco/contracts";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { loadMessageText } from "../activityPayloadPreview.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  MESSAGE_PREVIEW_LENGTH,
  MESSAGE_PREVIEW_MIN_LENGTH,
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_WINDOW_MESSAGE_MAX_TEXT_BYTES,
} from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const threadId = ThreadId.make("thread-long-messages");
const limits = { messages: 150, activities: 150, proposedPlans: 30, checkpoints: 30 };

const seed = (messages: ReadonlyArray<{ readonly text: string; readonly streaming?: boolean }>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      )
      VALUES ('project-long', 'Long', '/tmp/long', NULL, '[]',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at
      )
      VALUES (${threadId}, 'project-long', 'Long', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-11-01T00:00:01.000Z', '2026-11-01T00:00:01.000Z', NULL)
    `;
    for (const [index, message] of messages.entries()) {
      const at = new Date(Date.UTC(2026, 10, 1, 0, 0, 0, 0) + index * 1000).toISOString();
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, NULL, 'assistant', ${message.text},
          ${message.streaming === true ? 1 : 0}, ${at}, ${at})`;
    }
  });

layer("message text in thread windows", (it) => {
  it.effect("keeps a window's messages within the text budget and pages the rest", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      // Twenty finished messages of 100 KB: five fit the 512 KB budget.
      yield* seed(
        Array.from({ length: 20 }, (_, index) => ({
          text: String.fromCharCode(97 + index).repeat(100_000),
        })),
      );
      const window = yield* query.getThreadWindow!({ threadId, limits });
      const ids = window.thread.messages.map((message) => message.id);
      assert.deepEqual(
        ids,
        [15, 16, 17, 18, 19].map((index) => `message-${index}`),
      );
      assert.isTrue(window.history.messages.hasMoreBefore);
      assert.isAtMost(
        window.thread.messages.reduce((bytes, message) => bytes + message.text.length, 0),
        THREAD_WINDOW_MESSAGE_MAX_TEXT_BYTES,
      );
      // Paging reaches what the budget left out.
      const page = yield* query.getThreadHistoryPage!({
        threadId,
        collection: "messages",
        mode: { kind: "before", cursor: window.history.messages.oldestCursor! },
        limit: 3,
      });
      assert.equal(page.collection, "messages");
      if (page.collection === "messages") {
        assert.deepEqual(
          page.items.map((message) => message.id),
          [12, 13, 14].map((index) => `message-${index}`),
        );
      }
    }),
  );

  it.effect(
    "sends very long finished messages as previews when asked, and the whole text on request",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const long = "a".repeat(MESSAGE_PREVIEW_MIN_LENGTH + 5_000);
        yield* seed([
          { text: long },
          { text: "short answer" },
          { text: "b".repeat(MESSAGE_PREVIEW_MIN_LENGTH + 1), streaming: true },
        ]);

        const full = yield* query.getThreadWindow!({ threadId, limits });
        assert.equal(full.thread.messages[0]!.text, long);
        assert.isUndefined(full.thread.messages[0]!.textPreview);

        const window = yield* query.getThreadWindow!({ threadId, limits, messageText: "preview" });
        const [preview, short, streaming] = window.thread.messages;
        assert.equal(preview!.text, long.slice(0, MESSAGE_PREVIEW_LENGTH));
        assert.deepEqual(preview!.textPreview, { fullLength: long.length });
        assert.equal(short!.text, "short answer");
        assert.isUndefined(short!.textPreview);
        // A streaming message is always whole: the client appends its deltas.
        assert.equal(streaming!.text.length, MESSAGE_PREVIEW_MIN_LENGTH + 1);
        assert.isUndefined(streaming!.textPreview);

        const whole = yield* loadMessageText(query.getMessageText, {
          threadId,
          messageId: MessageId.make("message-0"),
        });
        assert.deepEqual(whole, {
          messageId: MessageId.make("message-0"),
          text: long,
          fullLength: long.length,
          truncated: false,
        });
        const capped = yield* loadMessageText(
          query.getMessageText,
          { threadId, messageId: MessageId.make("message-0") },
          1_000,
        );
        assert.equal(capped.text.length, 1_000);
        assert.isTrue(capped.truncated);

        const missing = yield* Effect.exit(
          loadMessageText(query.getMessageText, {
            threadId: ThreadId.make("thread-other"),
            messageId: MessageId.make("message-0"),
          }),
        );
        assert.isTrue(Exit.isFailure(missing));
      }),
  );

  it.effect("measures a first thread open: bytes of a window with long messages", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      // 150 messages: mostly ordinary answers, a few pasted logs and generated documents.
      yield* seed(
        Array.from({ length: 150 }, (_, index) => ({
          text: index % 25 === 7 ? "log line\n".repeat(20_000) : "An ordinary answer. ".repeat(150),
        })),
      );
      const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
      // Today's window: the newest 150 messages whole. The budget now pages
      // older ones, so read those whole through history pages to count them.
      const before = yield* query.getThreadWindow!({ threadId, limits });
      let todayBytes = bytes(before.thread.messages);
      let todayCount = before.thread.messages.length;
      let cursor = before.history.messages.oldestCursor;
      while (todayCount < 150 && cursor !== null) {
        const page = yield* query.getThreadHistoryPage!({
          threadId,
          collection: "messages",
          mode: { kind: "before", cursor },
          limit: 150 - todayCount,
        });
        if (page.collection !== "messages") break;
        todayBytes += bytes(page.items);
        todayCount += page.items.length;
        cursor = page.page.hasMoreBefore ? page.page.oldestCursor : null;
      }
      const after = yield* query.getThreadWindow!({ threadId, limits, messageText: "preview" });
      const phone = yield* query.getThreadWindow!({
        threadId,
        limits: { ...limits, messages: 30 },
        messageText: "preview",
      });
      console.info(
        `[A7] window messages: today ${todayCount} messages ${todayBytes} bytes; with budget + previews ${after.thread.messages.length} messages ${bytes(after.thread.messages)} bytes; phone first window ${phone.thread.messages.length} messages ${bytes(phone.thread.messages)} bytes`,
      );
      assert.isAtMost(bytes(after.thread.messages), THREAD_WINDOW_MESSAGE_MAX_TEXT_BYTES * 1.2);
    }),
  );
});
