// @effect-diagnostics nodeBuiltinImport:off - snapshots need clonefile/reflink copies, statfs, hard links, fsync and zstd streams, which Effect's FileSystem does not offer.
/**
 * Backups of the SQLite database taken before an upgrade changes it.
 *
 * Phase 1 runs on the startup path, before migrations: under SQLite's write lock
 * (`BEGIN IMMEDIATE`) it snapshots the database file and its WAL, by copy-on-write clone where
 * the filesystem has one (APFS, btrfs, xfs) and by a bounded full copy otherwise. Nobody can
 * append to or reset the WAL while the lock is held, so the copied pair is what a crash would
 * leave behind, and opening it is ordinary crash recovery. The copy is then folded into one
 * `journal_mode=delete` file and checked (ledger and page count) before migrations run.
 *
 * Phase 2 runs in the background 30 s later, in low-priority child processes: `PRAGMA
 * quick_check`, then zstd compression; then retention.
 *
 * Neither phase ever fails startup. A backup that cannot be made is skipped with a warning.
 * `VACUUM INTO` is deliberately not used here: it rewrites the whole database (6.8 s for 4.5 GB,
 * 16-30 s for 10 GB, measured), while a clone of 4.5 GB took 0.11-0.55 s and held the write lock
 * for under 10 ms. See docs/database-backups.md.
 *
 * Manual backups (`ryco db backup`) do use `VACUUM INTO`, on a read-only connection: it is a
 * consistent snapshot that never blocks a live server's writer, and its output is compacted.
 * Restores (`ryco db restore`) only ever write a new data directory, after checking the copy.
 *
 * @module databaseBackups
 */
import { execFile } from "node:child_process";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
} from "node:fs/promises";
import { setPriority } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

import { Clock, Context, Data, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import { syncDirectory, syncFile } from "../fsDurability.ts";
import { databaseBackupsDirectory, type PremigrationBackupMode } from "./databaseBackupPolicy.ts";
import {
  migrationEntries,
  SUPPORTED_MIGRATION_ID,
  type MigrationLedgerInspection,
} from "./Migrations.ts";

// What startup needs before it knows a backup is due lives in databaseBackupPolicy.ts, so that
// startup with nothing to migrate never loads this module. Re-exported: this is the backups API.
export {
  BACKUP_FINALIZE_DELAY,
  databaseBackupsDirectory,
  needsPremigrationBackup,
  type PremigrationBackupMode,
  readPremigrationBackupMode,
} from "./databaseBackupPolicy.ts";

/** Above this size a backup needs a copy-on-write clone; a full copy would stall startup. */
export const PREMIGRATION_FULL_COPY_MAX_BYTES = 2 * 1024 ** 3;
/** A restart within this window reuses an unchanged backup of the same upgrade. */
export const PREMIGRATION_BACKUP_DEDUPE_WINDOW_MS = 10 * 60_000;
/** Backups kept per kind (pre-upgrade, manual). */
export const BACKUP_RETENTION_PER_KIND = 3;
/** A backup needs this multiple of the live database's size free on disk. */
export const BACKUP_FREE_SPACE_FACTOR = 2;
/** Partials older than this are removed even when their pid looks alive (pid reuse). */
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60_000;
const COMPRESS_CHUNK_BYTES = 1024 * 1024;

export type BackupKind = "before" | "manual";
export type BackupCodec = "zst" | "gz";

/** Opens a SQLite connection (`makeRuntimeSqliteLayer`), injected to avoid an import cycle. */
export type OpenSqlite = (config: {
  readonly filename: string;
  readonly readonly?: boolean;
}) => Layer.Layer<SqlClient.SqlClient, SqlError>;

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * Every backup name. `from = 000` is a database without a migration ledger; `seq` only appears
 * when two backups were taken in the same millisecond; `-unverified` marks a backup that failed
 * `quick_check` and is kept, uncompressed and outside retention, as the only pre-upgrade copy.
 */
export const BACKUP_NAME_PATTERN =
  /^(?<stem>[A-Za-z0-9_.-]+?)-v(?<from>\d{3,})-(?:before-v(?<to>\d{3,})|manual)-(?<ts>\d{8}T\d{9}Z)(?:-(?<seq>\d+))?(?<unverified>-unverified)?\.sqlite(?:\.(?<codec>zst|gz))?$/;
/** In-progress files: `.<backup name>.<pid>.partial`, plus SQLite's sidecars while folding. */
const PARTIAL_PATTERN = /^\.(?<name>.+)\.(?<pid>\d+)\.partial(?<sidecar>-wal|-shm|-journal)?$/;

export interface BackupName {
  readonly stem: string;
  readonly from: number;
  /** The schema the upgrade moves to; `"manual"` for a manual backup. */
  readonly to: number | "manual";
  /** Creation time, epoch milliseconds (UTC). */
  readonly at: number;
  readonly seq?: number | undefined;
  readonly unverified?: boolean | undefined;
  readonly codec?: BackupCodec | null | undefined;
}

const formatVersion = (version: number) => String(version).padStart(3, "0");
const formatTimestamp = (at: number) => new Date(at).toISOString().replace(/[-:.]/g, "");
const parseTimestamp = (ts: string) =>
  Date.UTC(
    Number(ts.slice(0, 4)),
    Number(ts.slice(4, 6)) - 1,
    Number(ts.slice(6, 8)),
    Number(ts.slice(9, 11)),
    Number(ts.slice(11, 13)),
    Number(ts.slice(13, 15)),
    Number(ts.slice(15, 18)),
  );

/** The file stem for backups of `dbPath`: `state` for `state.sqlite`. */
export const backupStem = (dbPath: string) =>
  basename(dbPath)
    .replace(/\.sqlite$/, "")
    .replace(/[^A-Za-z0-9_.-]/g, "_") || "database";

export const formatBackupName = (name: BackupName): string =>
  `${name.stem}-v${formatVersion(name.from)}-` +
  (name.to === "manual" ? "manual" : `before-v${formatVersion(name.to)}`) +
  `-${formatTimestamp(name.at)}` +
  (name.seq !== undefined && name.seq > 1 ? `-${name.seq}` : "") +
  (name.unverified ? "-unverified" : "") +
  ".sqlite" +
  (name.codec ? `.${name.codec}` : "");

/** A parsed backup file name; `seq` is 1 when the name has no suffix. */
export interface ParsedBackupName extends BackupName {
  readonly seq: number;
  readonly unverified: boolean;
  readonly codec: BackupCodec | null;
}

export const parseBackupName = (fileName: string): ParsedBackupName | undefined => {
  const groups = BACKUP_NAME_PATTERN.exec(fileName)?.groups;
  if (groups === undefined) return undefined;
  const at = parseTimestamp(groups.ts!);
  if (!Number.isFinite(at)) return undefined;
  return {
    stem: groups.stem!,
    from: Number(groups.from),
    to: groups.to === undefined ? "manual" : Number(groups.to),
    at,
    seq: groups.seq === undefined ? 1 : Number(groups.seq),
    unverified: groups.unverified !== undefined,
    codec: (groups.codec as BackupCodec | undefined) ?? null,
  };
};

/** The name of a backup's file in another state (raw vs. compressed). */
const withCodec = (name: ParsedBackupName, codec: BackupCodec | null) =>
  formatBackupName({ ...name, codec });
const partialName = (fileName: string, pid: number) => `.${fileName}.${pid}.partial`;

// ---------------------------------------------------------------------------------------------
// Environment (test hook)
// ---------------------------------------------------------------------------------------------

export interface BackupStatFs {
  readonly type: number;
  readonly bavail: number;
  readonly bsize: number;
}

/** What `PRAGMA quick_check` and the ledger of a backup file say. */
export type QuickCheckReport =
  | { readonly _tag: "Ok"; readonly ledger: number }
  | { readonly _tag: "Damaged"; readonly lines: ReadonlyArray<string> }
  | { readonly _tag: "Failed"; readonly message: string };

/** The outcome of compressing a backup into a new file. */
export type CompressReport =
  | { readonly _tag: "Ok"; readonly bytes: number }
  | { readonly _tag: "Failed"; readonly message: string };

/** Platform primitives, replaceable in tests. */
export interface BackupEnvironment {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  /**
   * Runs `quick_check` on a backup file outside this process; null where that is not possible
   * (Bun has no `node:sqlite` for the child). Aborting the signal kills the check.
   */
  readonly quickCheck: ((path: string, signal: AbortSignal) => Promise<QuickCheckReport>) | null;
  /**
   * Compresses `from` into the new file `to` (created exclusively, mode 0600, flushed) outside
   * this process; null to compress in-process. Aborting the signal kills it.
   */
  readonly compressFile:
    | ((
        from: string,
        to: string,
        codec: BackupCodec,
        signal: AbortSignal,
      ) => Promise<CompressReport>)
    | null;
  readonly fullCopyMaxBytes: number;
  readonly statfs: (path: string) => Promise<BackupStatFs>;
  readonly deviceOf: (path: string) => Promise<number>;
  /**
   * A copy-on-write clone. On darwin `cp -c` falls back to a full copy by itself, so callers
   * check the volume first; on Linux this fails where the filesystem cannot reflink.
   */
  readonly cloneFile: (from: string, to: string, signal: AbortSignal) => Promise<void>;
  readonly copyFile: (from: string, to: string) => Promise<void>;
  readonly processAlive: (pid: number) => boolean;
}

const execFileAsync = promisify(execFile);

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Phase 2's child process: `check <file>` runs `quick_check` and reads the ledger; `compress
 * <from> <to> <codec>` streams a backup through zstd (level 1, frame checksum) or gzip (level 1).
 * CommonJS for `--eval`, ASCII only (the server bundle is kept Latin-1).
 *
 * A child, not a worker thread or the server itself: a worker cannot be stopped inside a long
 * SQLite statement, and process exit waits for it (minutes for a cold multi-GB file), while a
 * child is killed at once; and streaming gigabytes through the server's own buffers caused
 * 20-30 ms garbage-collection pauses on its event loop (measured), where a child causes none.
 */
const MAINTENANCE_CHILD_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const [command, ...args] = process.argv.slice(1);
const report = (value) => process.stdout.write(JSON.stringify(value));
if (command === "check") {
  const { DatabaseSync } = require("node:sqlite");
  try {
    const db = new DatabaseSync(args[0], { readOnly: true });
    try {
      const lines = db.prepare("PRAGMA quick_check").all().map((row) => String(Object.values(row)[0]));
      if (lines.length !== 1 || lines[0] !== "ok") {
        report({ _tag: "Damaged", lines: lines.slice(0, 5) });
      } else {
        const hasLedger = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'")
          .all().length > 0;
        const ledger = hasLedger
          ? Number(db.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get().id || 0)
          : 0;
        report({ _tag: "Ok", ledger });
      }
    } finally {
      db.close();
    }
  } catch (error) {
    const message = String(error && error.message);
    const code = error && typeof error.errcode === "number" ? error.errcode & 0xff : -1;
    // SQLITE_CORRUPT, SQLITE_NOTADB
    report(code === 11 || code === 26 || /malformed|not a database/i.test(message)
      ? { _tag: "Damaged", lines: [message] }
      : { _tag: "Failed", message });
  }
} else if (command === "compress") {
  const zlib = require("node:zlib");
  const { pipeline } = require("node:stream/promises");
  const [from, to, codec] = args;
  const compressor = codec === "zst"
    ? zlib.createZstdCompress({ params: {
        [zlib.constants.ZSTD_c_compressionLevel]: 1,
        [zlib.constants.ZSTD_c_checksumFlag]: 1,
      } })
    : zlib.createGzip({ level: 1 });
  pipeline(
    fs.createReadStream(from, { highWaterMark: 1024 * 1024 }),
    compressor,
    fs.createWriteStream(to, { flags: "wx", mode: 0o600 }),
  ).then(() => {
    const fd = fs.openSync(to, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    report({ _tag: "Ok", bytes: fs.statSync(to).size });
  }, (error) => report({ _tag: "Failed", message: String(error && error.message) }));
}
`;
/** A cold quick_check reads every page in b-tree order: about 2 min for 4.5 GB, measured. */
const MAINTENANCE_CHILD_TIMEOUT_MS = 60 * 60_000;

const runMaintenanceChild = <A>(args: ReadonlyArray<string>, signal: AbortSignal) =>
  new Promise<A | { readonly _tag: "Failed"; readonly message: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      ["--eval", MAINTENANCE_CHILD_SCRIPT, "--", ...args],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: undefined },
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: MAINTENANCE_CHILD_TIMEOUT_MS,
        killSignal: "SIGKILL",
        signal,
        windowsHide: true,
      },
      (error, stdout) => {
        try {
          resolve(JSON.parse(stdout) as A);
        } catch {
          resolve({ _tag: "Failed", message: error ? errorText(error) : "no report" });
        }
      },
    );
    // Background maintenance: interactive work goes first. Best effort.
    try {
      if (child.pid !== undefined) setPriority(child.pid, 10);
    } catch {
      // Not permitted or not supported here; the child still runs.
    }
  });

