// @effect-diagnostics nodeBuiltinImport:off - renames, directory flushes and a JSON journal next to the database, which Effect's FileSystem does not flush.
/**
 * databaseRestoreSwap - `ryco db restore <file> --replace`: makes a checked backup the database
 * in use, and keeps everything it replaces.
 *
 * It runs only while this process owns the database (maintenance ownership, so no server starts
 * meanwhile) and no other process has it open. A `wal_checkpoint(TRUNCATE)` that nothing kept
 * busy folds the write-ahead log into the file, and closing that last connection removes the
 * log. Then the operating system is asked who else has the database or its log open, as
 * `ryco doctor` does before its swap (`fileHolders.ts`): SQLite opens `-wal` and `-shm` by name,
 * so a process that opened the old file would share the restored file's log, and an idle one
 * holds no lock SQLite could see. When that cannot be known (no `lsof` or `/proc`, Windows), the
 * restore refuses. Then:
 *
 * 1. The backup is restored and checked into a staging directory next to the database, by the
 *    same `restoreDatabaseBackup` as a restore into a new directory (format, size, free space,
 *    `quick_check`, migration ledger). Next to it means on the same volume, so publishing the
 *    restored file is a rename.
 * 2. A journal (`<db>.restore.json`) names the staged file and every move: the session signing
 *    key, then the database and its `-wal`, `-shm` and `-journal` files, each into
 *    `<state dir>/replaced-<time>/`. Written and flushed before anything moves.
 * 3. The moves run in that order, the staged file is renamed to the database's name, and the
 *    journal and the staging directory are removed. Every directory involved is flushed.
 *
 * Nothing is deleted: what the restore replaced stays in the `replaced-` directory.
 *
 * Whatever stops a swap, the journal finishes it. While the staged file exists, finishing moves
 * aside whatever on the list is still in place (never over an existing file) and renames the
 * staged file in; once the staged file has its final name, it only removes the journal. Opening
 * the database finishes an interrupted swap first (Layers/Sqlite.ts), under the same ownership.
 * A swap that fails part-way while it runs (a file another process holds open, on Windows) moves
 * back what it moved and removes the journal and the staged copy, so the database stays as it
 * was.
 *
 * The signing key goes because revocations live in the database: the restored one accepts again
 * every session revoked after the backup was taken. Without the key every session token is
 * invalid, so every device signs out and pairs again. Pairing links and integration credentials
 * are checked against the database only; the result says to revoke those again.
 *
 * A journal is read back only if every path in it is one this module would have written for the
 * database it sits next to; anything else is refused, never acted on.
 *
 * @module databaseRestoreSwap
 */
import { lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Data, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  describeFileHolders,
  findFileHolders,
  type FileHoldersResult,
} from "../doctor/fileHolders.ts";
import { syncDirectory, syncFile } from "../fsDurability.ts";
import {
  DatabaseBackupCommandError,
  type OpenSqlite,
  restoreDatabaseBackup,
  type RestoreResult,
} from "./databaseBackups.ts";
import {
  acquireDatabaseMaintenance,
  DatabaseOwnerLease,
  isDatabaseOwnerLockDisabled,
} from "./databaseOwnerLock.ts";
import { databaseRestoreJournalPath } from "./databaseRestoreJournal.ts";

/** The session signing key's file in the secrets directory (SessionCredentialService). */
export const SESSION_SIGNING_KEY_FILE = "server-signing-key.bin";
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const STAGING_PREFIX = ".restore-staging-";
const ASIDE_PREFIX = "replaced-";

const RestoreJournal = Schema.Struct({
  version: Schema.Literal(1),
  /** The database in use: the swap's target. */
  target: Schema.String,
  stagingDir: Schema.String,
  /** The restored and checked database, in `stagingDir`, renamed to `target` last. */
  staged: Schema.String,
  /** Where everything the restore replaces goes. */
  aside: Schema.String,
  /** In order: the signing key, then the database and its files. */
  moves: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
});
type RestoreJournal = typeof RestoreJournal.Type;

