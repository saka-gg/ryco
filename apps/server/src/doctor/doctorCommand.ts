/**
 * `ryco doctor`: check the database, and with `--apply` remove superseded history and shrink the
 * file while no server uses it (see `DatabaseDoctor.ts` and docs/storage-management.md).
 *
 * cli.ts passes in its location flags, `--json` flag and config resolution, so this module owns
 * the command and cli.ts only registers it.
 *
 * Exit codes: 0 done (or nothing to do, or declined), 1 a failure midway, 2 refused (nothing
 * changed: another server has the database, the schema differs, not enough disk, ...).
 *
 * @module doctor/doctorCommand
 */
import { Effect, type LogLevel, type Option } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

import type { ServerConfigShape } from "../config.ts";

interface DoctorLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
}

export interface DoctorCommandDeps<E, R> {
  /** `--base-dir` and `--dev-url`, as every command that opens a data directory takes them. */
  readonly locationFlags: {
    readonly baseDir: Flag.Flag<Option.Option<string>>;
    readonly devUrl: Flag.Flag<Option.Option<URL>>;
  };
  readonly jsonFlag: Flag.Flag<boolean>;
  /** The one `--json` document form every command prints. */
  readonly emitJson: (value: unknown) => string;
  /** Resolves the data directory the way the other admin commands do. */
  readonly resolveConfig: (
    flags: DoctorLocationFlags,
    logLevel: Option.Option<LogLevel.LogLevel>,
  ) => Effect.Effect<ServerConfigShape, E, R>;
  /** Silences every log line below Error for the whole command (`--json` owns stdout). */
  readonly quietly: <A, E2, R2>(
    quiet: boolean,
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
  readonly adminCommandLogLevel: (
    requested: Option.Option<LogLevel.LogLevel>,
    configured: LogLevel.LogLevel,
  ) => LogLevel.LogLevel;
}

export const makeDoctorCommand = <E, R>(deps: DoctorCommandDeps<E, R>) =>
  Command.make("doctor", {
    ...deps.locationFlags,
    apply: Flag.Boolean("apply").pipe(
      Flag.withDescription(
        "Remove superseded history and shrink the database file. Stops this data directory's background service and starts it again; refuses while another Ryco server uses the database.",
      ),
      Flag.withDefault(false),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Do not ask for confirmation (needed with --apply outside a terminal)."),
      Flag.withDefault(false),
    ),
    estimate: Flag.Boolean("estimate").pipe(
      Flag.withDescription(
        "Count exactly how much superseded history the database holds (reads the whole log).",
      ),
      Flag.withDefault(false),
    ),
    thorough: Flag.Boolean("thorough").pipe(
      Flag.withDescription("Check the database with integrity_check instead of quick_check first."),
      Flag.withDefault(false),
    ),
    restartService: Flag.Boolean("restart-service").pipe(
      Flag.withDescription(
        "Start the background service again after --apply stopped it (--no-restart-service leaves it stopped).",
      ),
      Flag.withDefault(true),
    ),
    json: deps.jsonFlag,
  }).pipe(
    Command.withDescription(
      "Check the database and how much it could shrink; with --apply, remove superseded history and shrink the file offline.",
    ),
    Command.withHandler((flags) =>
      deps.quietly(
        flags.json,
        Effect.gen(function* () {
          const logLevel = yield* GlobalFlag.LogLevel;
          const config = yield* deps.resolveConfig(
            { baseDir: flags.baseDir, devUrl: flags.devUrl },
            logLevel,
          );
          // The doctor itself loads only when this command runs, which keeps it off the server's
          // boot path (serverBundleBoundaries.test.ts).
          const { runDoctor } = yield* Effect.promise(() => import("./doctorRun.ts"));
          return yield* runDoctor({
            flags,
            config,
            logLevel,
            emitJson: deps.emitJson,
            adminCommandLogLevel: deps.adminCommandLogLevel,
          });
        }),
      ),
    ),
  );
