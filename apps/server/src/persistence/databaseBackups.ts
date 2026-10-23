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
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { setPriority } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

import { Clock, Config, Context, Data, Duration, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import { syncDirectory, syncFile } from "../fsDurability.ts";
import type { MigrationLedgerInspection } from "./Migrations.ts";

/** Above this size a backup needs a copy-on-write clone; a full copy would stall startup. */
export const PREMIGRATION_FULL_COPY_MAX_BYTES = 2 * 1024 ** 3;
/** A restart within this window reuses an unchanged backup of the same upgrade. */
export const PREMIGRATION_BACKUP_DEDUPE_WINDOW_MS = 10 * 60_000;
/** Phase 2 waits this long after startup, out of boot and hydration. */
export const BACKUP_FINALIZE_DELAY = Duration.seconds(30);
/** Backups kept per kind (pre-upgrade, manual). */
export const BACKUP_RETENTION_PER_KIND = 3;
/** A backup needs this multiple of the live database's size free on disk. */
export const BACKUP_FREE_SPACE_FACTOR = 2;
/** Partials older than this are removed even when their pid looks alive (pid reuse). */
const STALE_PARTIAL_AGE_MS = 24 * 60 * 60_000;
const COMPRESS_CHUNK_BYTES = 1024 * 1024;

export type PremigrationBackupMode = "auto" | "always" | "off";
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

/** Where backups of `dbPath` live: next to it, in `backups/`. */
export const databaseBackupsDirectory = (dbPath: string) => join(dirname(dbPath), "backups");

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

/** `RYCO_PREMIGRATION_BACKUP`: `auto` (default), `always` (no size limit) or `off`. */
export const readPremigrationBackupMode = Effect.gen(function* () {
  const configured = yield* Config.String("RYCO_PREMIGRATION_BACKUP").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const value = Option.getOrElse(configured, () => "")
    .trim()
    .toLowerCase();
  if (value === "" || value === "auto") return "auto" as PremigrationBackupMode;
  if (value === "always" || value === "off") return value as PremigrationBackupMode;
  yield* Effect.logWarning(
    `Ignoring RYCO_PREMIGRATION_BACKUP=${value}: expected auto, always or off. Using auto.`,
  );
  return "auto" as PremigrationBackupMode;
});

/** An existing database that the next migration pass will change. */
export const needsPremigrationBackup = (ledger: MigrationLedgerInspection) =>
  !ledger.fresh &&
  !ledger.tooNew &&
  (ledger.pending.length > 0 || ledger.repairsPending.length > 0);

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
  options: { readonly keep?: string | undefined } = {},
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
  for (const kind of ["before", "manual"] as const) {
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

const formatBytes = (bytes: number) => {
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

/** The highest recorded migration of a database, 0 without a ledger. */
const readLedgerVersion = (
  run: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
) =>
  Effect.gen(function* () {
    const hasLedger =
      (yield* run(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )).length > 0;
    return hasLedger
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

const compressStream = (codec: BackupCodec) =>
  codec === "zst"
    ? zlib.createZstdCompress({
        params: {
          [zlib.constants.ZSTD_c_compressionLevel]: 1,
          [zlib.constants.ZSTD_c_checksumFlag]: 1,
        },
      })
    : zlib.createGzip({ level: 1 });

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
    const codec: BackupCodec = supportsZstd ? "zst" : "gz";
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
        yield* io("compress", backup.path, (signal) =>
          pipeline(
            createReadStream(backup.path, { highWaterMark: COMPRESS_CHUNK_BYTES }),
            compressStream(codec),
            createWriteStream(partial, { flags: "wx", mode: 0o600 }),
            { signal },
          ),
        );
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