export class DatabaseRestoreSwapError extends Data.TaggedError("DatabaseRestoreSwapError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const swapError = (message: string, cause?: unknown) =>
  new DatabaseRestoreSwapError({ message, ...(cause === undefined ? {} : { cause }) });

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const pathExists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** A sortable UTC stamp, like the backups' names use. */
const stampOf = (epochMs: number) => new Date(epochMs).toISOString().replace(/[-:.]/g, "");

/** The journal for swapping the restored file `staged` (in `stagingDir`) in for `dbPath`. */
export function planDatabaseRestoreSwap(input: {
  readonly dbPath: string;
  readonly stagingDir: string;
  readonly nowMs: number;
}): RestoreJournal {
  const stateDir = dirname(input.dbPath);
  const aside = join(stateDir, `${ASIDE_PREFIX}${stampOf(input.nowMs)}`);
  const signingKey = join(stateDir, "secrets", SESSION_SIGNING_KEY_FILE);
  return {
    version: 1,
    target: input.dbPath,
    stagingDir: input.stagingDir,
    staged: join(input.stagingDir, basename(input.dbPath)),
    aside,
    moves: [
      { from: signingKey, to: join(aside, SESSION_SIGNING_KEY_FILE) },
      ...DATABASE_FILE_SUFFIXES.map((suffix) => ({
        from: `${input.dbPath}${suffix}`,
        to: join(aside, `${basename(input.dbPath)}${suffix}`),
      })),
    ],
  };
}

/**
 * Whether `journal` is one {@link planDatabaseRestoreSwap} would have written for `dbPath`: a
 * journal names files to move and a directory to remove, so a foreign one is never acted on.
 */
export function isPlannedJournal(journal: RestoreJournal, dbPath: string): boolean {
  const stateDir = dirname(dbPath);
  if (journal.target !== dbPath) return false;
  if (dirname(journal.stagingDir) !== stateDir) return false;
  if (!basename(journal.stagingDir).startsWith(STAGING_PREFIX)) return false;
  if (journal.staged !== join(journal.stagingDir, basename(dbPath))) return false;
  if (dirname(journal.aside) !== stateDir) return false;
  if (!basename(journal.aside).startsWith(ASIDE_PREFIX)) return false;
  const expected = planDatabaseRestoreSwap({ dbPath, stagingDir: journal.stagingDir, nowMs: 0 });
  return (
    journal.moves.length === expected.moves.length &&
    journal.moves.every(
      (move, index) =>
        move.from === expected.moves[index]!.from &&
        move.to === join(journal.aside, basename(expected.moves[index]!.to)),
    )
  );
}

const writeJournal = async (journalPath: string, journal: RestoreJournal) => {
  const partial = `${journalPath}.partial`;
  await writeFile(partial, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await syncFile(partial);
  await rename(partial, journalPath);
  await syncDirectory(dirname(journalPath));
};

const readJournal = async (journalPath: string, dbPath: string): Promise<RestoreJournal> => {
  const text = await readFile(journalPath, "utf8");
  const journal = Schema.decodeUnknownSync(RestoreJournal)(JSON.parse(text));
  if (!isPlannedJournal(journal, dbPath)) {
    throw new Error(`${journalPath} does not describe a restore of ${dbPath}; it was not used.`);
  }
  return journal;
};

const removeJournal = async (journalPath: string, journal: RestoreJournal) => {
  await rm(journal.stagingDir, { recursive: true, force: true });
  await rm(journalPath, { force: true });
  await syncDirectory(dirname(journalPath));
};

/**
 * Finishes the swap `journal` describes: see the module comment. Safe to run again at any point,
 * also after it finished (it then only removes the journal).
 */
export async function finishDatabaseRestoreSwap(
  journalPath: string,
  journal: RestoreJournal,
): Promise<void> {
  if (await pathExists(journal.staged)) {
    await mkdir(journal.aside, { recursive: true, mode: 0o700 });
    for (const move of journal.moves) {
      if (!(await pathExists(move.from))) continue;
      if (await pathExists(move.to)) {
        throw new Error(`${move.to} already exists, so ${move.from} was not moved there.`);
      }
      await rename(move.from, move.to);
    }
    await syncDirectory(journal.aside);
    for (const directory of new Set(journal.moves.map((move) => dirname(move.from)))) {
      if (await pathExists(directory)) await syncDirectory(directory);
    }
    if (await pathExists(journal.target)) {
      throw new Error(
        `${journal.target} is still there, so the restored database was not moved in.`,
      );
    }
    await rename(journal.staged, journal.target);
    await syncDirectory(dirname(journal.target));
  }
  await removeJournal(journalPath, journal);
}

/**
 * Undoes the moves of a swap that failed while it ran: moves back what was moved (never over an
 * existing file), then removes the journal and the staged copy. Throws when a file cannot go back,
 * leaving the journal, so the next open finishes the restore instead.
 */
async function undoDatabaseRestoreSwap(journalPath: string, journal: RestoreJournal) {
  if (await pathExists(journal.target)) {
    // The staged file already has its final name: the restore went through.
    if (!(await pathExists(journal.staged))) return removeJournal(journalPath, journal);
  }
  for (const move of journal.moves.toReversed()) {
    if (!(await pathExists(move.to)) || (await pathExists(move.from))) continue;
    await rename(move.to, move.from);
  }
  for (const directory of new Set(journal.moves.map((move) => dirname(move.from)))) {
    if (await pathExists(directory)) await syncDirectory(directory);
  }
  await removeJournal(journalPath, journal);
  // Only an empty one: a file that could not go back stays where it is.
  await rmdir(journal.aside).catch(() => undefined);
}

/**
 * Finishes an interrupted in-place restore of `dbPath`, if its journal is there. Runs as the
 * database's owner: under the caller's ownership (`owned`, or a `DatabaseOwnerLease` for
 * `dbPath`), otherwise under maintenance ownership taken here (refused while a server owns the
 * database).
 */
export const finishInterruptedDatabaseRestore = (
  dbPath: string,
  options?: { readonly owned?: boolean | undefined },
) =>
  Effect.gen(function* () {
    const journalPath = databaseRestoreJournalPath(dbPath);
    const finish = Effect.tryPromise({
      try: async () => {
        if (!(await pathExists(journalPath))) return false;
        await finishDatabaseRestoreSwap(journalPath, await readJournal(journalPath, dbPath));
        return true;
      },
      catch: (cause) =>
        swapError(
          `A restore of ${dbPath} was interrupted and could not be finished: ${errorText(cause)} ` +
            `Its journal is ${journalPath}; nothing was deleted.`,
          cause,
        ),
    });
    const lease = yield* Effect.serviceOption(DatabaseOwnerLease);
    const finished =
      options?.owned === true ||
      (Option.isSome(lease) && lease.value.dbPath === dbPath) ||
      (yield* isDatabaseOwnerLockDisabled)
        ? yield* finish
        : yield* Effect.scoped(
            acquireDatabaseMaintenance(dbPath, "finish an interrupted database restore").pipe(
              Effect.andThen(finish),
            ),
          );
    if (finished) {
      yield* Effect.logWarning("finished an interrupted in-place restore of the database", {
        dbPath,
      });
    }
    return finished;
  });

export interface ReplaceResult extends RestoreResult {
  /** Where the replaced database, its files and the signing key were moved. */
  readonly replacedDir: string;
  /** The signing key was moved aside: every device must pair again. */
  readonly signedOut: boolean;
}

/**
 * Folds the live database's write-ahead log into it and checks that no other connection holds
 * it open in a read transaction: `busy`. The connection closes before the swap, which removes the
 * log. `unreadable` when SQLite cannot open or checkpoint it (a damaged file, the case a restore
 * is for): the swap then moves the database and its log aside together as they are.
 */
const quiesceLiveDatabase = (openSqlite: OpenSqlite, dbPath: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(openSqlite({ filename: dbPath, create: false }));
      const rows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
      }).pipe(Effect.provide(context));
      const busy = Number((rows[0] as { readonly busy?: unknown } | undefined)?.busy ?? 0);
      return busy === 0 ? ("quiet" as const) : ("busy" as const);
    }),
  ).pipe(Effect.catchTag("SqlError", () => Effect.succeed("unreadable" as const)));