const nodeBackupEnvironment = (): BackupEnvironment => ({
  platform: process.platform,
  pid: process.pid,
  // Bun has no node:sqlite for the child, so it skips quick_check and compresses in-process.
  quickCheck:
    process.versions.bun === undefined
      ? (path, signal) => runMaintenanceChild<QuickCheckReport>(["check", path], signal)
      : null,
  compressFile:
    process.versions.bun === undefined
      ? (from, to, codec, signal) =>
          runMaintenanceChild<CompressReport>(["compress", from, to, codec], signal)
      : null,
  fullCopyMaxBytes: PREMIGRATION_FULL_COPY_MAX_BYTES,
  statfs: (path) => statfs(path),
  deviceOf: async (path) => (await stat(path)).dev,
  cloneFile: async (from, to, signal) => {
    if (process.platform === "darwin") {
      // clonefile(2); Node's COPYFILE_FICLONE does a full copy on macOS (libuv).
      await execFileAsync("/bin/cp", ["-c", from, to], { signal });
      return;
    }
    await copyFile(from, to, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
  },
  copyFile: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  processAlive,
});

export const BackupEnvironment = Context.Reference<BackupEnvironment>(
  "ryco/persistence/databaseBackups/BackupEnvironment",
  { defaultValue: nodeBackupEnvironment },
);

// ---------------------------------------------------------------------------------------------
// Listing, cleanup and retention
// ---------------------------------------------------------------------------------------------

export interface DatabaseBackup {
  readonly name: string;
  readonly path: string;
  readonly kind: BackupKind;
  readonly from: number;
  /** The schema the upgrade moved to; null for manual backups. */
  readonly to: number | null;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly seq: number;
  readonly bytes: number;
  /** `raw`: a plain SQLite file, not yet compressed. `unverified`: failed `quick_check`. */
  readonly state: "raw" | "finalized" | "unverified";
  readonly codec: BackupCodec | null;
}

export class DatabaseBackupError extends Data.TaggedError("DatabaseBackupError")<{
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `${this.operation} ${this.path}: ${errorText(this.cause)}`;
  }
}

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
const errorCode = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code;

const io = <A>(operation: string, path: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DatabaseBackupError({ operation, path, cause }),
  });

const fileSize = (path: string) =>
  io("stat", path, async () => {
    try {
      return (await stat(path)).size;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    }
  });

const removeFile = (path: string) => io("remove", path, () => rm(path, { force: true }));

