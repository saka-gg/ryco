// @effect-diagnostics nodeBuiltinImport:off - links, renames, directory flushes and a JSON journal next to the database, which Effect's FileSystem does not offer.
/**
 * databaseRestoreSwap - `ryco db restore <file> --replace`: makes a checked backup the database
 * in use, and keeps everything it replaces.
 *
 * It runs only while this process owns the database (maintenance ownership, so no server starts
 * meanwhile). Then:
 *
 * 1. The backup is restored and checked into a staging directory next to the database, by the
 *    same `restoreDatabaseBackup` as a restore into a new directory (format, size, free space,
 *    `quick_check`, migration ledger), on the same volume, so publishing it is a rename. A backup
 *    this build cannot open, or one whose ledger would make this build skip its own migrations
 *    (another branch wrote it), is refused.
 * 2. The staged copy is secured: revocations live in the database, so the restored one would
 *    accept again what was revoked after the backup was taken. Every pairing link not used yet
 *    and every integration credential is revoked in it, and the session signing key moves aside
 *    below, so every session token is invalid: every device and integration pairs again. It gets
 *    the live database's owner and permissions (`prepareCopyForSwap`, as `ryco doctor` does).
 * 3. Right before the swap, no other process may have the database open: a
 *    `wal_checkpoint(TRUNCATE)` nothing kept busy folds the write-ahead log into the file
 *    (closing that last connection removes the log), and the operating system is asked who else
 *    has the database or its log open, as the doctor does before its swap (`fileHolders.ts`).
 *    SQLite opens `-wal` and `-shm` by name, so a process that kept the old file open would share
 *    the restored file's log, and an idle one holds no lock SQLite could see. When that cannot be
 *    known (no `lsof` or `/proc`, Windows), the restore refuses.
 * 4. A journal (`<db>.restore.json`, the names of the staging and replaced directories) is written
 *    and flushed; the signing key and the database's `-wal`, `-shm` and `-journal` files move into
 *    `<state dir>/replaced-<time>/`, the database is hard-linked there (moved, where the volume
 *    has no links), and the staged file is renamed over the database, so its name is never
 *    missing. The journal and the staging directory are then removed. Every directory involved is
 *    flushed, and this step cannot be interrupted.
 *
 * Nothing is deleted: what the restore replaced stays in the `replaced-` directory until the user
 * removes it.
 *
 * Whatever stops a swap, the journal finishes it: while the staged file exists, finishing moves
 * aside whatever of the list is still in place (never over another file) and renames the staged
 * file in; once the staged file has its final name, it only removes the journal. Opening the
 * database finishes an interrupted swap first (Layers/Sqlite.ts), under the same ownership, and
 * fails startup with a typed error when it cannot. A swap that fails while it runs (a rename
 * refused) moves back what it moved, so the database stays as it was; if the staged file already
 * had its name, the restore went through and is reported as done. A run that stopped while it
 * staged (before its journal) leaves only its staging directory, which the next `--replace`
 * removes.
 *
 * The journal holds only the two directory names; every path is derived from the database it sits
 * next to, so a journal names nothing else.
 *
 * @module databaseRestoreSwap
 */
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Data, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  describeFileHolders,
  findFileHolders,
  type FileHoldersResult,
} from "../doctor/fileHolders.ts";
import { prepareCopyForSwap } from "../doctor/sqliteSwap.ts";
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
/** The database's own files that move aside with it (the database itself is linked). */
const DATABASE_SIDE_FILE_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const STAGING_PREFIX = ".restore-staging-";
const ASIDE_PREFIX = "replaced-";
const STAGING_NAME = /^\.restore-staging-\d{8}T\d{9}Z$/u;
const ASIDE_NAME = /^replaced-\d{8}T\d{9}Z$/u;

const RestoreJournal = Schema.Struct({
  version: Schema.Literal(1),
  /** The staging directory's name, next to the database. */
  staging: Schema.String,
  /** The name of the directory everything the restore replaces goes to, next to the database. */
  aside: Schema.String,
});
export type RestoreJournal = typeof RestoreJournal.Type;

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

const sameFile = async (left: string, right: string) => {
  const [a, b] = await Promise.all([stat(left), stat(right)]);
  return a.dev === b.dev && a.ino === b.ino;
};

/** A sortable UTC stamp, like the backups' names use. */
const stampOf = (epochMs: number) => new Date(epochMs).toISOString().replace(/[-:.]/g, "");