/**
 * The other processes that have `dbPath` or its log open. The file is open in this process while
 * the system is asked, so the answer can be trusted only if it names this process too.
 */
const otherHolders = (
  dbPath: string,
  find: (paths: ReadonlyArray<string>) => Promise<FileHoldersResult>,
) =>
  Effect.promise(async (): Promise<FileHoldersResult> => {
    const handle = await open(dbPath, "r").catch(() => null);
    if (handle === null) return { kind: "checked", others: [] };
    try {
      return await find([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
    } finally {
      await handle.close();
    }
  });

/**
 * `ryco db restore <file> --replace`. The caller holds maintenance ownership of `live.dbPath`.
 */
export const replaceDatabaseWithBackup = Effect.fn("replaceDatabaseWithBackup")(function* (input: {
  readonly file: string;
  readonly live: { readonly baseDir: string; readonly stateDir: string; readonly dbPath: string };
  readonly openSqlite: OpenSqlite;
  readonly fullCheck?: boolean | undefined;
  readonly nowMs: number;
  /** Who else has these files open (tests); `fileHolders.ts` by default. */
  readonly fileHolders?: ((paths: ReadonlyArray<string>) => Promise<FileHoldersResult>) | undefined;
}) {
  const dbPath = input.live.dbPath;
  const journalPath = databaseRestoreJournalPath(dbPath);
  yield* finishInterruptedDatabaseRestore(dbPath, { owned: true });

  const warnings: string[] = [];
  if (yield* Effect.promise(() => pathExists(dbPath).catch(() => true))) {
    const state = yield* quiesceLiveDatabase(input.openSqlite, dbPath);
    if (state === "busy") {
      return yield* new DatabaseBackupCommandError({
        reason: "live-database",
        message: `Another process is reading ${dbPath} right now (a \`ryco\` command, a backup). Let it finish, then run this again. Nothing was changed.`,
      });
    }
    if (state === "unreadable") {
      warnings.push(
        `SQLite could not open ${dbPath}, so it and its write-ahead log were moved aside as they were.`,
      );
    }
    const holders = yield* otherHolders(
      dbPath,
      input.fileHolders ?? ((paths) => findFileHolders({ paths })),
    );
    if (holders.kind === "unavailable") {
      return yield* new DatabaseBackupCommandError({
        reason: "live-database",
        message: `Ryco cannot check whether another process has ${dbPath} open (${holders.reason}), and replacing it under one would corrupt the restored database. Restore into a new directory with --into instead. Nothing was changed.`,
      });
    }
    if (holders.others.length > 0) {
      return yield* new DatabaseBackupCommandError({
        reason: "live-database",
        message: `${describeFileHolders(holders.others)} still has ${dbPath} open. Close it, then run this again. Nothing was changed.`,
      });
    }
  }

  const stagingDir = join(dirname(dbPath), `${STAGING_PREFIX}${stampOf(input.nowMs)}`);
  const restored = yield* restoreDatabaseBackup({
    file: input.file,
    target: { baseDir: stagingDir, dbPath: join(stagingDir, basename(dbPath)) },
    live: input.live,
    openSqlite: input.openSqlite,
    fullCheck: input.fullCheck,
    staging: true,
  });
  const removeStaging = Effect.promise(() =>
    rm(stagingDir, { recursive: true, force: true }).catch(() => undefined),
  );
  if (!restored.opensWithThisBuild) {
    yield* removeStaging;
    return yield* new DatabaseBackupCommandError({
      reason: "not-a-ryco-database",
      message: `${input.file} holds schema ${restored.schema}, newer than this build supports (${restored.supportedSchema}), so it cannot replace the database in use. Nothing was changed.`,
    });
  }

  const journal = planDatabaseRestoreSwap({ dbPath, stagingDir, nowMs: input.nowMs });
  const signedOut = yield* Effect.promise(() =>
    pathExists(journal.moves[0]!.from).catch(() => true),
  );
  yield* Effect.tryPromise({
    try: () => writeJournal(journalPath, journal),
    catch: (cause) => swapError(`Could not write ${journalPath}: ${errorText(cause)}`, cause),
  }).pipe(Effect.tapError(() => removeStaging));
  yield* Effect.tryPromise({
    try: () => finishDatabaseRestoreSwap(journalPath, journal),
    catch: (cause) => swapError(errorText(cause), cause),
  }).pipe(
    Effect.catch((failure) =>
      Effect.tryPromise({
        try: () => undoDatabaseRestoreSwap(journalPath, journal),
        catch: (undoCause) =>
          swapError(
            `The restore stopped part-way (${failure.message}) and could not be undone (${errorText(undoCause)}). ` +
              `Start Ryco or run this again to finish it; nothing was deleted, and what was moved is in ${journal.aside}.`,
            undoCause,
          ),
      }).pipe(
        Effect.andThen(
          Effect.fail(
            swapError(
              `Could not swap the restored database in: ${failure.message} Nothing was changed.`,
              failure.cause,
            ),
          ),
        ),
      ),
    ),
  );
  return {
    ...restored,
    path: dbPath,
    baseDir: input.live.baseDir,
    warnings: [...restored.warnings, ...warnings],
    replacedDir: journal.aside,
    signedOut,
  } satisfies ReplaceResult;
});
