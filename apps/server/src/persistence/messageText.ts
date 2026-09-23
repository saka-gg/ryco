import { Schema, SchemaTransformation } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// TEXT crosses UTF-8/native SQLite boundaries. JSON preserves NUL and individual
// UTF-16 code units (including surrogate pairs split across provider deltas).
export const encodeMessageTextFallback = (text: string): string | null =>
  text.includes("\0") ||
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    ? JSON.stringify(text)
    : null;

export const MessageTextFromSql = Schema.fromJsonString(Schema.Array(Schema.String)).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (parts) => parts.join(""),
      encode: (text) => [text],
    }),
  ),
);
export const decodeMessageText = Schema.decodeUnknownSync(MessageTextFromSql);

// Keep the prefix and deltas in one ordered SQL relation. All aliases are code-owned.
const messageTextParts = (sql: SqlClient.SqlClient, alias: string) => sql`
  SELECT COALESCE(${sql.literal(alias)}.text_json, json_quote(${sql.literal(alias)}.text)) AS text_json, -1 AS sequence
  UNION ALL
  SELECT text_json, event_sequence AS sequence FROM projection_message_chunks
  WHERE message_id = ${sql.literal(alias)}.message_id
  ORDER BY sequence
`;

/** Assemble streaming chunks or lossless fallback text only when needed.
 * Migration 61 backfills legacy NUL rows once. Ordinary completed
 * bodies never enter SQLite's JSON encoder or JavaScript's JSON decoder.
 */
export const assembledMessageText = (
  sql: SqlClient.SqlClient,
  alias = "projection_thread_messages",
) => sql`
  CASE WHEN ${sql.literal(alias)}.is_streaming <> 0
    OR ${sql.literal(alias)}.text_json IS NOT NULL
    THEN (SELECT json_group_array(json(parts.text_json)) FROM (${messageTextParts(sql, alias)}) AS parts)
    ELSE NULL
  END
`;

export const messageTextColumns = (
  sql: SqlClient.SqlClient,
  alias = "projection_thread_messages",
  completedCharacterLimit?: number,
) => sql`
  ${completedCharacterLimit === undefined ? sql`${sql.literal(alias)}.text` : sql`substr(${sql.literal(alias)}.text, 1, ${completedCharacterLimit})`} AS text,
  ${assembledMessageText(sql, alias)} AS "assembledText"
`;

export const resolveMessageText = (row: {
  readonly text: string;
  readonly assembledText: string | null;
}) => row.assembledText ?? row.text;

// Explicit encoded read for diagnostics/tests, not the ordinary read path.
export const messageTextJson = (
  sql: SqlClient.SqlClient,
  alias = "projection_thread_messages",
) => sql`
  (SELECT json_group_array(json(parts.text_json)) FROM (${messageTextParts(sql, alias)}) AS parts)
`;

/** Join JSON string interiors before decoding, including split surrogate pairs.
 * SQL LIKE keeps SQLite's existing case/NUL semantics; content reads use JS.
 */
export const messageTextForSearch = (sql: SqlClient.SqlClient, alias: string) => sql`
  CASE WHEN ${sql.literal(alias)}.is_streaming = 0 AND ${sql.literal(alias)}.text_json IS NULL
    THEN ${sql.literal(alias)}.text
    ELSE json_extract('"' || (SELECT group_concat(substr(parts.text_json, 2, length(parts.text_json) - 2), '')
      FROM (${messageTextParts(sql, alias)}) AS parts) || '"', '$')
  END
`;