/** Backups of `dbPath`, newest first. Files that do not match the name grammar are ignored. */
export const listDatabaseBackups = Effect.fn("listDatabaseBackups")(function* (dbPath: string) {
  const directory = databaseBackupsDirectory(dbPath);
  const stem = backupStem(dbPath);
  const names = yield* io("list", directory, async () => {
    try {
      return await readdir(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  });
  const backups: DatabaseBackup[] = [];
  for (const name of names) {
    const parsed = parseBackupName(name);
    if (parsed === undefined || parsed.stem !== stem) continue;
    const path = join(directory, name);
    const info = yield* io("stat", path, () => lstat(path)).pipe(Effect.option);
    if (Option.isNone(info) || !info.value.isFile()) continue;
    backups.push({
      name,
      path,
      kind: parsed.to === "manual" ? "manual" : "before",
      from: parsed.from,
      to: parsed.to === "manual" ? null : parsed.to,
      createdAt: parsed.at,
      seq: parsed.seq,
      bytes: info.value.size,
      state: parsed.unverified ? "unverified" : parsed.codec === null ? "raw" : "finalized",
      codec: parsed.codec,
    });
  }
  return backups.toSorted(
    (left, right) =>
      right.createdAt - left.createdAt ||
      right.seq - left.seq ||
      // A raw file and its compressed twin are one backup; list the finished one first.
      Number(right.codec !== null) - Number(left.codec !== null),
  );
});

/** Partials this process is still writing. Cleanup never removes them. */
const inFlightPartials = new Set<string>();
const basePartialPath = (path: string) => path.replace(/-(?:wal|shm|journal)$/, "");

/**
 * Removes in-progress files left by a crash: those whose pid is dead, this process's own that it
 * is not writing, and any untouched for a day. Nothing outside the name grammar is touched.
 */
export const cleanStaleBackupPartials = Effect.fn("cleanStaleBackupPartials")(function* (
  dbPath: string,
) {
  const env = yield* BackupEnvironment;
  const now = yield* Clock.currentTimeMillis;
  const directory = databaseBackupsDirectory(dbPath);
  const names = yield* io("list", directory, async () => {
    try {
      return await readdir(directory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  });
  let removed = 0;
  for (const name of names) {
    const groups = PARTIAL_PATTERN.exec(name)?.groups;
    if (groups === undefined || parseBackupName(groups.name!) === undefined) continue;
    const path = join(directory, name);
    if (inFlightPartials.has(basePartialPath(path))) continue;
    const pid = Number(groups.pid);
    const info = yield* io("stat", path, () => lstat(path)).pipe(Effect.option);
    if (Option.isNone(info) || !info.value.isFile()) continue;
    // ctime, not mtime alone: a clone keeps the database's mtime (days old, say), so a partial
    // another live process cloned a moment ago would otherwise look abandoned.
    const touchedAt = Math.max(info.value.mtimeMs, info.value.ctimeMs);
    const stale =
      pid === env.pid || !env.processAlive(pid) || now - touchedAt > STALE_PARTIAL_AGE_MS;
    if (!stale) continue;
    yield* removeFile(path);
    removed += 1;
  }
  if (removed > 0) yield* Effect.logDebug(`Removed ${removed} unfinished database backup files`);
  return removed;
});

/**
 * Keeps the newest {@link BACKUP_RETENTION_PER_KIND} backups of each kind. A raw file and its
 * compressed twin count as one backup. `keep` (the backup just written) is never removed, and
 * neither are unverified backups, nor the newest backup taken before a numbered migration.
 */
export const pruneDatabaseBackups = Effect.fn("pruneDatabaseBackups")(function* (
  dbPath: string,
  options: {
    readonly keep?: string | undefined;
    /** The kinds to prune; both when undefined. */
    readonly kinds?: ReadonlyArray<BackupKind> | undefined;
  } = {},
) {
  const backups = (yield* listDatabaseBackups(dbPath)).filter(
    (backup) => backup.state !== "unverified",
  );
  const identity = (backup: DatabaseBackup) => withCodec(parseBackupName(backup.name)!, null);
  const keep = options.keep === undefined ? undefined : basename(options.keep);
  // Backups before a repair-only upgrade (from = to) never push out the one restore point of the
  // last schema change: a repair that fails part-way restarts in a loop, and every restart that
  // finds the database changed takes another such backup.
  const newestSchemaUpgrade = backups.find(
    (backup) => backup.kind === "before" && backup.to !== backup.from,
  );
  const protectedIdentities = new Set([
    ...(keep === undefined ? [] : [withCodec(parseBackupName(keep)!, null)]),
    ...(newestSchemaUpgrade === undefined ? [] : [identity(newestSchemaUpgrade)]),
  ]);
  const removed: string[] = [];
  for (const kind of options.kinds ?? (["before", "manual"] as const)) {
    const identities = [...new Set(backups.filter((backup) => backup.kind === kind).map(identity))];
    const expired = new Set(
      identities
        .slice(BACKUP_RETENTION_PER_KIND)
        .filter((candidate) => !protectedIdentities.has(candidate)),
    );
    for (const backup of backups) {
      if (backup.kind !== kind || !expired.has(identity(backup))) continue;
      yield* removeFile(backup.path);
      removed.push(backup.name);
    }
  }
  if (removed.length > 0) {
    yield* syncBackupsDirectory(dbPath);
    yield* Effect.logInfo(`Removed old database backups: ${removed.join(", ")}`);
  }
  return removed;
});

const syncBackupsDirectory = (dbPath: string) => {
  const directory = databaseBackupsDirectory(dbPath);
  return io("sync", directory, () => syncDirectory(directory));
};

/**
 * Moves a finished file to the first free name of `targets` without ever replacing an existing
 * file: a hard link fails when the name is taken. Filesystems without hard links fall back to a
 * checked rename. Undefined when every name is taken (the partial stays for the caller).
 */
const publishWithoutReplacing = (partial: string, targets: ReadonlyArray<string>) =>
  io("publish", partial, async (): Promise<string | undefined> => {
    for (const target of targets) {
      try {
        await link(partial, target);
        await rm(partial, { force: true });
        return target;
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        const taken = await lstat(target).then(
          () => true,
          (statError: unknown) => errorCode(statError) !== "ENOENT",
        );
        if (taken) continue;
        await rename(partial, target);
        return target;
      }
    }
    return undefined;
  });

/** Publishes under `name`, adding `-2`, `-3`, ... when that millisecond's name is taken. */
const publishBackup = (partial: string, directory: string, name: BackupName) =>
  publishWithoutReplacing(
    partial,
    Array.from({ length: 99 }, (_, index) =>
      join(directory, formatBackupName({ ...name, seq: index + 1 })),
    ),
  ).pipe(
    Effect.flatMap((target) =>
      target === undefined
        ? Effect.fail(
            new DatabaseBackupError({
              operation: "publish",
              path: partial,
              cause: "no free backup name",
            }),
          )
        : Effect.succeed(target),
    ),
  );

const restrictToOwner = (path: string) =>
  io("chmod", path, () => (process.platform === "win32" ? Promise.resolve() : chmod(path, 0o600)));

// ---------------------------------------------------------------------------------------------
// Phase 1: the snapshot before migrations
// ---------------------------------------------------------------------------------------------

export type SnapshotSkipReason =
  | "insufficient-space"
  | "no-clone-large"
  | "copy-failed"
  | "verify-failed"
  | "already-migrated"
  | "lock-busy"
  | "unexpected";

export type SnapshotOutcome =
  | {
      readonly _tag: "Written";
      readonly path: string;
      readonly method: "clone" | "copy";
      /** Live database bytes copied (main file plus WAL). */
      readonly bytes: number;
      /** WAL bytes copied with the main file; 0 when the checkpoint emptied it. */
      readonly walBytes: number;
      readonly ms: number;
      /** How long other writers had to wait: the write lock was held this long. */
      readonly lockMs: number;
      /** Time spent unsharing a clone's extents from the database (clones only). */
      readonly unshareMs: number;
    }
  | { readonly _tag: "Reused"; readonly path: string }
  | { readonly _tag: "Skipped"; readonly reason: SnapshotSkipReason; readonly detail: string };

class BackupSkip extends Data.TaggedError("BackupSkip")<{
  readonly reason: SnapshotSkipReason;
  readonly detail: string;
}> {}

/** A size in decimal units (1 GB = 10^9 bytes), for log lines and command output. */
export const formatBytes = (bytes: number) => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
};

const firstRow = <A>(rows: ReadonlyArray<A>): A | undefined => rows[0];

const queryNumber = (
  run: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
  statement: string,
) =>
  Effect.map(run(statement), (rows) => {
    const value = Object.values(firstRow(rows) ?? {})[0];
    return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
  });

/** The database has a migration ledger (`effect_sql_migrations`). */
const hasLedgerTable = (
  run: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
) =>
  Effect.map(
    run("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'"),
    (rows) => rows.length > 0,
  );

/** The highest recorded migration of a database, 0 without a ledger. */
const readLedgerVersion = (
  run: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
) =>
  Effect.gen(function* () {
    return (yield* hasLedgerTable(run))
      ? yield* queryNumber(run, "SELECT max(migration_id) AS id FROM effect_sql_migrations")
      : 0;
  });

/**
 * Cheap evidence that a database's content changed: the ledger, the schema cookie, the page
 * and free-page counts, and every AUTOINCREMENT counter (the event store's sequence among them,
 * which any chat activity advances). An in-place update of a row elsewhere can go unnoticed;
 * dedupe only reuses backups younger than {@link PREMIGRATION_BACKUP_DEDUPE_WINDOW_MS}.
 */
const contentFingerprint = (
  run: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
) =>
  Effect.gen(function* () {
    const ledger = yield* readLedgerVersion(run);
    const hasCounters =
      (yield* run("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'"))
        .length > 0;
    const counters = hasCounters
      ? (yield* run("SELECT name, seq FROM sqlite_sequence ORDER BY name"))
          .map((row) => `${String(row.name)}=${String(row.seq)}`)
          .join(",")
      : "";
    const schemaVersion = yield* queryNumber(run, "PRAGMA schema_version");
    const pageCount = yield* queryNumber(run, "PRAGMA page_count");
    const freePages = yield* queryNumber(run, "PRAGMA freelist_count");
    return `${ledger}|${schemaVersion}|${pageCount}|${freePages}|${counters}`;
  });

const clientRunner =
  (client: SqlClient.SqlClient) =>
  (statement: string): Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError> =>
    client.unsafe<Record<string, unknown>>(statement);

/** The newest pre-upgrade backup, when it is raw, recent, of this upgrade, and unchanged since. */
const findReusableBackup = Effect.fn("findReusableBackup")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly dbPath: string;
  readonly from: number;
  readonly to: number;
  readonly openSqlite: OpenSqlite;
}) {
  const now = yield* Clock.currentTimeMillis;
  const newest = (yield* listDatabaseBackups(input.dbPath)).find(
    (backup) => backup.kind === "before" && backup.state !== "unverified",
  );
  if (
    newest === undefined ||
    newest.state !== "raw" ||
    newest.from !== input.from ||
    newest.to !== input.to ||
    now - newest.createdAt < 0 ||
    now - newest.createdAt >= PREMIGRATION_BACKUP_DEDUPE_WINDOW_MS
  ) {
    return undefined;
  }
  const live = yield* contentFingerprint(clientRunner(input.sql));
  const saved = yield* Effect.gen(function* () {
    return yield* contentFingerprint(clientRunner(yield* SqlClient.SqlClient));
  }).pipe(Effect.provide(input.openSqlite({ filename: newest.path, readonly: true })));
  return live === saved ? newest : undefined;
});

/**
 * A full checkpoint, so the snapshot usually copies no WAL. Best effort: with the busy handler
 * off it never waits, and a reader pinned on an old snapshot only leaves frames in the WAL,
 * which the snapshot then copies.
 */
const checkpointBeforeSnapshot = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const previous = yield* queryNumber(clientRunner(sql), "PRAGMA busy_timeout");
    yield* sql
      .unsafe("PRAGMA busy_timeout = 0")
      .pipe(
        Effect.andThen(sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)")),
        Effect.ensuring(Effect.ignore(sql.unsafe(`PRAGMA busy_timeout = ${previous}`))),
      );
  }).pipe(Effect.ignore);

/** A darwin volume that can clone: APFS (the boot volume's type) and the database's device. */
const darwinCanClone = (env: BackupEnvironment, dbPath: string, backupsDir: string) =>
  Effect.promise(async () => {
    try {
      const [target, root, dbDevice, backupsDevice] = await Promise.all([
        env.statfs(backupsDir),
        env.statfs("/"),
        env.deviceOf(dbPath),
        env.deviceOf(backupsDir),
      ]);
      return target.type === root.type && dbDevice === backupsDevice;
    } catch {
      return false;
    }
  });

/** Copies one file of the snapshot by the cheapest method allowed. */
const snapshotFile = (input: {
  readonly env: BackupEnvironment;
  readonly from: string;
  readonly to: string;
  readonly allowFullCopy: boolean;
  readonly darwinClone: boolean;
}) =>
  Effect.gen(function* () {
    const { env, from, to, allowFullCopy } = input;
    const fullCopy = Effect.gen(function* () {
      if (!allowFullCopy) {
        return yield* new BackupSkip({
          reason: "no-clone-large",
          detail: `this filesystem cannot clone files, and a full copy over ${formatBytes(env.fullCopyMaxBytes)} would delay startup`,
        });
      }
      yield* io("copy", from, () => env.copyFile(from, to));
      return "copy" as const;
    });
    if (env.platform === "darwin") {
      if (!input.darwinClone) return yield* fullCopy;
      yield* io("clone", from, (signal) => env.cloneFile(from, to, signal));
      return "clone" as const;
    }
    if (env.platform === "linux") {
      const cloned = yield* io("clone", from, (signal) => env.cloneFile(from, to, signal)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.as(removeFile(to), false)),
      );
      if (cloned) return "clone" as const;
    }
    return yield* fullCopy;
  }).pipe(
    Effect.catchTag("DatabaseBackupError", (error) =>
      Effect.fail(new BackupSkip({ reason: "copy-failed", detail: error.message })),
    ),
  );

