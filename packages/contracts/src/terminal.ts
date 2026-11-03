import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ForwardCompatibleUnion, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DEFAULT_TERMINAL_ID = "default";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const isTerminalEnvKey = Schema.is(TerminalEnvKeySchema);
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(Schema.String, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
  Schema.makeFilter((env) =>
    Object.keys(env).every(isTerminalEnvKey) ? undefined : "Invalid terminal environment key",
  ),
);

const TerminalIdWithDefaultSchema = TerminalIdSchema.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_ID)),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdWithDefaultSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

/** Ordering within one manager lifetime; never persisted across server restarts. */
export const TerminalCursor = Schema.Struct({
  generation: TrimmedNonEmptyString,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TerminalCursor = typeof TerminalCursor.Type;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  requireCurrentWorkspace: Schema.optional(Schema.Boolean),
  /**
   * The cursor up to which the caller's view already shows this terminal's output. When the
   * live session still covers it, the answer carries only the history after it and echoes it as
   * `historySince`; otherwise (another generation, a restart or clear since, trimmed scrollback)
   * the full history. Older servers ignore it.
   */
  sinceCursor: Schema.optional(TerminalCursor),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  guard: Schema.optional(
    Schema.Struct({
      inputEpoch: TrimmedNonEmptyStringSchema,
      outputCursor: TerminalCursor,
      cwd: TrimmedNonEmptyStringSchema,
      worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
    }),
  ),
  /**
   * Type only into a shell the server verifies idle at this moment, else fail with
   * {@link TerminalBusyError} without writing anything. Older servers drop the key and write
   * unguarded: send it only to nodes that advertise `capabilities.terminalWriteRequireIdle`.
   */
  requireIdle: Schema.optional(Schema.Literal(true)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
  cursor: Schema.optional(TerminalCursor),
  /** Changes on every PTY start. Required for guarded input; absent on older servers. */
  inputEpoch: Schema.optional(TrimmedNonEmptyStringSchema),
  /**
   * Set only on a `terminal.open` answer to `sinceCursor`: `history` then holds just the output
   * after this cursor, to append to a view that shows everything up to it. Absent means `history`
   * is the full retained scrollback.
   */
  historySince: Schema.optional(TerminalCursor),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
  cursor: Schema.optional(TerminalCursor),
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
  /**
   * Subscription catch-up for a session that was already running, not a fresh start. Its
   * snapshot carries no history (`""`): a surface whose cursor is behind re-hydrates scrollback
   * through `terminal.open`, and nothing opens or focuses the terminal for it. Sent only to
   * subscribers that asked for `replay: "metadata"`; absent on live starts.
   */
  replay: Schema.optional(Schema.Literal(true)),
  /** Subprocess activity when a replay was taken. Absent on live starts, which have none. */
  hasRunningSubprocess: Schema.optional(Schema.Boolean),
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

/**
 * A terminal event as a client decodes it: an event type a newer node adds
 * decodes to an `UnknownUnionMember` the client skips, instead of ending the
 * terminal event stream for every terminal.
 */
export const TerminalWireEvent = ForwardCompatibleUnion(TerminalEvent.members, "type");
export type TerminalWireEvent = typeof TerminalWireEvent.Type;

/**
 * `replay: "metadata"` asks for history-free catch-up events (`replay: true`) for running
 * sessions; `terminal.open` stays the only source of retained history. Older servers ignore the
 * field and replay full snapshots as ordinary `started` events.
 */
export const TerminalSubscribeEventsInput = Schema.Struct({
  replay: Schema.optional(Schema.Literal("metadata")),
});
export type TerminalSubscribeEventsInput = typeof TerminalSubscribeEventsInput.Type;

export class TerminalSubscriptionResyncError extends Schema.TaggedError<TerminalSubscriptionResyncError>()(
  "TerminalSubscriptionResyncError",
  {
    reason: Schema.Literal("slowConsumer"),
    capacity: Schema.Number,
  },
) {
  override get message() {
    return `Terminal event subscriber fell behind (${this.capacity} buffered events); reconnect to resynchronize`;
  }
}

export class TerminalCwdError extends Schema.TaggedError<TerminalCwdError>()("TerminalCwdError", {
  cwd: Schema.String,
  reason: Schema.Literals([
    "notFound",
    "notDirectory",
    "outsideWorkspace",
    "statFailed",
    /**
     * Closed set on the wire: older clients cannot decode a new reason. A refusal without its
     * own reason (a chat folder moving into a project) is `statFailed` with a `cause` message.
     */
    "cleanupPending",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.reason === "cleanupPending")
      return "Checkout cleanup is pending or complete. Restore it before opening a terminal.";
    if (this.reason === "notDirectory") {
      return `Terminal cwd is not a directory: ${this.cwd}`;
    }
    if (this.reason === "notFound") {
      return `Terminal cwd does not exist: ${this.cwd}`;
    }
    if (this.reason === "outsideWorkspace") {
      return `Terminal cwd is outside the configured workspace: ${this.cwd}`;
    }
    const causeMessage =
      this.cause && typeof this.cause === "object" && "message" in this.cause
        ? this.cause.message
        : undefined;
    return causeMessage
      ? `Failed to access terminal cwd: ${this.cwd} (${causeMessage})`
      : `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export class TerminalHistoryError extends Schema.TaggedError<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalInputRejectedError extends Schema.TaggedError<TerminalInputRejectedError>()(
  "TerminalInputRejectedError",
  { message: Schema.String },
) {}

/**
 * A `requireIdle` write found the shell busy or could not tell; nothing was written. Only
 * `requireIdle` writes fail with it, so clients that never send the field never decode it.
 */
export class TerminalBusyError extends Schema.TaggedError<TerminalBusyError>()(
  "TerminalBusyError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    reason: Schema.Literals([
      /** The shell runs a command. */
      "running",
      /** The shell is not running, or its processes could not be read. */
      "unverified",
      /** Input arrived moments ago: the shell may not have started its command yet. */
      "inputRaced",
    ]),
  },
) {
  override get message() {
    if (this.reason === "running") return "The terminal is running a command. Nothing was sent.";
    if (this.reason === "inputRaced") return "The terminal just received input. Nothing was sent.";
    return "Unable to verify that the terminal is idle. Nothing was sent.";
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
  TerminalInputRejectedError,
  TerminalBusyError,
]);
export type TerminalError = typeof TerminalError.Type;
