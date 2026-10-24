/**
 * `ryco trace`: inspect the local server trace file without the server.
 *
 * `ryco trace summary` reads the trace file and its rotated backups directly: no server, no
 * database and no persistence layer, so it answers while the server is stalled or stopped.
 *
 * cli.ts passes in its location flags, `--json` flag and helpers, and config resolution, so this
 * module owns the command and cli.ts only registers it. Only the command and its flags are here;
 * the summary (`traceRun.ts`) loads when the command runs.
 *
 * @module cliTrace/traceCommand
 */
import { Effect, Schema } from "effect";
import type { Duration, LogLevel, Option } from "effect";
import { Command, Flag } from "effect/cli";

import type { ServerConfigShape } from "../config.ts";

export interface TraceLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
}

/** The parsed flags of `ryco trace summary`. */
export interface TraceSummaryFlags extends TraceLocationFlags {
  readonly json: boolean;
  readonly since: Option.Option<Duration.Duration>;
  readonly limit: number;
  readonly file: Option.Option<string>;
}

export interface TraceCommandDeps<E, R> {
  /** `--base-dir` and `--dev-url`, as every command that opens a data directory takes them. */
  readonly locationFlags: {
    readonly baseDir: Flag.Flag<Option.Option<string>>;
    readonly devUrl: Flag.Flag<Option.Option<URL>>;
  };
  readonly jsonFlag: Flag.Flag<boolean>;
  /** The one `--json` document form every command prints. */
  readonly emitJson: (value: unknown) => string;
  /** Parses `--since` the way `--ttl` is parsed (`30m`, `2h`, `7d`, `15 minutes`). */
  readonly durationSchema: Schema.Codec<Duration.Duration, string>;
  /**
   * Resolves the trace file path and backup count exactly as the server does (`RYCO_HOME`,
   * `--base-dir`, `RYCO_TRACE_FILE`, `RYCO_TRACE_MAX_FILES`, dev mode).
   */
  readonly resolveConfig: (
    flags: TraceLocationFlags,
    logLevel: Option.Option<LogLevel.LogLevel>,
  ) => Effect.Effect<ServerConfigShape, E, R>;
  /** Silences every log line below Error for the whole command (`--json` owns stdout). */
  readonly quietly: <A, E2, R2>(
    quiet: boolean,
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
}

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const makeTraceSummaryCommand = <E, R>(deps: TraceCommandDeps<E, R>) =>
  Command.make("summary", {
    ...deps.locationFlags,
    json: deps.jsonFlag,
    since: Flag.String("since").pipe(
      Flag.withSchema(deps.durationSchema),
      Flag.withDescription(
        "Only count spans that ended in this window, for example `30m`, `2h` or `7d`.",
      ),
      Flag.optional,
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withSchema(PositiveInt),
      Flag.withDescription("Number of span names to show, busiest first."),
      Flag.withDefault(25),
    ),
    file: Flag.String("file").pipe(
      Flag.withDescription(
        "Trace file to read instead of the data directory's (its rotated `.1`, `.2`, ... are read too).",
      ),
      Flag.optional,
    ),
  }).pipe(
    Command.withDescription(
      "Summarize the local server trace file and its rotated backups: span counts, rates and latency. Works while the server is stalled or stopped.",
    ),
    Command.withHandler((flags) =>
      deps.quietly(
        flags.json,
        Effect.gen(function* () {
          // The summary itself loads only when this command runs, which keeps it off the server's
          // boot path (serverBundleBoundaries.test.ts).
          const { runTraceSummary } = yield* Effect.promise(() => import("./traceRun.ts"));
          return yield* runTraceSummary(deps, flags);
        }),
      ),
    ),
  );

export const makeTraceCommand = <E, R>(deps: TraceCommandDeps<E, R>) =>
  Command.make("trace").pipe(
    Command.withDescription("Inspect the local server trace file."),
    Command.withSubcommands([makeTraceSummaryCommand(deps)]),
  );