const executeOn = (conn: Connection, statement: string) =>
  conn.executeUnprepared(statement, [], undefined) as Effect.Effect<
    ReadonlyArray<Record<string, unknown>>,
    SqlError
  >;

/** Snapshots the database and its WAL while holding SQLite's write lock. */
const copyUnderWriteLock = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly env: BackupEnvironment;
  readonly dbPath: string;
  readonly partial: string;
  readonly ledger: MigrationLedgerInspection;
  readonly mode: PremigrationBackupMode;
  readonly darwinClone: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* input.sql.reserve;
      yield* Effect.acquireRelease(executeOn(conn, "BEGIN IMMEDIATE"), () =>
        Effect.ignore(executeOn(conn, "ROLLBACK")),
      );
      // Waiting for the lock above is not holding it.
      const lockedAt = performance.now();
      const latest = yield* readLedgerVersion((statement) => executeOn(conn, statement));
      if (latest !== input.ledger.latestApplied) {
        return yield* new BackupSkip({
          reason: "already-migrated",
          detail: `another process moved the schema from ${input.ledger.latestApplied} to ${latest} meanwhile`,
        });
      }
      const dbBytes = yield* fileSize(input.dbPath);
      const walBytes = yield* fileSize(`${input.dbPath}-wal`);
      const allowFullCopy =
        input.mode === "always" || dbBytes + walBytes <= input.env.fullCopyMaxBytes;
      const method = yield* snapshotFile({
        env: input.env,
        from: input.dbPath,
        to: input.partial,
        allowFullCopy,
        darwinClone: input.darwinClone,
      });
      if (walBytes > 0) {
        // Never -shm: SQLite rebuilds the index from the WAL when it opens the copy.
        yield* snapshotFile({
          env: input.env,
          from: `${input.dbPath}-wal`,
          to: `${input.partial}-wal`,
          allowFullCopy: true,
          darwinClone: input.darwinClone,
        });
      }
      return { method, dbBytes, walBytes, lockedAt };
    }),
  ).pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.fail(
          new BackupSkip({
            reason: error.reason._tag.endsWith("LockTimeoutError") ? "lock-busy" : "unexpected",
            detail: error.message,
          }),
        ),
      DatabaseBackupError: (error) =>
        Effect.fail(new BackupSkip({ reason: "copy-failed", detail: error.message })),
    }),
  );

/**
 * Writes the copy's first page back unchanged, on the libuv pool. After a copy-on-write clone,
 * the first write to either file pays for splitting their shared extents (0.1-0.5 s for a
 * 4.5 GB database on APFS, measured). Without this, the fold's synchronous SQLite writes, or
 * the migration's, would pay it on the event loop.
 */
const absorbCloneSplit = (path: string) =>
  io("touch", path, async () => {
    const file = await open(path, "r+");
    try {
      const page = Buffer.alloc(4096);
      const { bytesRead } = await file.read(page, 0, page.length, 0);
      if (bytesRead > 0) await file.write(page, 0, bytesRead, 0);
    } finally {
      await file.close();
    }
  });

/** Replays the copied WAL into the main file, leaves one `journal_mode=delete` file, checks it. */
const foldAndVerify = (input: {
  readonly partial: string;
  readonly expectedLedger: number;
  readonly openSqlite: OpenSqlite;
}) =>
  Effect.gen(function* () {
    const shape = yield* Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient;
      const run = clientRunner(client);
      yield* run("PRAGMA wal_checkpoint(TRUNCATE)");
      const journal = String(
        Object.values(firstRow(yield* run("PRAGMA journal_mode = DELETE")) ?? {})[0],
      );
      const ledger = yield* readLedgerVersion(run);
      const pageCount = yield* queryNumber(run, "PRAGMA page_count");
      const pageSize = yield* queryNumber(run, "PRAGMA page_size");
      return { journal, ledger, pageCount, pageSize };
    }).pipe(Effect.provide(input.openSqlite({ filename: input.partial })));
    for (const sidecar of ["-wal", "-shm", "-journal"]) {
      yield* removeFile(`${input.partial}${sidecar}`);
    }
    const bytes = yield* fileSize(input.partial);
    const problems = [
      shape.journal.toLowerCase() === "delete" ? null : `journal_mode is ${shape.journal}`,
      shape.ledger === input.expectedLedger
        ? null
        : `schema ${shape.ledger} in the copy, ${input.expectedLedger} in the database`,
      bytes === shape.pageCount * shape.pageSize
        ? null
        : `file size ${bytes} differs from ${shape.pageCount} pages of ${shape.pageSize} bytes`,
    ].filter((problem): problem is string => problem !== null);
    if (problems.length > 0) {
      return yield* new BackupSkip({
        reason: "verify-failed",
        detail: `the copy does not match the database: ${problems.join("; ")}`,
      });
    }
    return bytes;
  }).pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.fail(new BackupSkip({ reason: "verify-failed", detail: error.message })),
      DatabaseBackupError: (error) =>
        Effect.fail(new BackupSkip({ reason: "verify-failed", detail: error.message })),
    }),
  );

const takeSnapshot = Effect.fn("takeSnapshot")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly dbPath: string;
  readonly ledger: MigrationLedgerInspection;
  readonly mode: PremigrationBackupMode;
  readonly openSqlite: OpenSqlite;
}) {
  const env = yield* BackupEnvironment;
  const startedAt = performance.now();
  const backupsDir = databaseBackupsDirectory(input.dbPath);
  const from = input.ledger.latestApplied;
  const to = input.ledger.supported;
  const unexpected = (error: DatabaseBackupError) =>
    new BackupSkip({ reason: "unexpected", detail: error.message });

  yield* io("mkdir", backupsDir, () => mkdir(backupsDir, { recursive: true, mode: 0o700 })).pipe(
    Effect.mapError(unexpected),
  );
  yield* cleanStaleBackupPartials(input.dbPath).pipe(Effect.ignore);

  const reusable = yield* findReusableBackup({ ...input, from, to }).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (reusable !== undefined) return { _tag: "Reused", path: reusable.path } as SnapshotOutcome;

  // Space: a clone needs almost none at first, but the database will diverge from it.
  const liveBytes =
    (yield* fileSize(input.dbPath).pipe(Effect.mapError(unexpected))) +
    (yield* fileSize(`${input.dbPath}-wal`).pipe(Effect.mapError(unexpected)));
  const space = yield* Effect.promise(() => env.statfs(backupsDir).catch(() => undefined));
  if (space !== undefined && space.bavail * space.bsize < BACKUP_FREE_SPACE_FACTOR * liveBytes) {
    return yield* new BackupSkip({
      reason: "insufficient-space",
      detail: `${formatBytes(space.bavail * space.bsize)} free, ${formatBytes(BACKUP_FREE_SPACE_FACTOR * liveBytes)} needed for a ${formatBytes(liveBytes)} database`,
    });
  }
  const darwinClone =
    env.platform === "darwin" ? yield* darwinCanClone(env, input.dbPath, backupsDir) : false;

  const createdAt = yield* Clock.currentTimeMillis;
  const name = { stem: backupStem(input.dbPath), from, to, at: createdAt } satisfies BackupName;
  const partial = join(backupsDir, partialName(formatBackupName(name), env.pid));
  inFlightPartials.add(partial);
  const discardPartial = Effect.forEach(["", "-wal", "-shm", "-journal"], (suffix) =>
    Effect.ignore(removeFile(`${partial}${suffix}`)),
  );

  return yield* Effect.gen(function* () {
    yield* checkpointBeforeSnapshot(input.sql);
    const copied = yield* copyUnderWriteLock({ ...input, env, partial, darwinClone });
    const lockMs = Math.round(performance.now() - copied.lockedAt);
    const unshareStartedAt = performance.now();
    if (copied.method === "clone") {
      yield* absorbCloneSplit(partial).pipe(Effect.mapError(unexpected));
    }
    const unshareMs = Math.round(performance.now() - unshareStartedAt);
    yield* foldAndVerify({ partial, expectedLedger: from, openSqlite: input.openSqlite });
    yield* restrictToOwner(partial).pipe(Effect.mapError(unexpected));
    yield* io("sync", partial, () => syncFile(partial)).pipe(Effect.mapError(unexpected));
    const path = yield* publishBackup(partial, backupsDir, name).pipe(Effect.mapError(unexpected));
    yield* syncBackupsDirectory(input.dbPath).pipe(Effect.ignore);
    yield* pruneDatabaseBackups(input.dbPath, { keep: path }).pipe(Effect.ignore);
    return {
      _tag: "Written",
      path,
      method: copied.method,
      bytes: copied.dbBytes + copied.walBytes,
      walBytes: copied.walBytes,
      ms: Math.round(performance.now() - startedAt),
      lockMs,
      unshareMs,
    } as SnapshotOutcome;
  }).pipe(
    Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : discardPartial)),
    Effect.ensuring(Effect.sync(() => inFlightPartials.delete(partial))),
  );
});

const describeUpgrade = (ledger: MigrationLedgerInspection) =>
  ledger.pending.length > 0
    ? `schema ${ledger.latestApplied} → ${Math.max(...ledger.pending)}`
    : `schema ${ledger.latestApplied}, ${ledger.repairsPending.length} new repairs`;

/**
 * Phase 1: a restorable snapshot of `dbPath` before pending migrations or repairs run. Never
 * fails: when no backup can be made, it says why and startup continues.
 */
