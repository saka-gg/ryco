/**
 * The resume cursor a Codex thread binding carries: the app-server thread id. Kept apart from
 * `CodexSessionRuntime`, so readers such as chat forks check a cursor without loading the Codex
 * protocol schema on the server's boot path.
 *
 * @module codexResumeCursor
 */
import * as Schema from "effect/Schema";

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
