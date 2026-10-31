import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode } from "./runtimeMode.ts";

/**
 * Command watches (`ryco_watch_command`, T3 Code's `watch_command`): a shell command the node
 * runs on an interval for a thread's agent, with no model involved, waking the agent only when
 * the command prints something new. Only an agent creates one, and only for its own thread in
 * Full access and default mode; the agent and an operator (`thread.command-watch.stop`) can stop
 * it. The run rules and the wake text live in `@ryco/shared/commandWatch`. See
 * `docs/command-watch.md`.
 */

/** Watches one thread may hold at once (T3 Code). */
export const COMMAND_WATCHES_PER_THREAD = 5;
/** Active watches across the node. */
export const COMMAND_WATCHES_PER_NODE = 50;
export const COMMAND_WATCH_MAX_COMMAND_CHARS = 4_000;
export const COMMAND_WATCH_MAX_LABEL_CHARS = 120;
export const COMMAND_WATCH_MAX_EVERY_MINUTES = 24 * 60;

/** Private-session Agent Control tools (loaded on first use, never on the external endpoint). */
export const AGENT_CONTROL_COMMAND_WATCH_MCP_TOOLS = {
  watch: "ryco_watch_command",
  unwatch: "ryco_unwatch_command",
  list: "ryco_list_command_watches",
} as const;

export const CommandWatchCommand = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMMAND_WATCH_MAX_COMMAND_CHARS),
);
export const CommandWatchLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMMAND_WATCH_MAX_LABEL_CHARS),
);
export const CommandWatchEveryMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: COMMAND_WATCH_MAX_EVERY_MINUTES }),
);

export const CommandWatchEndReason = Schema.Literals([
  /** The agent or the user stopped it. */
  "unwatched",
  "settled",
  "archived",
  "trashed",
  /** The user stopped the thread. */
  "stopped",
  /** The thread left Full access or default mode, or its checkout moved. */
  "scope-changed",
  /** It woke the agent 10 times. */
  "wake-limit",
  /** 8 runs in a row failed. */
  "failing",
  /** It printed more than a wake can carry. */
  "too-long",
  /** 7 days passed, or its wake waited a day for a thread that could not take it. */
  "expired",
  /** Its updates were refused several times in a row. */
  "rejected",
]);
export type CommandWatchEndReason = typeof CommandWatchEndReason.Type;

/** What the agent was last told: restored when a wake provably never reached it. */
export const CommandWatchProgress = Schema.Struct({
  /** SHA-256 hex of the trimmed output; null until the baseline run. Never the output itself. */
  lastOutputHash: Schema.NullOr(TrimmedNonEmptyString),
  wakes: NonNegativeInt,
});

/**
 * One watch. The command, the cadence and the captured scope never change after the start;
 * every change goes through a revision-fenced `thread.command-watch.update`. A quiet run writes
 * nothing.
 */
export const ThreadCommandWatch = Schema.Struct({
  /** `command-watch:<uuid>`. */
  watchId: TrimmedNonEmptyString,
  command: CommandWatchCommand,
  label: CommandWatchLabel,
  everyMinutes: CommandWatchEveryMinutes,
  revision: PositiveInt,
  /** The generation: an update names it, so a stale run cannot touch a watch started again. */
  startedAt: IsoDateTime,
  /** The thread's runtime and checkout when it started; any change ends the watch. */
  runtimeMode: RuntimeMode,
  worktreePath: Schema.NullOr(Schema.String),
  /** Where the command runs, resolved by the node (never from the agent's input). */
  cwd: TrimmedNonEmptyString,
  ...CommandWatchProgress.fields,
  lastChangeAt: Schema.NullOr(IsoDateTime),
  /** A wake whose turn start has not bound yet. */
  delivery: Schema.NullOr(Schema.Struct({ messageId: MessageId, sentAt: IsoDateTime })),
  beforeWake: Schema.NullOr(CommandWatchProgress),
});
export type ThreadCommandWatch = typeof ThreadCommandWatch.Type;

export const ThreadCommandWatchEnded = Schema.Struct({
  watchId: TrimmedNonEmptyString,
  label: CommandWatchLabel,
  reason: CommandWatchEndReason,
  endedAt: IsoDateTime,
});
export type ThreadCommandWatchEnded = typeof ThreadCommandWatchEnded.Type;

/** A thread's watches, full state: only the server's command read model carries it. */
export const ThreadCommandWatches = Schema.Struct({
  active: Schema.Array(ThreadCommandWatch),
  /** Newest first, a few. */
  ended: Schema.Array(ThreadCommandWatchEnded),
});
export type ThreadCommandWatches = typeof ThreadCommandWatches.Type;