export const snapshotBeforeMigration = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly dbPath: string;
  readonly ledger: MigrationLedgerInspection;
  readonly mode: PremigrationBackupMode;
  readonly openSqlite: OpenSqlite;
}): Effect.Effect<SnapshotOutcome> =>
  takeSnapshot(input).pipe(
    Effect.catchTag("BackupSkip", (skip) =>
      Effect.succeed<SnapshotOutcome>({
        _tag: "Skipped",
        reason: skip.reason,
        detail: skip.detail,
      }),
    ),
    Effect.catchDefect((defect) =>
      Effect.succeed<SnapshotOutcome>({
        _tag: "Skipped",
        reason: "unexpected",
        detail: errorText(defect),
      }),
    ),
    Effect.tap((outcome) => {
      const upgrade = describeUpgrade(input.ledger);
      switch (outcome._tag) {
        case "Written":
          return Effect.logInfo(
            `Backed up the database before upgrading it (${upgrade}): ${outcome.path} (${formatBytes(outcome.bytes)}, ${outcome.method}, ${outcome.ms} ms; write lock held ${outcome.lockMs} ms${outcome.method === "clone" ? `, unsharing the clone ${outcome.unshareMs} ms` : ""})`,
          );
        case "Reused":
          return Effect.logInfo(
            `Reusing the unchanged database backup taken before this upgrade (${upgrade}): ${outcome.path}`,
          );
        case "Skipped":
          return outcome.reason === "already-migrated"
            ? Effect.logInfo(`No database backup needed: ${outcome.detail}`)
            : Effect.logWarning(
                `Upgrading the database without a backup (${upgrade}): ${outcome.detail}. See docs/database-backups.md to back it up yourself.`,
              ).pipe(Effect.annotateLogs({ reason: outcome.reason }));
      }
    }),
  );

// ---------------------------------------------------------------------------------------------
// Phase 2: verify, compress, prune (background)
// ---------------------------------------------------------------------------------------------

const finalizingDirectories = new Set<string>();

type CheckResult =
  | {
      readonly _tag: "Ok";
      readonly ledger: number;
      readonly checked: boolean;
      readonly ms: number;
    }
  | { readonly _tag: "Damaged"; readonly lines: ReadonlyArray<string> };

/** `quick_check` and the ledger of a raw backup, outside the server's event loop. */
const checkRawBackup = (input: {
  readonly path: string;
  readonly env: BackupEnvironment;
  readonly openSqlite: OpenSqlite;
}) =>
  Effect.gen(function* () {
    const startedAt = performance.now();
    const quickCheck = input.env.quickCheck;
    if (quickCheck !== null) {
      const report = yield* io("quick_check", input.path, (signal) =>
        quickCheck(input.path, signal),
      );
      if (report._tag === "Failed") {
        return yield* new DatabaseBackupError({
          operation: "quick_check",
          path: input.path,
          cause: report.message,
        });
      }
      if (report._tag === "Damaged") return report as CheckResult;
      return {
        _tag: "Ok",
        ledger: report.ledger,
        checked: true,
        ms: Math.round(performance.now() - startedAt),
      } as CheckResult;
    }
    // Without a child (Bun) only the ledger is read: one small query on the main thread.
    const ledger = yield* Effect.gen(function* () {
      return yield* readLedgerVersion(clientRunner(yield* SqlClient.SqlClient));
    }).pipe(Effect.provide(input.openSqlite({ filename: input.path, readonly: true })));
    return { _tag: "Ok", ledger, checked: false, ms: 0 } as CheckResult;
  });

const supportsZstd = typeof zlib.createZstdCompress === "function";

/** The codec new backups are compressed with: zstd where the runtime has it, else gzip. */
const preferredCodec = (): BackupCodec => (supportsZstd ? "zst" : "gz");

const compressStream = (codec: BackupCodec) =>
  codec === "zst"
    ? zlib.createZstdCompress({
        params: {
          [zlib.constants.ZSTD_c_compressionLevel]: 1,
          [zlib.constants.ZSTD_c_checksumFlag]: 1,
        },
      })
    : zlib.createGzip({ level: 1 });

/**
 * Compresses `from` into the new file `to` (created exclusively, mode 0600) in this process:
 * zstd level 1 with a frame checksum, or gzip level 1. The caller flushes and publishes it.
 */
const compressInProcess = (from: string, to: string, codec: BackupCodec) =>
  io("compress", from, (signal) =>
    pipeline(
      createReadStream(from, { highWaterMark: COMPRESS_CHUNK_BYTES }),
      compressStream(codec),
      createWriteStream(to, { flags: "wx", mode: 0o600 }),
      { signal },
    ),
  );

const exists = (path: string) =>
  io("stat", path, () =>
    lstat(path).then(
      () => true,
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      },
    ),
  );

/**
 * Removes a raw backup whose compressed file (either codec) already exists: a stop between
 * publishing it and removing the raw file, or another process that finished it first. The
 * compressed file is complete once it has its name.
 */
const dropIfFinalized = (input: { readonly backup: DatabaseBackup; readonly dbPath: string }) =>
  Effect.gen(function* () {
    const parsed = parseBackupName(input.backup.name)!;
    for (const codec of ["zst", "gz"] as const) {
      if (!(yield* exists(join(dirname(input.backup.path), withCodec(parsed, codec))))) continue;
      yield* removeFile(input.backup.path);
      yield* syncBackupsDirectory(input.dbPath);
      return true;
    }
    return false;
  });

/** Compresses one verified raw backup and replaces it with the compressed file. */
const compressRawBackup = (input: {
  readonly backup: DatabaseBackup;
  readonly env: BackupEnvironment;
  readonly dbPath: string;
}) =>
  Effect.gen(function* () {
    const { backup, env } = input;
    const directory = dirname(backup.path);
    const codec = preferredCodec();
    const finalName = withCodec(parseBackupName(backup.name)!, codec);
    const finalPath = join(directory, finalName);
    const partial = join(directory, partialName(finalName, env.pid));
    inFlightPartials.add(partial);
    const startedAt = performance.now();
    const compressFile = env.compressFile;
    const published = yield* Effect.gen(function* () {
      if (compressFile !== null) {
        const report = yield* io("compress", backup.path, (signal) =>
          compressFile(backup.path, partial, codec, signal),
        );
        if (report._tag === "Failed") {
          return yield* new DatabaseBackupError({
            operation: "compress",
            path: backup.path,
            cause: report.message,
          });
        }
      } else {
        yield* compressInProcess(backup.path, partial, codec);
      }
      yield* restrictToOwner(partial);
      yield* io("sync", partial, () => syncFile(partial));
      // Undefined when another process published the same backup meanwhile.
      return yield* publishWithoutReplacing(partial, [finalPath]);
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success" && exit.value !== undefined
          ? Effect.void
          : Effect.ignore(removeFile(partial)),
      ),
      Effect.ensuring(Effect.sync(() => inFlightPartials.delete(partial))),
    );
    yield* syncBackupsDirectory(input.dbPath);
    yield* removeFile(backup.path);
    yield* syncBackupsDirectory(input.dbPath);
    if (published === undefined) return undefined;
    return {
      path: finalPath,
      codec,
      bytes: yield* fileSize(finalPath),
      ms: Math.round(performance.now() - startedAt),
    };
  });

const finalizeOne = (input: {
  readonly backup: DatabaseBackup;
  readonly env: BackupEnvironment;
  readonly dbPath: string;
  readonly openSqlite: OpenSqlite;
}) =>
  Effect.gen(function* () {
    const { backup, env } = input;
    // Before the check, which takes minutes for a large cold file.
    if (yield* dropIfFinalized(input)) return;
    const check = yield* checkRawBackup({
      path: backup.path,
      env,
      openSqlite: input.openSqlite,
    });
    if (check._tag === "Damaged") {
      // The live database was already damaged when it was copied. Partly readable data is still
      // the best restore point there is, so keep it, uncompressed and outside retention.
      const quarantined = yield* publishBackup(backup.path, dirname(backup.path), {
        ...parseBackupName(backup.name)!,
        unverified: true,
      });
      yield* syncBackupsDirectory(input.dbPath);
      return yield* Effect.logError(
        `The database backup ${backup.name} failed its integrity check, so the database was already damaged before the upgrade. Kept it as ${quarantined}; it is never removed automatically.`,
      ).pipe(Effect.annotateLogs({ quickCheck: check.lines.join("\n") }));
    }
    if (check.ledger !== backup.from) {
      // Not damaged but the wrong content for its name: it would mislead a restore.
      yield* removeFile(backup.path);
      return yield* Effect.logError(
        `Removed the database backup ${backup.name}: it holds schema ${check.ledger}, not ${backup.from}.`,
      );
    }
    const space = yield* Effect.promise(() =>
      env.statfs(dirname(backup.path)).catch(() => undefined),
    );
    if (space !== undefined && space.bavail * space.bsize < backup.bytes / 2) {
      return yield* Effect.logWarning(
        `Not compressing the database backup ${backup.name} yet: ${formatBytes(space.bavail * space.bsize)} free. It stays usable uncompressed.`,
      );
    }
    // Another process may have finished it during the check.
    if (yield* dropIfFinalized(input)) return;
    const compressed = yield* compressRawBackup(input);
    if (compressed === undefined) return;
    yield* Effect.logInfo(
      `Compressed the database backup ${basename(compressed.path)}: ${formatBytes(backup.bytes)} → ${formatBytes(compressed.bytes)} (${compressed.codec}, ${check.checked ? `quick_check ${check.ms} ms` : "quick_check skipped under Bun"}, compression ${compressed.ms} ms)`,
    );
  });

/**
 * Phase 2: checks, compresses and prunes the raw backups of `dbPath`. Runs in the background,
 * once per directory at a time per process; logs problems and never fails. Interrupting it is
 * harmless: raw backups stay valid, and partial files are cleaned up on the next run.
 */
