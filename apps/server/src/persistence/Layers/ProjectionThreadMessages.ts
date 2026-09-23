import {
  encodeMessageTextFallback,
  messageTextColumns,
  resolveMessageText,
  MessageTextFromSql,
} from "../messageText.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import { ChatAttachment, TurnDispatchMode } from "@ryco/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionThreadMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    assembledText: Schema.NullOr(MessageTextFromSql),
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    dispatchMode: Schema.NullOr(TurnDispatchMode),
  }),
);

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: resolveMessageText(row),
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.dispatchMode !== null ? { dispatchMode: row.dispatchMode } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          text_json,
          attachments_json,
          dispatch_mode,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          ${encodeMessageTextFallback(row.text)},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.dispatchMode ?? null},
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          text_json = excluded.text_json,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          dispatch_mode = COALESCE(
            excluded.dispatch_mode,
            projection_thread_messages.dispatch_mode
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          ${messageTextColumns(sql)},
          attachments_json AS "attachments",
          dispatch_mode AS "dispatchMode",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          ${messageTextColumns(sql)},
          attachments_json AS "attachments",
          dispatch_mode AS "dispatchMode",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row, options) =>
    sql
      .withTransaction(
        upsertProjectionThreadMessageRow(row).pipe(
          Effect.andThen(
            sql`DELETE FROM projection_message_chunks WHERE message_id = ${row.messageId}`,
          ),
          Effect.andThen(
            options === undefined
              ? Effect.void
              : sql`UPDATE projection_thread_messages SET text_event_sequence = ${options.eventSequence} WHERE message_id = ${row.messageId}`.pipe(
                  Effect.asVoid,
                ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
      );

  // This transaction nests into the event + projector-cursor transaction. Never
  // acknowledge a delta before its chunk and metadata are durably committed.
  const applyEvent: ProjectionThreadMessageRepositoryShape["applyEvent"] = (row, sequence) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const states = yield* sql<{ sequence: number; createdAt: string }>`
        SELECT text_event_sequence AS sequence, created_at AS "createdAt"
        FROM projection_thread_messages WHERE message_id = ${row.messageId}
      `;
          const state = states[0];
          if (state !== undefined && state.sequence >= sequence) return;
          if (!row.isStreaming) {
            const existing =
              row.text.length === 0
                ? yield* getProjectionThreadMessageRow({ messageId: row.messageId })
                : Option.none();
            yield* upsertProjectionThreadMessageRow({
              ...row,
              text: Option.isSome(existing) ? resolveMessageText(existing.value) : row.text,
              createdAt: state?.createdAt ?? row.createdAt,
            });
            yield* sql`DELETE FROM projection_message_chunks WHERE message_id = ${row.messageId}`;
            yield* sql`UPDATE projection_thread_messages SET text_event_sequence = ${sequence} WHERE message_id = ${row.messageId}`;
            return;
          }
          if (state === undefined) {
            yield* upsertProjectionThreadMessageRow({ ...row, text: "" });
          } else {
            // Move a completed/legacy prefix off the frequently updated metadata row
            // exactly once. SQL json_quote avoids a native TEXT read truncating NUL.
            yield* sql`
          INSERT INTO projection_message_chunks (message_id, event_sequence, text_json)
          SELECT message_id, 0, COALESCE(text_json, json_quote(text))
          FROM projection_thread_messages
          WHERE message_id = ${row.messageId} AND (text <> '' OR text_json IS NOT NULL)
        `;
          }
          yield* sql`
        UPDATE projection_thread_messages SET
          thread_id = ${row.threadId}, turn_id = ${row.turnId}, role = ${row.role},
          text = '', text_json = NULL, is_streaming = 1,
          updated_at = ${row.updatedAt}, text_event_sequence = ${sequence}
          ${row.attachments !== undefined ? sql`, attachments_json = ${JSON.stringify(row.attachments)}` : sql``}
          ${row.dispatchMode !== undefined ? sql`, dispatch_mode = ${row.dispatchMode}` : sql``}
        WHERE message_id = ${row.messageId}
      `;
          yield* sql`
        INSERT INTO projection_message_chunks (message_id, event_sequence, text_json)
        VALUES (${row.messageId}, ${sequence}, ${JSON.stringify(row.text)})
      `;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadMessageRepository.applyEvent:query"),
        ),
      );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    applyEvent,
    upsert,
    getByMessageId,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