/** The journal for a restore of the database started at `nowMs`. */
export const planDatabaseRestoreSwap = (nowMs: number): RestoreJournal => ({
  version: 1,
  staging: `${STAGING_PREFIX}${stampOf(nowMs)}`,
  aside: `${ASIDE_PREFIX}${stampOf(nowMs)}`,
});

/** Every path a swap of the database at `dbPath` touches, from its journal's two names. */
export function restoreSwapPaths(dbPath: string, journal: RestoreJournal) {
  const stateDir = dirname(dbPath);
  const name = basename(dbPath);
  const stagingDir = join(stateDir, journal.staging);
  const aside = join(stateDir, journal.aside);
  return {
    target: dbPath,
    stagingDir,
    staged: join(stagingDir, name),
    aside,
    asideDatabase: join(aside, name),
    /** In order: the signing key, then the database's side files. */
    sideMoves: [
      {
        from: join(stateDir, "secrets", SESSION_SIGNING_KEY_FILE),
        to: join(aside, SESSION_SIGNING_KEY_FILE),
      },
      ...DATABASE_SIDE_FILE_SUFFIXES.map((suffix) => ({
        from: `${dbPath}${suffix}`,
        to: join(aside, `${name}${suffix}`),
      })),
    ],
  };
}

/** Whether `journal` names directories this module would have created. */
export const isPlannedJournal = (journal: RestoreJournal): boolean =>
  STAGING_NAME.test(journal.staging) && ASIDE_NAME.test(journal.aside);

const writeJournal = async (journalPath: string, journal: RestoreJournal) => {
  const partial = `${journalPath}.partial`;
  await writeFile(partial, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await syncFile(partial);
  await rename(partial, journalPath);
  await syncDirectory(dirname(journalPath));
};

const readJournal = async (journalPath: string): Promise<RestoreJournal> => {
  const journal = Schema.decodeUnknownSync(RestoreJournal)(
    JSON.parse(await readFile(journalPath, "utf8")),
  );
  if (!isPlannedJournal(journal)) {
    throw new Error(`${journalPath} does not describe a restore Ryco wrote; it was not used.`);
  }
  return journal;
};

const removeJournal = async (journalPath: string, stagingDir: string) => {
  await rm(stagingDir, { recursive: true, force: true });
  await rm(journalPath, { force: true });
  await syncDirectory(dirname(journalPath));
};

/**
 * Finishes the swap `journal` describes for the database at `dbPath`: see the module comment.
 * Safe to run again at any point, also after it finished (it then only removes the journal).
 */
export async function finishDatabaseRestoreSwap(
  journalPath: string,
  dbPath: string,
  journal: RestoreJournal,
): Promise<void> {
  const paths = restoreSwapPaths(dbPath, journal);
  if (await pathExists(paths.staged)) {
    await mkdir(paths.aside, { recursive: true, mode: 0o700 });
    for (const move of paths.sideMoves) {
      if (!(await pathExists(move.from))) continue;
      if (await pathExists(move.to)) {
        throw new Error(`${move.to} already exists, so ${move.from} was not moved there.`);
      }
      await rename(move.from, move.to);
    }
    if (await pathExists(paths.target)) {
      if (!(await pathExists(paths.asideDatabase))) {
        // A link keeps the database's name in place until the staged file replaces it.
        await link(paths.target, paths.asideDatabase).catch(async (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") {
            throw error;
          }
          await rename(paths.target, paths.asideDatabase);
        });
      } else if (!(await sameFile(paths.target, paths.asideDatabase))) {
        throw new Error(
          `${paths.asideDatabase} already exists, so ${paths.target} was not moved there.`,
        );
      }
    }
    await syncDirectory(paths.aside);
    for (const directory of new Set(paths.sideMoves.map((move) => dirname(move.from)))) {
      if (await pathExists(directory)) await syncDirectory(directory);
    }
    await rename(paths.staged, paths.target);
    await syncDirectory(dirname(paths.target));
  }
  await removeJournal(journalPath, paths.stagingDir);
}

/**
 * Undoes a swap that failed while it ran: removes the database's link (or moves the database
 * back), moves back the side files (never over another file), then removes the journal and the
 * staged copy. `completed` when the staged file already had its name: the restore went through.
 * Throws when something cannot go back, leaving the journal, so the next open finishes it.
 */
