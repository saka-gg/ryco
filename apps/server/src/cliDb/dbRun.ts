/**
 * What `ryco db backup`, `list` and `restore` do once their flags are parsed and the data
 * directory is resolved. Loaded by `dbCommand.ts` with `import()` only when one of them runs, so
 * neither this module nor databaseBackups.ts is on the server's boot path (see
 * serverBundleBoundaries.test.ts).
 *
 * @module cliDb/dbRun
 */
import { Console, Effect, Option, Path } from "effect";

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
  DatabaseBackupCommandError,
} from "../persistence/databaseBackups.ts";
import { acquireDatabaseMaintenance } from "../persistence/databaseOwnerLock.ts";
import {
  replaceDatabaseWithBackup,
  type ReplaceResult,
} from "../persistence/databaseRestoreSwap.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";

export interface DbRunInput {
  readonly config: ServerConfigShape;
  readonly json: boolean;
  /** The one `--json` document form every command prints. */
  readonly emitJson: (value: unknown) => string;
}

export interface DbRestoreInput extends DbRunInput {
  readonly file: string;
  readonly into: Option.Option<string>;
  readonly replace: boolean;
  readonly fullCheck: boolean;
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
    "or, with Ryco stopped, in place of the database in use: ryco db restore <file> --replace",
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

const formatRestore = (result: RestoreResult, file: string) =>
  [
    `Restored the database (schema ${result.schema}, ${result.check} ok) to ${result.path} ` +
      `(${formatBytes(result.bytes)}, ${seconds(result.ms)}).`,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
    "",
    "Next steps:",
    `  Start Ryco on it: ryco serve --base-dir ${result.baseDir}  (or RYCO_HOME=${result.baseDir})`,
    "  It has no settings, secrets or Hub identity, so pair your devices with it again.",
    "  To make the backup your main database instead, quit Ryco and run:",
    `    ryco db restore ${file} --replace`,
    "  It keeps the database it replaces and signs every device out (the restored database",
    "  accepts again what was revoked since the backup was taken).",
  ].join("\n");

const formatReplace = (result: ReplaceResult) =>
  [
    `Restored the database (schema ${result.schema}, ${result.check} ok) in place of ${result.path} ` +
      `(${formatBytes(result.bytes)}, ${seconds(result.ms)}).`,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
    "",
    `The database it replaced${result.signedOut ? " and the session signing key were" : " was"} moved to:`,
    `  ${result.replacedDir}`,
    "Nothing was deleted. Next steps:",
    "  Start Ryco as usual.",
    ...(result.signedOut
      ? ["  Every device was signed out: pair your phones and other browsers again."]
      : []),
    "  The restored database accepts again what was revoked after the backup was taken: revoke",
    "  again any pairing link or integration you revoked since then.",
  ].join("\n");

/** `ryco db backup`. */
export const runDbBackup = (input: DbRunInput) =>
  Effect.gen(function* () {
    const result = yield* createManualBackup({
      dbPath: input.config.dbPath,
      openSqlite: makeRuntimeSqliteLayer,
      // Progress on stderr, so stdout stays the result.
      onStep: input.json ? undefined : (step) => Console.error(stepText[step]),
    });
    yield* Console.log(input.json ? input.emitJson(result) : formatManualBackup(result));
  });

/** `ryco db list`. */
export const runDbList = (input: DbRunInput) =>
  Effect.gen(function* () {
    const listing = yield* describeDatabaseBackups(input.config.dbPath);
    yield* Console.log(
      input.json
        ? input.emitJson({ ...listing, backups: listing.backups.map(backupJson) })
        : formatBackupList(listing),
    );
  });

/** `ryco db restore <file> --into <dir>` or `--replace`. */
export const runDbRestore = (input: DbRestoreInput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { config } = input;
    if (input.replace === Option.isSome(input.into)) {
      return yield* new DatabaseBackupCommandError({
        reason: "unsafe-target",
        message: input.replace
          ? "Use either --into <directory> or --replace, not both."
          : "Say where to restore: --into <new directory>, or --replace to make it the database in use.",
      });
    }
    const file = path.resolve(yield* expandHomePath(input.file.trim()));
    if (Option.isNone(input.into)) {
      // As the database's owner: no server can start while the database is swapped.
      const result = yield* Effect.scoped(
        acquireDatabaseMaintenance(config.dbPath, "restore the database from a backup").pipe(
          Effect.andThen(
            replaceDatabaseWithBackup({
              file,
              live: { baseDir: config.baseDir, stateDir: config.stateDir, dbPath: config.dbPath },
              openSqlite: makeRuntimeSqliteLayer,
              fullCheck: input.fullCheck,
              nowMs: Date.now(),
            }),
          ),
        ),
      );
      yield* Console.log(input.json ? input.emitJson(result) : formatReplace(result));
      return;
    }
    const intoBaseDir = path.resolve(yield* expandHomePath(input.into.value.trim()));
    const target = yield* deriveServerPaths(intoBaseDir, undefined);
    const result = yield* restoreDatabaseBackup({
      file,
      target: { baseDir: intoBaseDir, dbPath: target.dbPath },
      live: { baseDir: config.baseDir, stateDir: config.stateDir, dbPath: config.dbPath },
      openSqlite: makeRuntimeSqliteLayer,
      fullCheck: input.fullCheck,
    });
    yield* Console.log(input.json ? input.emitJson(result) : formatRestore(result, file));
  });