export const finalizeDatabaseBackups = (input: {
  readonly dbPath: string;
  readonly openSqlite: OpenSqlite;
}): Effect.Effect<void> => {
  const directory = databaseBackupsDirectory(input.dbPath);
  return Effect.suspend(() => {
    if (finalizingDirectories.has(directory)) return Effect.void;
    finalizingDirectories.add(directory);
    return Effect.gen(function* () {
      const env = yield* BackupEnvironment;
      yield* cleanStaleBackupPartials(input.dbPath);
      const raw = (yield* listDatabaseBackups(input.dbPath))
        .filter((backup) => backup.state === "raw")
        .toReversed();
      for (const backup of raw) {
        yield* finalizeOne({ ...input, backup, env }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not finish the database backup ${backup.name}; it stays usable uncompressed: ${errorText(error)}`,
            ),
          ),
        );
      }
      yield* pruneDatabaseBackups(input.dbPath);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Database backup maintenance failed: ${errorText(error)}`),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning(`Database backup maintenance failed: ${errorText(defect)}`),
      ),
      Effect.ensuring(Effect.sync(() => finalizingDirectories.delete(directory))),
      Effect.withSpan("finalizeDatabaseBackups"),
    );
  });
};

// ---------------------------------------------------------------------------------------------
// Manual backups and restores (`ryco db backup | list | restore`)
// ---------------------------------------------------------------------------------------------

/** What a backup file holds, read from its first bytes: plain SQLite or a compressed copy. */
export type BackupFileFormat = "sqlite" | BackupCodec;

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * The format of `path` by its magic bytes, not its name (a renamed or mislabelled file is still
 * read correctly); undefined when it is neither SQLite, zstd nor gzip.
 */
export const detectBackupCodec = (path: string) =>
  io("read", path, async (): Promise<BackupFileFormat | undefined> => {
    const file = await open(path, "r");
    try {
      const head = Buffer.alloc(SQLITE_MAGIC.length);
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      const bytes = head.subarray(0, bytesRead);
      if (bytes.equals(SQLITE_MAGIC)) return "sqlite";
      if (bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC)) return "zst";
      if (bytes.length >= 2 && bytes.subarray(0, 2).equals(GZIP_MAGIC)) return "gz";
      return undefined;
    } finally {
      await file.close();
    }
  });

const SQLITE_HEADER_BYTES = 100;

/**
 * The database size a SQLite header states: page size times the "in-header database size",
 * which is valid when the change counter matches its version-valid-for number (every writer
 * since SQLite 3.7.0). Undefined when the header does not say.
 */
const databaseBytesFromHeader = (head: Buffer): number | undefined => {
  if (head.length < SQLITE_HEADER_BYTES) return undefined;
  if (!head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return undefined;
  const storedPageSize = head.readUInt16BE(16);
  const pageSize = storedPageSize === 1 ? 65_536 : storedPageSize;
  const pageCount = head.readUInt32BE(28);
  const valid =
    pageSize >= 512 &&
    (pageSize & (pageSize - 1)) === 0 &&
    pageCount > 0 &&
    head.readUInt32BE(24) === head.readUInt32BE(92);
  return valid ? pageSize * pageCount : undefined;
};

/**
 * The size of the database a compressed backup holds, from the header in its first decompressed
 * bytes; undefined when that cannot be read (the restore itself then reports why).
 */
const compressedDatabaseBytes = (file: string, codec: BackupCodec) =>
  Effect.promise(async () => {
    const source = createReadStream(file, { highWaterMark: 64 * 1024 });
    const decompressor = codec === "zst" ? zlib.createZstdDecompress() : zlib.createGunzip();
    source.on("error", (error) => decompressor.destroy(error));
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of source.pipe(decompressor) as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        length += chunk.length;
        if (length >= SQLITE_HEADER_BYTES) break;
      }
      return databaseBytesFromHeader(Buffer.concat(chunks));
    } catch {
      return undefined;
    } finally {
      source.destroy();
      decompressor.destroy();
    }
  });

export type DatabaseBackupCommandFailure =
  | "no-database"
  | "insufficient-space"
  | "check-failed"
  | "not-a-file"
  | "live-database"
  | "unknown-format"
  | "unsupported-codec"
  | "unsafe-target"
  | "target-not-empty"
  | "damaged"
  | "not-a-ryco-database"
  | "io";

/** A manual backup or restore that cannot go ahead; `message` says why, for the terminal. */
export class DatabaseBackupCommandError extends Data.TaggedError("DatabaseBackupCommandError")<{
  readonly reason: DatabaseBackupCommandFailure;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const commandError = (reason: DatabaseBackupCommandFailure, message: string, cause?: unknown) =>
  new DatabaseBackupCommandError({ reason, message, ...(cause === undefined ? {} : { cause }) });

const asCommandError = (error: DatabaseBackupError) => commandError("io", error.message, error);

/**
 * For the steps after a backup or restore is published: a failure there does not undo it, so it
 * is reported in `warnings` instead of failing the command.
 */
const warnInstead =
  (warnings: string[], what: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, never, R> =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          warnings.push(`${what}: ${errorText(error)}`);
          return undefined;
        }),
      ),
    );

/** First lines of a `quick_check` / `integrity_check` that did not say "ok". */
const checkProblems = (lines: ReadonlyArray<string>) =>
  lines.length === 1 && lines[0] === "ok" ? undefined : lines.slice(0, 5).join("; ");

const runCheck = (
  run: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
  pragma: "quick_check" | "integrity_check",
) =>
  Effect.map(run(`PRAGMA ${pragma}`), (rows) => rows.map((row) => String(Object.values(row)[0])));

/** Every message along an error's `cause` chain (SqlError wraps the driver's error twice). */
const causeMessages = (error: unknown): string => {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth += 1) {
    messages.push(errorText(current));
    current = (current as { readonly cause?: unknown }).cause;
  }
  return messages.join(" | ");
};

/**
 * Runs `use` on a read-only connection to `filename`. Bun's SQLite cannot read a WAL database
 * through a read-only connection while its `-shm` file does not exist yet (no other process has
 * it open): the first query fails with "unable to open database file" (measured with Bun 1.4.3;
 * the open itself succeeds). A probe query finds that out before `use` starts, and only then
 * `use` runs on a read-write connection instead; `use` only reads, as every other CLI command
 * that opens the database. A failure inside `use` is never retried.
 */
const withReadConnection = <A, E>(
  openSqlite: OpenSqlite,
  filename: string,
  use: Effect.Effect<A, E | SqlError, SqlClient.SqlClient>,
): Effect.Effect<A, E | SqlError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const readOnly = yield* Layer.build(openSqlite({ filename, readonly: true })).pipe(
        Effect.tap((context) =>
          Effect.gen(function* () {
            const client = yield* SqlClient.SqlClient;
            yield* client.unsafe("PRAGMA schema_version");
          }).pipe(Effect.provide(context)),
        ),
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => /unable to open database file/i.test(causeMessages(error)),
          () => Effect.succeed(Option.none()),
        ),
      );
      const context = Option.isSome(readOnly)
        ? readOnly.value
        : yield* Layer.build(openSqlite({ filename }));
      return yield* use.pipe(Effect.provide(context));
    }),
  );

export interface ManualBackupResult {
  readonly path: string;
  /** The schema (latest migration) the backup holds. */
  readonly schema: number;
  /** The live database and its WAL when the backup started. */
  readonly databaseBytes: number;
  /** The compacted copy `VACUUM INTO` wrote, before compression. */
  readonly copyBytes: number;
  /** The compressed backup. */
  readonly bytes: number;
  readonly codec: BackupCodec;
  readonly copyMs: number;
  readonly checkMs: number;
  readonly compressMs: number;
  readonly ms: number;
  /** Older manual backups removed by retention. */
  readonly pruned: ReadonlyArray<string>;
  /** Clean-up after the backup was published that did not work; the backup is complete. */
  readonly warnings: ReadonlyArray<string>;
}

export type ManualBackupStep = "copy" | "check" | "compress";

/**
 * `ryco db backup`: a compacted, checked and compressed copy of `dbPath`, safe while a server
 * runs. `VACUUM INTO` on a read-only connection is one read transaction, so it never takes the
 * write lock and a live writer keeps going (measured beside `ryco serve` on a 4.5 GB database:
 * insert p99 3.2-5.5 ms during the backup, 2.0-3.1 ms before it). Unlike the pre-upgrade backup
 * it fails instead of skipping: someone asked for it.
 */