export async function undoDatabaseRestoreSwap(
  journalPath: string,
  dbPath: string,
  journal: RestoreJournal,
): Promise<"rolled-back" | "completed"> {
  const paths = restoreSwapPaths(dbPath, journal);
  if (!(await pathExists(paths.staged))) {
    await removeJournal(journalPath, paths.stagingDir);
    return "completed";
  }
  if (await pathExists(paths.asideDatabase)) {
    if (!(await pathExists(paths.target))) {
      await rename(paths.asideDatabase, paths.target);
    } else if (await sameFile(paths.target, paths.asideDatabase)) {
      await unlink(paths.asideDatabase);
    }
  }
  for (const move of paths.sideMoves.toReversed()) {
    if (!(await pathExists(move.to)) || (await pathExists(move.from))) continue;
    await rename(move.to, move.from);
  }
  for (const directory of new Set(paths.sideMoves.map((move) => dirname(move.from)))) {
    if (await pathExists(directory)) await syncDirectory(directory);
  }
  await removeJournal(journalPath, paths.stagingDir);
  // Only an empty one: a file that could not go back stays where it is.
  await rmdir(paths.aside).catch(() => undefined);
  return "rolled-back";
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
        await finishDatabaseRestoreSwap(journalPath, dbPath, await readJournal(journalPath));
        return true;
      },
      catch: (cause) =>
        swapError(
          `A restore of ${dbPath} was interrupted and could not be finished: ${errorText(cause)} ` +
            `Its journal is ${journalPath}; nothing was deleted.`,
          cause,
        ),
    }).pipe(Effect.uninterruptible);
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
      yield* Effect.logWarning(
        "finished an interrupted in-place restore of the database: every device and integration must pair again",
        { dbPath },
      );
    }
    return finished;
  });

