/**
 * `ryco db`: back up the database, list its backups, and restore one into a new data directory
 * or in place of the database in use.
 *
 * None of these migrate the database in use, and only `restore --replace` changes it, as its
 * owner while no server runs; the others are safe while Ryco runs. They
 * open their own SQLite connections instead of the persistence layer, which would migrate.
 * See docs/database-backups.md.
 *
 * cli.ts passes in its location flags, `--json` flag and config resolution, so this module owns
 * the command and cli.ts only registers it. It holds only the flags and subcommands; what each
 * subcommand does (dbRun.ts, and with it databaseBackups.ts) loads with `import()` when it runs,
 * which keeps it off the server's boot path (serverBundleBoundaries.test.ts).
 *
 * @module cliDb/dbCommand
 */
import { Effect, type LogLevel, type Option, References } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import type { ServerConfigShape } from "../config.ts";

interface DbLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
}

export interface DbCommandDeps<E, R> {
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
    flags: DbLocationFlags,
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

/** The subcommands' implementation, loaded only when one of them runs. */
const loadDbRun = Effect.promise(() => import("./dbRun.ts"));

export const makeDbCommand = <E, R>(deps: DbCommandDeps<E, R>) => {
  /** Resolves the data directory, then runs `run` at the admin commands' log level. */
  const runDb = <A, E2, R2>(
    flags: DbLocationFlags & { readonly json: boolean },
    run: (config: ServerConfigShape) => Effect.Effect<A, E2, R2>,
  ) =>
    deps.quietly(
      flags.json,
      Effect.gen(function* () {
        const logLevel = yield* GlobalFlag.LogLevel;
        const config = yield* deps.resolveConfig(flags, logLevel);
        return yield* run(config).pipe(
          Effect.provideService(
            References.MinimumLogLevel,
            flags.json ? "Error" : deps.adminCommandLogLevel(logLevel, config.logLevel),
          ),
        );
      }),
    );

  const backupCommand = Command.make("backup", {
    ...deps.locationFlags,
    json: deps.jsonFlag,
  }).pipe(
    Command.withDescription(
      "Back up the database into <state dir>/backups (compacted, checked, zstd). Safe while Ryco runs.",
    ),
    Command.withHandler((flags) =>
      runDb(flags, (config) =>
        Effect.flatMap(loadDbRun, ({ runDbBackup }) =>
          runDbBackup({ config, json: flags.json, emitJson: deps.emitJson }),
        ),
      ),
    ),
  );

  const listCommand = Command.make("list", {
    ...deps.locationFlags,
    json: deps.jsonFlag,
  }).pipe(
    Command.withDescription(
      "List the database backups and whether this build can open each of them.",
    ),
    Command.withHandler((flags) =>
      runDb(flags, (config) =>
        Effect.flatMap(loadDbRun, ({ runDbList }) =>
          runDbList({ config, json: flags.json, emitJson: deps.emitJson }),
        ),
      ),
    ),
  );

  const restoreCommand = Command.make("restore", {
    ...deps.locationFlags,
    file: Argument.String("file").pipe(
      Argument.withDescription("The backup to restore (.sqlite, .sqlite.zst or .sqlite.gz)."),
    ),
    into: Flag.String("into").pipe(
      Flag.withDescription(
        "A new or empty directory to restore into, outside the data directory in use. It becomes a separate Ryco data directory (--base-dir).",
      ),
      Flag.optional,
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription(
        "Make the backup the database in use instead (Ryco must not be running). The replaced database and the session signing key are kept in <state dir>/replaced-<time>/, and every device signs out.",
      ),
      Flag.withDefault(false),
    ),
    fullCheck: Flag.Boolean("full-check").pipe(
      Flag.withDescription(
        "Run PRAGMA integrity_check instead of quick_check (much slower on large databases).",
      ),
      Flag.withDefault(false),
    ),
    json: deps.jsonFlag,
  }).pipe(
    Command.withDescription(
      "Restore a backup into a new data directory (--into), or make it the database in use (--replace), after checking it.",
    ),
    Command.withHandler((flags) =>
      runDb(flags, (config) =>
        Effect.flatMap(loadDbRun, ({ runDbRestore }) =>
          runDbRestore({
            config,
            json: flags.json,
            emitJson: deps.emitJson,
            file: flags.file,
            into: flags.into,
            replace: flags.replace,
            fullCheck: flags.fullCheck,
          }),
        ),
      ),
    ),
  );

  return Command.make("db").pipe(
    Command.withDescription(
      "Back up the database, list its backups, or restore one (into a new data directory, or in place).",
    ),
    Command.withSubcommands([backupCommand, listCommand, restoreCommand]),
  );
};
