// Adapted from pingdotgg/t3code packages/provider-testing/src/replayTranscript.ts
// (91992bd5d464d6a01b2a5c1e7926e68ad09ea40e). Copyright (c) 2026 T3 Tools Inc. MIT; see
// THIRD_PARTY_NOTICES.md.
/**
 * Provider replay transcripts: what a test expects a provider client to write, and what the
 * replayed provider answers, one NDJSON entry per line after a `transcript_start` header.
 *
 * Transcripts carry no timing. Interleaving is controlled with gates (`replayGate.ts`), so no
 * fixture adds a wall-clock sleep.
 *
 * @module provider/testUtils/replay/replayTranscript
 */
import { Effect, FileSystem, Path, Result, Schema } from "effect";

import { stableStringify } from "./replayMatch.ts";

export const ReplayProtocol = Schema.Literals([
  "codex.app-server",
  "claude-agent-sdk.query",
  "acp",
]);
export type ReplayProtocol = typeof ReplayProtocol.Type;

export const ReplayHeader = Schema.Struct({
  type: Schema.Literal("transcript_start"),
  /** The provider driver kind, e.g. `codex`. */
  provider: Schema.String,
  protocol: ReplayProtocol,
  /** The provider CLI or SDK version the frames follow. */
  version: Schema.String,
  scenario: Schema.String,
  /** `derived`: hand-built from recorded frames; `hand-authored`: written from the protocol. */
  source: Schema.Literals(["recorded", "hand-authored", "derived"]),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ReplayHeader = typeof ReplayHeader.Type;

export const ReplayExpectOutbound = Schema.Struct({
  type: Schema.Literal("expect_outbound"),
  label: Schema.optional(Schema.String),
  frame: Schema.Unknown,
  /** May go unsent: matched whenever it arrives, never waited for. */
  optional: Schema.optional(Schema.Boolean),
});
export type ReplayExpectOutbound = typeof ReplayExpectOutbound.Type;

export const ReplayEmitInbound = Schema.Struct({
  type: Schema.Literal("emit_inbound"),
  label: Schema.optional(Schema.String),
  /** A JSON frame; on `stderr` a string line. */
  frame: Schema.Unknown,
  stream: Schema.optional(Schema.Literals(["stdout", "stderr"])),
});
export type ReplayEmitInbound = typeof ReplayEmitInbound.Type;

/** Starts the next process (or SDK query); the entries before it belong to the previous one. */
export const ReplaySpawn = Schema.Struct({
  type: Schema.Literal("spawn"),
  label: Schema.optional(Schema.String),
});
export type ReplaySpawn = typeof ReplaySpawn.Type;

export const ReplayRuntimeExit = Schema.Struct({
  type: Schema.Literal("runtime_exit"),
  status: Schema.Literals(["success", "error", "cancelled"]),
  code: Schema.optional(Schema.Int),
  error: Schema.optional(Schema.Unknown),
});
export type ReplayRuntimeExit = typeof ReplayRuntimeExit.Type;

export const ReplayEntry = Schema.Union([
  ReplayExpectOutbound,
  ReplayEmitInbound,
  ReplaySpawn,
  ReplayRuntimeExit,
]);
export type ReplayEntry = typeof ReplayEntry.Type;

export interface ReplayTranscript {
  readonly header: ReplayHeader;
  readonly entries: ReadonlyArray<ReplayEntry>;
}

export class ReplayNdjsonLineError extends Schema.TaggedError<ReplayNdjsonLineError>()(
  "ReplayNdjsonLineError",
  {
    lineNumber: Schema.Number,
    line: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Replay NDJSON line ${this.lineNumber}: ${this.detail}`;
  }
}

export class ReplayMissingHeaderError extends Schema.TaggedError<ReplayMissingHeaderError>()(
  "ReplayMissingHeaderError",
  { lineNumber: Schema.Number },
) {
  override get message(): string {
    return `Replay NDJSON line ${this.lineNumber} must be the transcript_start header.`;
  }
}

export class ReplayEmptyError extends Schema.TaggedError<ReplayEmptyError>()(
  "ReplayEmptyError",
  {},
) {
  override get message(): string {
    return "Replay NDJSON has no records.";
  }
}

export type ReplayNdjsonError = ReplayNdjsonLineError | ReplayMissingHeaderError | ReplayEmptyError;

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeHeader = Schema.decodeUnknownResult(ReplayHeader);
const decodeEntry = Schema.decodeUnknownResult(ReplayEntry);

const isHeaderRecord = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly type?: unknown }).type === "transcript_start";

/** Decodes NDJSON text; errors name the 1-based line, and the header is valid on line 1 only. */
export const decodeReplayNdjson = (
  text: string,
): Effect.Effect<ReplayTranscript, ReplayNdjsonError> =>
  Effect.gen(function* () {
    const lines = text
      .split(/\r?\n/u)
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => line.length > 0);
    if (lines.length === 0) return yield* new ReplayEmptyError();

    let header: ReplayHeader | undefined;
    const entries: Array<ReplayEntry> = [];
    for (const { line, lineNumber } of lines) {
      const json = decodeJson(line);
      if (Result.isFailure(json)) {
        return yield* new ReplayNdjsonLineError({ lineNumber, line, detail: "invalid JSON" });
      }
      if (header === undefined) {
        if (!isHeaderRecord(json.success))
          return yield* new ReplayMissingHeaderError({ lineNumber });
        const decoded = decodeHeader(json.success);
        if (Result.isFailure(decoded)) {
          return yield* new ReplayNdjsonLineError({
            lineNumber,
            line,
            detail: `invalid header: ${decoded.failure.message}`,
          });
        }
        header = decoded.success;
        continue;
      }
      if (isHeaderRecord(json.success)) {
        return yield* new ReplayNdjsonLineError({
          lineNumber,
          line,
          detail: "transcript_start is only valid on line 1",
        });
      }
      const decoded = decodeEntry(json.success);
      if (Result.isFailure(decoded)) {
        return yield* new ReplayNdjsonLineError({
          lineNumber,
          line,
          detail: `invalid entry: ${decoded.failure.message}`,
        });
      }
      entries.push(decoded.success);
    }
    return { header: header!, entries };
  });

/** Entry keys in a fixed order; frames get sorted keys, so re-recorded fixtures diff cleanly. */
const ENTRY_KEY_ORDER = [
  "type",
  "provider",
  "protocol",
  "version",
  "scenario",
  "source",
  "label",
  "optional",
  "stream",
  "status",
  "code",
  "error",
  "metadata",
  "frame",
] as const;

function encodeRecord(record: object): string {
  const fields = record as Record<string, unknown>;
  const parts: Array<string> = [];
  for (const key of ENTRY_KEY_ORDER) {
    const value = fields[key];
    if (value !== undefined) parts.push(`${JSON.stringify(key)}:${stableStringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

export function encodeReplayNdjson(transcript: ReplayTranscript): string {
  return `${[transcript.header, ...transcript.entries].map(encodeRecord).join("\n")}\n`;
}

/** Reads and decodes a fixture next to the calling test (`new URL("…", import.meta.url)`). */
export const readReplayFixture = Effect.fn("readReplayFixture")(function* (url: URL) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem.readFileString(yield* path.fromFileUrl(url));
  return yield* decodeReplayNdjson(text);
});

export const REPLAY_WORKSPACE_PLACEHOLDER = "<workspace>";
export const REPLAY_HOME_PLACEHOLDER = "<home>";

function materializeValue(value: unknown, replacements: ReadonlyArray<[string, string]>): unknown {
  if (typeof value === "string") {
    for (const [placeholder, actual] of replacements) {
      if (value === placeholder) return actual;
      if (value.startsWith(`${placeholder}/`)) return `${actual}${value.slice(placeholder.length)}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => materializeValue(entry, replacements));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, materializeValue(entry, replacements)]),
  );
}

/**
 * Replaces `<workspace>` and `<home>` (whole strings or path prefixes) in every frame with this
 * run's directories. Inbound frames too: a provider reports paths back (Codex answers
 * `thread/start` with the session's `cwd`, which the runtime adopts), and a session whose cwd is
 * not the thread's is restarted on the next turn.
 */
export function materializeWorkspace(
  transcript: ReplayTranscript,
  directories: { readonly workspace: string; readonly home?: string },
): ReplayTranscript {
  const replacements: Array<[string, string]> = [
    [REPLAY_WORKSPACE_PLACEHOLDER, directories.workspace],
  ];
  if (directories.home !== undefined) {
    replacements.push([REPLAY_HOME_PLACEHOLDER, directories.home]);
  }
  return {
    header: transcript.header,
    entries: transcript.entries.map((entry) =>
      entry.type === "expect_outbound" || entry.type === "emit_inbound"
        ? { ...entry, frame: materializeValue(entry.frame, replacements) }
        : entry,
    ),
  };
}
