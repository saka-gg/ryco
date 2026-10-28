/**
 * What `ryco db backup`, `list` and `restore` do once their flags are parsed and the data
 * directory is resolved. Loaded by `dbCommand.ts` with `import()` only when one of them runs, so
 * neither this module nor databaseBackups.ts is on the server's boot path (see
 * serverBundleBoundaries.test.ts).
 *
 * @module cliDb/dbRun
 */
import { Console, Effect, Path } from "effect";

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

export interface DbRunInput {
  readonly config: ServerConfigShape;
  readonly json: boolean;
  /** The one `--json` document form every command prints. */
  readonly emitJson: (value: unknown) => string;
}

export interface DbRestoreInput extends DbRunInput {
  readonly file: string;
  readonly into: string;
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

const formatRestore = (
  result: RestoreResult,
  live: { readonly stateDir: string; readonly secretsDir: string },
) =>
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
    "  file in as state.sqlite. That database accepts again what was revoked since the backup was",
    "  taken, so also move this file aside, which signs every device out (pair them again):",
    `    ${live.secretsDir}/server-signing-key.bin`,
    "  and revoke again any pairing link or integration you revoked since the backup.",
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

/** `ryco db restore <file> --into <dir>`. */
export const runDbRestore = (input: DbRestoreInput) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { config } = input;
    const intoBaseDir = path.resolve(yield* expandHomePath(input.into.trim()));
    const target = yield* deriveServerPaths(intoBaseDir, undefined);
    const result = yield* restoreDatabaseBackup({
      file: path.resolve(yield* expandHomePath(input.file.trim())),
      target: { baseDir: intoBaseDir, dbPath: target.dbPath },
      live: { baseDir: config.baseDir, stateDir: config.stateDir, dbPath: config.dbPath },
      openSqlite: makeRuntimeSqliteLayer,
      fullCheck: input.fullCheck,
    });
    yield* Console.log(input.json ? input.emitJson(result) : formatRestore(result, config));
  });
