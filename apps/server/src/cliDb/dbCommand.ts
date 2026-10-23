/**
 * `ryco db`: back up the database, list its backups, and restore one into a new data directory.
 *
 * None of these migrate or write the database in use, so they are safe while Ryco runs. They
 * open their own SQLite connections instead of the persistence layer, which would migrate.
 * See docs/database-backups.md.
 *
 * cli.ts passes in its location flags, `--json` flag and config resolution, so this module owns
 * the command and cli.ts only registers it.
 *
 * @module cliDb/dbCommand
 */
import { Console, Effect, type LogLevel, Option, Path, References } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import { deriveServerPaths, type ServerConfigShape } from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import {
  createManualBackup,
  describeDatabaseBackups,
  formatBytes,
  restoreDatabaseBackup,
  type ListedDatabaseBackup,
  type ManualBackupResult,
  type ManualBackupStep,
  type RestoreResult,
} from "../persistence/databaseBackups.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";

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

const stepText: Record<ManualBackupStep, string> = {
  copy: "Copying the database (VACUUM INTO)...",
  check: "Checking the copy (quick_check)...",
  compress: "Compressing the copy...",
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const pad = (value: number) => String(value).padStart(2, "0");
/** Local time, to the second. */
const formatLocalTime = (epochMs: number) => {
  const date = new Date(epochMs);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

const formatManualBackup = (result: ManualBackupResult) =>
  [
    `Backed up the database (schema ${result.schema}) to ${result.path}`,
    `${formatBytes(result.databaseBytes)} database, ${formatBytes(result.copyBytes)} compacted, ` +
      `${formatBytes(result.bytes)} compressed (${result.codec}). Copy ${seconds(result.copyMs)}, ` +
      `check ${seconds(result.checkMs)}, compression ${seconds(result.compressMs)}; ` +
      `${seconds(result.ms)} in total.`,
    ...(result.pruned.length > 0
      ? [`Removed older manual backups: ${result.pruned.join(", ")}`]
      : []),
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");

const describeKind = (backup: ListedDatabaseBackup) =>
  backup.kind === "manual"
    ? `manual, schema ${backup.from}`
    : backup.to === backup.from
      ? `before repairs, schema ${backup.from}`
      : `before upgrade ${backup.from} → ${backup.to}`;

const describeState = (backup: ListedDatabaseBackup) =>
  backup.state === "finalized"
    ? `compressed (${backup.codec})`
    : backup.state === "raw"
      ? "not compressed yet"
      : "failed its integrity check";

const formatBackupList = (listing: {
  readonly directory: string;
  readonly supportedSchema: number;
  readonly backups: ReadonlyArray<ListedDatabaseBackup>;
}) => {
  if (listing.backups.length === 0) return `No database backups in ${listing.directory}.`;
  const rows = listing.backups.map((backup) => ({
    backup,
    columns: [
      formatLocalTime(backup.createdAt),
      describeKind(backup),
      formatBytes(backup.bytes),
      describeState(backup),
    ],
  }));
  const widths = [0, 1, 2].map((index) =>
    Math.max(...rows.map((row) => row.columns[index]!.length)),
  );
  return [
    `Database backups in ${listing.directory} (this build opens schema ${listing.supportedSchema} and older):`,
    "",
    ...rows.flatMap(({ backup, columns }) => [
      `  ${columns.map((column, index) => (index < 3 ? column.padEnd(widths[index]!) : column)).join("  ")}` +
        (backup.opensWithThisBuild ? "" : "  needs a newer Ryco build"),
      `    ${backup.path}`,
    ]),
    "",
    "Restore one into a new directory with: ryco db restore <file> --into <new directory>",
  ].join("\n");
};

const backupJson = (backup: ListedDatabaseBackup) => ({
  name: backup.name,
  path: backup.path,
  kind: backup.kind,
  from: backup.from,
  to: backup.to,
  createdAt: new Date(backup.createdAt).toISOString(),
  bytes: backup.bytes,
  state: backup.state,
  codec: backup.codec,
  opensWithThisBuild: backup.opensWithThisBuild,
});

const formatRestore = (result: RestoreResult, live: { readonly stateDir: string }) =>
  [
    `Restored the database (schema ${result.schema}, ${result.check} ok) to ${result.path} ` +
      `(${formatBytes(result.bytes)}, ${seconds(result.ms)}).`,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
    "",
    "Next steps:",
    `  Start Ryco on it: ryco serve --base-dir ${result.baseDir}  (or RYCO_HOME=${result.baseDir})`,
    "  It has no settings, secrets or Hub identity, so pair your devices with it again.",
    `  To make it your main database instead: quit Ryco, move ${live.stateDir}/state.sqlite,`,
    "  state.sqlite-wal and state.sqlite-shm aside (do not delete them), and copy the restored",
    "  file in as state.sqlite.",
  ].join("\n");

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
        Effect.gen(function* () {
          const result = yield* createManualBackup({
            dbPath: config.dbPath,
            openSqlite: makeRuntimeSqliteLayer,
            // Progress on stderr, so stdout stays the result.
            onStep: flags.json ? undefined : (step) => Console.error(stepText[step]),
          });
          yield* Console.log(flags.json ? deps.emitJson(result) : formatManualBackup(result));
        }),
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
        Effect.gen(function* () {
          const listing = yield* describeDatabaseBackups(config.dbPath);
          yield* Console.log(
            flags.json
              ? deps.emitJson({ ...listing, backups: listing.backups.map(backupJson) })
              : formatBackupList(listing),
          );
        }),
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
      "Restore a backup into a new data directory, after checking it. Never touches the database in use.",
    ),
    Command.withHandler((flags) =>
      runDb(flags, (config) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const intoBaseDir = path.resolve(yield* expandHomePath(flags.into.trim()));
          const target = yield* deriveServerPaths(intoBaseDir, undefined);
          const result = yield* restoreDatabaseBackup({
            file: path.resolve(yield* expandHomePath(flags.file.trim())),
            target: { baseDir: intoBaseDir, dbPath: target.dbPath },
            live: { baseDir: config.baseDir, stateDir: config.stateDir, dbPath: config.dbPath },
            openSqlite: makeRuntimeSqliteLayer,
            fullCheck: flags.fullCheck,
          });
          yield* Console.log(
            flags.json
              ? deps.emitJson(result)
              : formatRestore(result, { stateDir: config.stateDir }),
          );
        }),
      ),
    ),
  );

  return Command.make("db").pipe(
    Command.withDescription(
      "Back up the database, list its backups, or restore one into a new data directory.",
    ),
    Command.withSubcommands([backupCommand, listCommand, restoreCommand]),
  );
};