export const createManualBackup = Effect.fn("createManualBackup")(function* (input: {
  readonly dbPath: string;
  readonly openSqlite: OpenSqlite;
  /** Called as each step starts, for progress output. */
  readonly onStep?: ((step: ManualBackupStep) => Effect.Effect<void>) | undefined;
}) {
  const env = yield* BackupEnvironment;
  const startedAt = performance.now();
  const { dbPath, openSqlite } = input;
  const step = (name: ManualBackupStep) => input.onStep?.(name) ?? Effect.void;

  const database = yield* io("stat", dbPath, () => stat(dbPath)).pipe(Effect.option);
  if (Option.isNone(database) || !database.value.isFile()) {
    return yield* commandError("no-database", `No Ryco database at ${dbPath}.`);
  }
  const backupsDir = databaseBackupsDirectory(dbPath);
  yield* io("mkdir", backupsDir, () => mkdir(backupsDir, { recursive: true, mode: 0o700 })).pipe(
    Effect.mapError(asCommandError),
  );
  yield* cleanStaleBackupPartials(dbPath).pipe(Effect.ignore);

  const databaseBytes =
    database.value.size + (yield* fileSize(`${dbPath}-wal`).pipe(Effect.mapError(asCommandError)));
  const space = yield* Effect.promise(() => env.statfs(backupsDir).catch(() => undefined));
  const needed = BACKUP_FREE_SPACE_FACTOR * databaseBytes;
  if (space !== undefined && space.bavail * space.bsize < needed) {
    return yield* commandError(
      "insufficient-space",
      `Not enough free space for a backup in ${backupsDir}: ${formatBytes(space.bavail * space.bsize)} free, ${formatBytes(needed)} needed for a ${formatBytes(databaseBytes)} database.`,
    );
  }

  const createdAt = yield* Clock.currentTimeMillis;
  const stem = backupStem(dbPath);
  const codec = preferredCodec();
  // Every partial this call writes, for cleanup on failure.
  const partials: string[] = [];
  const track = (partial: string) => {
    partials.push(partial);
    inFlightPartials.add(partial);
    return partial;
  };
  const discardPartials = Effect.suspend(() =>
    Effect.forEach(
      partials.flatMap((partial) =>
        ["", "-wal", "-shm", "-journal"].map((suffix) => `${partial}${suffix}`),
      ),
      (path) => Effect.ignore(removeFile(path)),
    ),
  );

  return yield* Effect.gen(function* () {
    yield* step("copy");
    const copyStartedAt = performance.now();
    // One connection to the live database. The plain copy is named after the live schema; the
    // published name uses the schema found in the copy.
    const rawPartial = yield* withReadConnection(
      openSqlite,
      dbPath,
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        const liveSchema = yield* readLedgerVersion(clientRunner(client));
        const partial = track(
          join(
            backupsDir,
            partialName(
              formatBackupName({ stem, from: liveSchema, to: "manual", at: createdAt }),
              env.pid,
            ),
          ),
        );
        yield* client.unsafe("VACUUM INTO ?", [partial]);
        return partial;
      }),
    );
    const copyMs = Math.round(performance.now() - copyStartedAt);

    yield* step("check");
    const checkStartedAt = performance.now();
    const shape = yield* withReadConnection(
      openSqlite,
      rawPartial,
      Effect.gen(function* () {
        const run = clientRunner(yield* SqlClient.SqlClient);
        return {
          problems: checkProblems(yield* runCheck(run, "quick_check")),
          schema: yield* readLedgerVersion(run),
          pageCount: yield* queryNumber(run, "PRAGMA page_count"),
          pageSize: yield* queryNumber(run, "PRAGMA page_size"),
        };
      }),
    );
    const copyBytes = yield* fileSize(rawPartial).pipe(Effect.mapError(asCommandError));
    const checkMs = Math.round(performance.now() - checkStartedAt);
    if (shape.problems !== undefined) {
      return yield* commandError(
        "check-failed",
        `The copy of ${dbPath} failed quick_check (${shape.problems}), so the database itself is damaged. No backup was written.`,
      );
    }
    if (copyBytes !== shape.pageCount * shape.pageSize) {
      return yield* commandError(
        "check-failed",
        `The copy of ${dbPath} is ${copyBytes} bytes, not ${shape.pageCount} pages of ${shape.pageSize} bytes. No backup was written.`,
      );
    }

    yield* step("compress");
    const compressStartedAt = performance.now();
    const name = { stem, from: shape.schema, to: "manual", at: createdAt, codec } as const;
    const compressedPartial = track(join(backupsDir, partialName(formatBackupName(name), env.pid)));
    yield* compressInProcess(rawPartial, compressedPartial, codec);
    yield* restrictToOwner(compressedPartial);
    yield* io("sync", compressedPartial, () => syncFile(compressedPartial));
    const bytes = yield* fileSize(compressedPartial);
    const path = yield* publishBackup(compressedPartial, backupsDir, name);
    const compressMs = Math.round(performance.now() - compressStartedAt);

    // The backup is complete once it has its name, so what follows only warns.
    const warnings: string[] = [];
    yield* syncBackupsDirectory(dbPath).pipe(
      warnInstead(warnings, `Could not flush ${backupsDir} to disk`),
    );
    yield* removeFile(rawPartial).pipe(
      warnInstead(
        warnings,
        `Could not remove the plain copy ${rawPartial}; the next backup removes it`,
      ),
    );
    const pruned = yield* pruneDatabaseBackups(dbPath, { keep: path, kinds: ["manual"] }).pipe(
      warnInstead(warnings, "Could not remove older manual backups"),
      Effect.map((removed) => removed ?? []),
    );
    return {
      path,
      schema: shape.schema,
      databaseBytes,
      copyBytes,
      bytes,
      codec,
      copyMs,
      checkMs,
      compressMs,
      ms: Math.round(performance.now() - startedAt),
      pruned,
      warnings,
    } satisfies ManualBackupResult;
  }).pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.fail(commandError("io", `Could not back up ${dbPath}: ${error.message}`, error)),
      DatabaseBackupError: (error) => Effect.fail(asCommandError(error)),
    }),
    Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : discardPartials)),
    Effect.ensuring(
      Effect.sync(() => {
        for (const partial of partials) inFlightPartials.delete(partial);
      }),
    ),
  );
});

/** A backup, as `ryco db list` shows it. */
export interface ListedDatabaseBackup extends DatabaseBackup {
  /** This build can open it: its schema is not newer than the newest migration it knows. */
  readonly opensWithThisBuild: boolean;
}

export const describeDatabaseBackups = Effect.fn("describeDatabaseBackups")(function* (
  dbPath: string,
) {
  const backups = yield* listDatabaseBackups(dbPath);
  return {
    directory: databaseBackupsDirectory(dbPath),
    supportedSchema: SUPPORTED_MIGRATION_ID,
    // The listed records are this call's own, so they are extended in place.
    backups: backups.map((backup): ListedDatabaseBackup =>
      Object.assign(backup, { opensWithThisBuild: backup.from <= SUPPORTED_MIGRATION_ID }),
    ),
  };
});

/** `path` made absolute, then each of its ancestors up to the root, nearest first. */
const selfAndAncestors = (path: string): ReadonlyArray<string> => {
  const chain = [resolve(path)];
  for (let current = chain[0]!, parent = dirname(current); parent !== current;) {
    chain.push(parent);
    current = parent;
    parent = dirname(current);
  }
  return chain;
};

/**
 * An absolute path with every symlink of its existing part resolved; the part that does not
 * exist yet is appended as given.
 */
const canonicalPath = async (path: string): Promise<string> => {
  const chain = selfAndAncestors(path);
  for (const [index, ancestor] of chain.entries()) {
    try {
      return join(await realpath(ancestor), relative(ancestor, chain[0]!));
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || index === chain.length - 1) throw error;
    }
  }
  return chain[0]!;
};

const identityOf = async (path: string) => {
  const info = await stat(path).catch(() => undefined);
  return info === undefined ? undefined : `${info.dev}:${info.ino}`;
};

/** `dev:ino` of `path` and each existing ancestor, nearest first. */
const identityChain = async (path: string): Promise<ReadonlyArray<string>> =>
  (await Promise.all(selfAndAncestors(path).map(identityOf))).filter(
    (identity): identity is string => identity !== undefined,
  );

/** Case-insensitive volumes are the default on macOS and Windows; a false match only refuses. */
const comparablePath = (path: string) =>
  process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;

const isWithin = (child: string, parent: string) => {
  const [a, b] = [comparablePath(child), comparablePath(parent)];
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
};

/**
 * Why restoring into `target` would touch the data directory in use, if it would: the target is
 * that directory, lies inside it, or contains it. Paths are compared after resolving symlinks,
 * and existing directories also by device and inode.
 */
const unsafeRestoreTarget = async (
  target: string,
  live: ReadonlyArray<string>,
): Promise<string | undefined> => {
  const canonicalTarget = await canonicalPath(target);
  const targetChain = await identityChain(target);
  const targetIdentity = await identityOf(target);
  for (const path of live) {
    const canonicalLive = await canonicalPath(path);
    const liveIdentity = await identityOf(path);
    if (
      isWithin(canonicalTarget, canonicalLive) ||
      (liveIdentity !== undefined && targetChain.includes(liveIdentity))
    ) {
      return `it is, or is inside, the data directory in use (${path})`;
    }
    if (
      isWithin(canonicalLive, canonicalTarget) ||
      (targetIdentity !== undefined && (await identityChain(path)).includes(targetIdentity))
    ) {
      return `it contains the data directory in use (${path})`;
    }
  }
  return undefined;
};

/** The directories from `path` up to (not including) its nearest existing ancestor, top first. */
const missingDirectories = async (path: string) => {
  const chain = selfAndAncestors(path);
  for (const [index, ancestor] of chain.entries()) {
    const present = await lstat(ancestor).then(
      () => true,
      () => false,
    );
    if (present) return { missing: chain.slice(0, index).toReversed(), existingAncestor: ancestor };
  }
  return { missing: chain.slice(0, -1).toReversed(), existingAncestor: chain.at(-1)! };
};

const supportsZstdDecompress = typeof zlib.createZstdDecompress === "function";

export interface RestoreResult {
  /** The restored database file. */
  readonly path: string;
  /** The data directory to start Ryco on (`--base-dir`). */
  readonly baseDir: string;
  readonly format: BackupFileFormat;
  readonly schema: number;
  readonly supportedSchema: number;
  readonly opensWithThisBuild: boolean;
  readonly check: "quick_check" | "integrity_check";
  readonly bytes: number;
  /** Not errors: what the person restoring should know (another branch, a newer schema, a failed flush). */
  readonly warnings: ReadonlyArray<string>;
  readonly ms: number;
}

/**
 * `ryco db restore`: writes the database in `file` (plain, zstd or gzip, by its magic bytes) to
 * `target.dbPath` in a new or empty data directory, after checking it. Everything is validated
 * before anything is created; the live data directory is never written; a failure removes what
 * this call created.
 */