export interface ReplaceResult extends RestoreResult {
  /** Where the replaced database, its files and the signing key were moved. */
  readonly replacedDir: string;
  /** The signing key was moved aside: every device must pair again. */
  readonly signedOut: boolean;
  /** Revoked in the restored database: pairing links not used yet, and integration credentials. */
  readonly revoked: { readonly pairingLinks: number; readonly integrations: number };
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

/** Revokes what a restored database would accept again; counts what it revoked. */
const secureRestoredDatabase = (openSqlite: OpenSqlite, staged: string, nowIso: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(openSqlite({ filename: staged, create: false }));
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tables = new Set(
          (yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table'
              AND name IN ('auth_pairing_links', 'agent_control_external_integrations')
          `).map((row) => row.name),
        );
        const pairingLinks = tables.has("auth_pairing_links")
          ? (yield* sql`
              UPDATE auth_pairing_links SET revoked_at = ${nowIso}
              WHERE revoked_at IS NULL AND consumed_at IS NULL
              RETURNING id
            `).length
          : 0;
        const integrations = tables.has("agent_control_external_integrations")
          ? (yield* sql`
              UPDATE agent_control_external_integrations SET revoked_at = ${nowIso}
              WHERE revoked_at IS NULL
              RETURNING integration_id
            `).length
          : 0;
        return { pairingLinks, integrations };
      }).pipe(Effect.provide(context));
    }),
  );

const refuse = (reason: DatabaseBackupCommandError["reason"], message: string) =>
  new DatabaseBackupCommandError({ reason, message });

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
  /** Runs between the journal and the swap (tests). */
  readonly beforeSwap?: (() => Promise<void>) | undefined;
}) {
  const dbPath = input.live.dbPath;
  const stateDir = dirname(dbPath);
  const journalPath = databaseRestoreJournalPath(dbPath);
  yield* finishInterruptedDatabaseRestore(dbPath, { owned: true });
  // No journal is left now, so no staging directory is in use (this process owns the database).
  yield* Effect.promise(async () => {
    for (const name of await readdir(stateDir).catch(() => [] as string[])) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      await rm(join(stateDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  });
  const liveEntry = yield* Effect.promise(() => lstat(dbPath).catch(() => null));
  if (liveEntry?.isSymbolicLink() === true) {
    return yield* refuse(
      "unsafe-target",
      `${dbPath} is a symbolic link. Restore into a new directory with --into, and replace the file it points to by hand. Nothing was changed.`,
    );
  }

  const journal = planDatabaseRestoreSwap(input.nowMs);
  const paths = restoreSwapPaths(dbPath, journal);
  const removeStaging = Effect.promise(() =>
    rm(paths.stagingDir, { recursive: true, force: true }).catch(() => undefined),
  );
  const restored = yield* restoreDatabaseBackup({
    file: input.file,
    target: { baseDir: paths.stagingDir, dbPath: paths.staged },
    live: input.live,
    openSqlite: input.openSqlite,
    fullCheck: input.fullCheck,
    staging: true,
  });
  if (!restored.opensWithThisBuild) {
    yield* removeStaging;
    return yield* refuse(
      "not-a-ryco-database",
      `${input.file} holds schema ${restored.schema}, newer than this build supports (${restored.supportedSchema}), so it cannot replace the database in use. Nothing was changed.`,
    );
  }
  if (restored.skippedMigrations.length > 0) {
    yield* removeStaging;
    return yield* refuse(
      "not-a-ryco-database",
      `Another branch or build of Ryco wrote ${input.file}: this build would skip its own migration${restored.skippedMigrations.length > 1 ? "s" : ""} ${restored.skippedMigrations.join(", ")} there. Restore it with the build that wrote it, or into a new directory with --into. Nothing was changed.`,
    );
  }

  const secured = yield* secureRestoredDatabase(
    input.openSqlite,
    paths.staged,
    new Date(input.nowMs).toISOString(),
  ).pipe(
    Effect.tapError(() => removeStaging),
    Effect.mapError((error) =>
      swapError(`Could not secure the restored copy: ${error.message} Nothing was changed.`, error),
    ),
  );
  if (liveEntry !== null) {
    yield* Effect.tryPromise({
      try: () => prepareCopyForSwap(paths.staged, dbPath),
      catch: (cause) =>
        refuse(
          "io",
          `Could not give the restored copy the database's owner and permissions (${errorText(cause)}). Nothing was changed.`,
        ),
    }).pipe(Effect.tapError(() => removeStaging));
  }

  // Right before the swap: staging can take minutes, and a process may have opened the file.
  const warnings: string[] = [];
  if (liveEntry !== null) {
    const state = yield* quiesceLiveDatabase(input.openSqlite, dbPath);
    if (state === "busy") {
      yield* removeStaging;
      return yield* refuse(
        "live-database",
        `Another process is reading ${dbPath} right now (a \`ryco\` command, a backup). Let it finish, then run this again. Nothing was changed.`,
      );
    }
    if (state === "unreadable") {
      warnings.push(
        `SQLite could not open ${dbPath}, so it and its write-ahead log were moved aside as they were.`,
      );
    }
    const holders = yield* otherHolders(
      dbPath,
      input.fileHolders ?? ((files) => findFileHolders({ paths: files })),
    );
    if (holders.kind === "unavailable" || holders.others.length > 0) {
      yield* removeStaging;
      return yield* refuse(
        "live-database",
        holders.kind === "unavailable"
          ? `Ryco cannot check whether another process has ${dbPath} open (${holders.reason}), and replacing it under one would corrupt the restored database. Restore into a new directory with --into instead. Nothing was changed.`
          : `${describeFileHolders(holders.others)} still has ${dbPath} open. Close it, then run this again. Nothing was changed.`,
      );
    }
  }

  const signedOut = yield* Effect.promise(() =>
    pathExists(paths.sideMoves[0]!.from).catch(() => true),
  );
  yield* Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => writeJournal(journalPath, journal),
      catch: (cause) => swapError(`Could not write ${journalPath}: ${errorText(cause)}`, cause),
    }).pipe(Effect.tapError(() => removeStaging));
    yield* Effect.tryPromise({
      try: async () => {
        await input.beforeSwap?.();
        await finishDatabaseRestoreSwap(journalPath, dbPath, journal);
      },
      catch: (cause) => swapError(errorText(cause), cause),
    }).pipe(
      Effect.catch((failure) =>
        Effect.tryPromise({
          try: () => undoDatabaseRestoreSwap(journalPath, dbPath, journal),
          catch: (undoCause) =>
            swapError(
              `The restore stopped part-way (${failure.message}) and could not be undone (${errorText(undoCause)}). ` +
                `Start Ryco or run this again to finish it; nothing was deleted, and what was moved is in ${paths.aside}.`,
              undoCause,
            ),
        }).pipe(
          Effect.flatMap((undone) =>
            undone === "completed"
              ? Effect.sync(() => {
                  warnings.push(`The restore went through, but then: ${failure.message}`);
                })
              : Effect.fail(
                  swapError(
                    `Could not swap the restored database in: ${failure.message} Nothing was changed.`,
                    failure.cause,
                  ),
                ),
          ),
        ),
      ),
    );
  }).pipe(Effect.uninterruptible);
  return {
    ...restored,
    path: dbPath,
    baseDir: input.live.baseDir,
    warnings: [...restored.warnings, ...warnings],
    replacedDir: paths.aside,
    signedOut,
    revoked: secured,
  } satisfies ReplaceResult;
});