export const restoreDatabaseBackup = Effect.fn("restoreDatabaseBackup")(function* (input: {
  readonly file: string;
  /** The new data directory and the database path inside it (`<baseDir>/userdata/state.sqlite`). */
  readonly target: { readonly baseDir: string; readonly dbPath: string };
  /** The data directory in use, which a restore never touches. */
  readonly live: { readonly baseDir: string; readonly stateDir: string; readonly dbPath: string };
  readonly openSqlite: OpenSqlite;
  /** `integrity_check` instead of `quick_check` (much slower on large databases). */
  readonly fullCheck?: boolean | undefined;
}) {
  const env = yield* BackupEnvironment;
  const startedAt = performance.now();
  const file = resolve(input.file);
  const targetDir = resolve(input.target.baseDir);
  const targetDb = resolve(input.target.dbPath);
  const ioError = Effect.mapError(asCommandError);

  // 1. The input.
  const info = yield* io("stat", file, () => stat(file)).pipe(Effect.option);
  if (Option.isNone(info) || !info.value.isFile()) {
    return yield* commandError("not-a-file", `${file} is not a file.`);
  }
  const liveDb = yield* io("resolve", input.live.dbPath, () =>
    canonicalPath(input.live.dbPath),
  ).pipe(ioError);
  const canonicalFile = yield* io("resolve", file, () => canonicalPath(file)).pipe(ioError);
  // By device and inode too: a hard link to the database in use has a path of its own.
  const [fileIdentity, liveIdentity] = yield* Effect.promise(() =>
    Promise.all([identityOf(file), identityOf(input.live.dbPath)]),
  );
  const why =
    comparablePath(canonicalFile) === comparablePath(liveDb) ||
    (liveIdentity !== undefined && fileIdentity === liveIdentity)
      ? "is the database in use"
      : (yield* fileSize(`${file}-wal`).pipe(ioError)) > 0
        ? "has a write-ahead log next to it, so a database is using it"
        : undefined;
  if (why !== undefined) {
    return yield* commandError(
      "live-database",
      `${file} ${why}, not a backup. Back it up with \`ryco db backup\` and restore that backup.`,
    );
  }
  const format = yield* detectBackupCodec(file).pipe(ioError);
  if (format === undefined) {
    return yield* commandError(
      "unknown-format",
      `${file} is not a database backup: it is neither a SQLite file nor zstd or gzip.`,
    );
  }
  if (format === "zst" && !supportsZstdDecompress) {
    return yield* commandError(
      "unsupported-codec",
      `This runtime cannot read zstd. Decompress it with \`zstd -d ${file}\` and restore the .sqlite file.`,
    );
  }

  // 2. The target: outside the data directory in use, new or empty.
  const unsafe = yield* io("resolve", targetDir, () =>
    unsafeRestoreTarget(targetDir, [
      input.live.baseDir,
      input.live.stateDir,
      dirname(input.live.dbPath),
    ]),
  ).pipe(ioError);
  if (unsafe !== undefined) {
    return yield* commandError(
      "unsafe-target",
      `Refusing to restore into ${targetDir}: ${unsafe}. Restore into a new directory outside it.`,
    );
  }
  const targetEntries = yield* io("list", targetDir, async () => {
    try {
      const entry = await stat(targetDir);
      return entry.isDirectory() ? await readdir(targetDir) : null;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }).pipe(ioError);
  if (targetEntries === null || targetEntries.length > 0) {
    return yield* commandError(
      "target-not-empty",
      `${targetDir} ${targetEntries === null ? "is not a directory" : "is not empty"}. Restore into a new or empty directory.`,
    );
  }
  for (const sidecar of ["", "-wal", "-shm"]) {
    if (yield* exists(`${targetDb}${sidecar}`).pipe(ioError)) {
      return yield* commandError(
        "target-not-empty",
        `${targetDb}${sidecar} already exists. Restore into a new or empty directory.`,
      );
    }
  }

  // 3. Space for the restored database: a plain file's size, or the size a compressed backup's
  // SQLite header states. The target may share a volume with the database in use, and filling
  // it would make that database's writes fail. Without a readable header, the compressed size
  // is a lower bound.
  const { missing, existingAncestor } = yield* io("resolve", targetDb, () =>
    missingDirectories(dirname(targetDb)),
  ).pipe(ioError);
  const restoredBytes =
    format === "sqlite" ? info.value.size : yield* compressedDatabaseBytes(file, format);
  const neededBytes = restoredBytes ?? info.value.size;
  const space = yield* Effect.promise(() => env.statfs(existingAncestor).catch(() => undefined));
  if (space !== undefined && space.bavail * space.bsize < neededBytes) {
    return yield* commandError(
      "insufficient-space",
      `Not enough free space in ${existingAncestor}: ${formatBytes(space.bavail * space.bsize)} free, ${restoredBytes === undefined ? "at least " : ""}${formatBytes(neededBytes)} needed for the restored database.`,
    );
  }

  // 4. Write, check and publish; undo everything on failure.
  const created: string[] = [];
  const partial = join(dirname(targetDb), `.${basename(targetDb)}.${env.pid}.partial`);
  const undo = Effect.gen(function* () {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      yield* Effect.ignore(removeFile(`${partial}${suffix}`));
    }
    for (const directory of created.toReversed()) {
      yield* Effect.promise(() => rmdir(directory).catch(() => undefined));
    }
  });
  const fullCheck = input.fullCheck === true;
  return yield* Effect.gen(function* () {
    for (const directory of missing) {
      yield* io("mkdir", directory, () => mkdir(directory, { mode: 0o700 }));
      created.push(directory);
    }
    yield* format === "sqlite"
      ? io("copy", file, () => copyFile(file, partial, constants.COPYFILE_EXCL))
      : io("decompress", file, (signal) =>
          pipeline(
            createReadStream(file, { highWaterMark: COMPRESS_CHUNK_BYTES }),
            format === "zst" ? zlib.createZstdDecompress() : zlib.createGunzip(),
            createWriteStream(partial, { flags: "wx", mode: 0o600 }),
            { signal },
          ),
        ).pipe(
          // zlib reports a bad checksum or a truncated stream as Z_* / ZSTD_* errors.
          Effect.mapError((error) =>
            /^(?:Z_|ZSTD_)/.test(String(errorCode(error.cause) ?? ""))
              ? commandError(
                  "damaged",
                  `${file} is damaged or incomplete: ${errorText(error.cause)}. Nothing was restored.`,
                  error,
                )
              : asCommandError(error),
          ),
        );
    yield* restrictToOwner(partial);
    yield* io("sync", partial, () => syncFile(partial));

    const pragma = fullCheck ? "integrity_check" : "quick_check";
    const shape = yield* withReadConnection(
      input.openSqlite,
      partial,
      Effect.gen(function* () {
        const run = clientRunner(yield* SqlClient.SqlClient);
        const problems = checkProblems(yield* runCheck(run, pragma));
        const ledger = (yield* hasLedgerTable(run))
          ? (yield* run(
              "SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id",
            )).map((row) => ({ id: Number(row.migration_id), name: String(row.name) }))
          : null;
        return { problems, ledger };
      }),
    ).pipe(
      Effect.catchTag("SqlError", (error) =>
        Effect.fail(
          commandError(
            "damaged",
            `${file} does not hold a readable SQLite database: ${error.message}. Nothing was restored.`,
            error,
          ),
        ),
      ),
    );
    if (shape.problems !== undefined) {
      return yield* commandError(
        "damaged",
        `The database in ${file} fails ${pragma} (${shape.problems}). Nothing was restored.`,
      );
    }
    if (shape.ledger === null) {
      return yield* commandError(
        "not-a-ryco-database",
        `${file} holds a SQLite database without a Ryco migration ledger. Nothing was restored.`,
      );
    }
    for (const sidecar of ["-wal", "-shm", "-journal"]) {
      yield* removeFile(`${partial}${sidecar}`);
    }

    const schema = shape.ledger.reduce((latest, row) => Math.max(latest, row.id), 0);
    const known = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
    const foreign = shape.ledger.filter(
      (row) => row.id <= SUPPORTED_MIGRATION_ID && known.get(row.id) !== row.name,
    );
    const warnings = [
      ...(foreign.length === 0
        ? []
        : [
            `A different branch or build of Ryco wrote this database: ${foreign
              .slice(0, 3)
              .map(
                (row) =>
                  `migration ${row.id} is ${row.name} there but ${known.get(row.id) ?? "unknown"} here`,
              )
              .join(
                "; ",
              )}${foreign.length > 3 ? ` (and ${foreign.length - 3} more)` : ""}. Open it with the build that wrote it.`,
          ]),
      ...(schema > SUPPORTED_MIGRATION_ID
        ? [
            `It has schema ${schema}, newer than this build supports (${SUPPORTED_MIGRATION_ID}), so this build will not open it. Start a Ryco build that supports schema ${schema} on it.`,
          ]
        : []),
    ];

    for (const sidecar of ["-wal", "-shm"]) {
      if (yield* exists(`${targetDb}${sidecar}`)) {
        return yield* commandError(
          "target-not-empty",
          `${targetDb}${sidecar} appeared while restoring. Nothing was restored.`,
        );
      }
    }
    const bytes = yield* fileSize(partial);
    const published = yield* publishWithoutReplacing(partial, [targetDb]);
    if (published === undefined) {
      return yield* commandError(
        "target-not-empty",
        `${targetDb} appeared while restoring. Nothing was restored.`,
      );
    }
    // Restored once it has its name, so what follows only warns.
    yield* io("sync", dirname(targetDb), () => syncDirectory(dirname(targetDb))).pipe(
      warnInstead(warnings, `Could not flush ${dirname(targetDb)} to disk`),
    );
    if (created.length > 0) {
      const parent = dirname(created[0]!);
      yield* io("sync", parent, () => syncDirectory(parent)).pipe(Effect.ignore);
    }
    return {
      path: targetDb,
      baseDir: targetDir,
      format,
      schema,
      supportedSchema: SUPPORTED_MIGRATION_ID,
      opensWithThisBuild: schema <= SUPPORTED_MIGRATION_ID,
      check: pragma,
      bytes,
      warnings,
      ms: Math.round(performance.now() - startedAt),
    } satisfies RestoreResult;
  }).pipe(
    Effect.catchTag("DatabaseBackupError", (error) => Effect.fail(asCommandError(error))),
    Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : undo)),
  );
});
