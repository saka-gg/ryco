// @effect-diagnostics nodeBuiltinImport:off - the copy needs lstat, realpath, no-follow opens, copy-on-write clones and synchronous renames, which Effect's FileSystem does not offer.
/**
 * flavorImport/consumeFlavorImport - Ryco Nightly takes over a copy of Ryco's data when Ryco
 * asked for one (port of Synara's `betaImport.ts`).
 *
 * Ryco writes `import-requested.json` into Nightly's data home and opens Nightly
 * (`@ryco/shared/flavorImport`). Before Nightly's server opens its database
 * (flavorImportStartup.ts), this:
 *
 * 1. Drops a request older than an hour (or dated ahead) without copying. The request only names
 *    a source; the desktop envelope allows one (`allowedSourceHome`: the home Ryco handed over,
 *    else `~/.ryco`). Any other source, Nightly's own home (also by real path, or one holding the
 *    other), and a home, state folder, database or sidecar that is a link are refused.
 * 2. Owns Nightly's database for the rest (owner lock, maintenance): never under a running server.
 * 3. Copies Ryco's live database with `VACUUM INTO` on a read connection (`copyLiveDatabase`, as
 *    `ryco db backup` does; Ryco keeps running) into a staging folder in Nightly's home, and
 *    refuses a database newer than this build.
 * 4. Migrates the copy as the server migrates its own, then scrubs it (flavorImportTablePolicy.ts):
 *    on this build's schema, so no later migration can rebuild what the scrub removed.
 * 5. Copies only `settings.json`, `keybindings.json`, `attachments/` and `task-files/` (cloned
 *    where the filesystem can), and refuses a link anywhere in them. Never the node identity,
 *    environment id, Hub state, secrets, saved connections, logs, backups, runtime files, caches
 *    or locks: Nightly stays a node of its own.
 * 6. Moves each staged entry over Nightly's, the database last after its leftover
 *    `-wal`/`-shm`/`-journal`, and keeps Nightly's previous entries aside until every move
 *    succeeded; a failed move puts them all back.
 * 7. Writes `import-result.json` and always removes the request.
 *
 * Nothing is ever written into Ryco's home. It never fails startup: a refused or failed copy
 * leaves Nightly's data as it was and says why in the result.
 *
 * Loaded with `import()` only when a request exists (flavorImportStartup.ts).
 *
 * @module flavorImport/consumeFlavorImport
 */
import { execFile } from "node:child_process";
import { constants, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { cp, lstat, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { promisify } from "node:util";

import {
  FLAVOR_IMPORT_REQUEST_FILE_NAME,
  FLAVOR_IMPORT_REQUEST_MAX_AGE_MS,
  FLAVOR_IMPORT_RESULT_FILE_NAME,
  FLAVOR_IMPORT_TOKEN_PATTERN,
  type FlavorImportRequest,
  type FlavorImportResult,
} from "@ryco/shared/flavorImport";
import { Cause, Data, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { syncDirectory } from "../fsDurability.ts";
import { copyLiveDatabase, type OpenSqlite } from "../persistence/databaseBackups.ts";
import type { ServerConfigShape } from "../config.ts";
import { asDatabaseOwner } from "../persistence/databaseOwnerLock.ts";
import { databaseRestoreJournalPath } from "../persistence/databaseRestoreJournal.ts";
import { makePrivateSqliteCopyLive, makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import { SUPPORTED_MIGRATION_ID } from "../persistence/Migrations.ts";
import { type FlavorImportScrubReport, scrubFlavorImportCopy } from "./flavorImportTablePolicy.ts";

/** Ryco's state folder in its data home (`deriveServerPaths` of a packaged app). */
const SOURCE_STATE_DIRECTORY = "userdata";
/** The files Nightly takes from Ryco's state folder besides the database. Nothing else is read. */
export const FLAVOR_IMPORT_COPIED_FILES = ["settings.json", "keybindings.json"] as const;
/**
 * Settings Nightly never takes from Ryco. Those that name Ryco's own folders keep Nightly's
 * defaults (folders in its own home): its idle chat-folder sweep and orphan cleanup act on these
 * folders, and must never reach Ryco's chats or worktrees. `automaticUpdates` lets a node replace
 * the machine's provider CLIs, and a CLI service node its own Ryco release, on its own; the owner
 * turns it on for each node, never by a copy.
 */
export const FLAVOR_IMPORT_DROPPED_SETTINGS = [
  "chatsRoot",
  "worktreeRoot",
  "projectWorktreeRoots",
  "automaticUpdates",
] as const;

/** `settings.json` without {@link FLAVOR_IMPORT_DROPPED_SETTINGS}; other files unchanged. */
function stagedFileContents(name: string, contents: Buffer): Buffer {
  if (name !== "settings.json") return contents;
  let settings: unknown;
  try {
    settings = JSON.parse(contents.toString("utf8"));
  } catch {
    // Nightly's settings loader treats an unreadable file as it treats its own.
    return contents;
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return contents;
  const kept = { ...(settings as Record<string, unknown>) };
  for (const key of FLAVOR_IMPORT_DROPPED_SETTINGS) delete kept[key];
  return Buffer.from(`${JSON.stringify(kept, null, 2)}\n`, "utf8");
}
export const FLAVOR_IMPORT_COPIED_FOLDERS = ["attachments", "task-files"] as const;
const DATABASE_SIDECARS = ["-wal", "-shm", "-journal"] as const;
/** In Nightly's home: copies being prepared, removed by the next copy if a crash left one. */
const STAGING_PREFIX = ".flavor-import-staging-";
/** In Nightly's home: its previous entries while the copy moves in. Never removed on its own. */
const PREVIOUS_PREFIX = ".flavor-import-previous-";
const REQUEST_MAX_BYTES = 64 * 1024;
/** A request dated this far ahead was not written by Ryco just now. */
const REQUEST_FUTURE_TOLERANCE_MS = 60_000;

export const FLAVOR_IMPORT_MESSAGES = {
  unreadable: "The copy request could not be read. Ask Ryco to copy your data again.",
  notAllowed: "The copy request names a folder that is not Ryco's data folder.",
  ownHome: "The copy request points at Ryco Nightly's own data.",
  otherLaunch:
    "The copy request was made while Ryco Nightly was already open. Quit Ryco Nightly, then copy again from Ryco.",
  noDatabase: "Ryco's data folder has no database to copy.",
  newer: "Ryco is newer than this Ryco Nightly. Update Ryco Nightly, then copy again.",
  restoreInterrupted:
    "Ryco Nightly is finishing an interrupted database restore. Open Ryco Nightly once, then copy again.",
  interrupted: "Ryco Nightly stopped before the copy finished. Its data is unchanged.",
} as const;

const linkedEntry = (path: string) => `Ryco Nightly copies no links, and ${path} is one.`;

/** The server configuration's paths, the envelope's allowance and the server's own pieces. */
export interface FlavorImportInput {
  /** Ryco Nightly's data home: the request, the result and the staging folders live here. */
  readonly baseDir: string;
  readonly stateDir: string;
  readonly dbPath: string;
  /** The only Ryco data home this app may copy from (the desktop envelope's `flavorImport`). */
  readonly allowedSourceHome: string;
  /** The token this launch of Ryco Nightly carried; only a request with it is taken. */
  readonly requestToken: string;
  /** The newest migration this build knows; a newer database is refused. */
  readonly supportedMigrationId: number;
  /** Opens a SQLite connection for the live copy (`makeRuntimeSqliteLayer`). */
  readonly openSqlite: OpenSqlite;
  /** Sets up and migrates a private copy as the server does its own (`makePrivateSqliteCopyLive`). */
  readonly migratedCopy: (dbPath: string) => Layer.Layer<SqlClient.SqlClient, Error>;
  /** Runs the copy as the owner of Nightly's database (maintenance ownership: no server runs). */
  readonly asDatabaseOwner: typeof asDatabaseOwner;
  /** Where an in-place restore keeps its journal beside a database. */
  readonly restoreJournalPath: (dbPath: string) => string;
  readonly now?: () => number;
  /** Replaced in tests to fail one move of the commit. */
  readonly rename?: (from: string, to: string) => void;
}

export type FlavorImportOutcome =
  | { readonly _tag: "NotRequested" }
  /** Dropped without copying; the result of an earlier copy is left as it is. */
  | { readonly _tag: "Stale" }
  | {
      readonly _tag: "Copied";
      /** The schema of Ryco's database when it was copied. */
      readonly schema: number;
      /** The entries besides the database that Ryco had and Nightly now has. */
      readonly entries: ReadonlyArray<string>;
      readonly scrub: FlavorImportScrubReport;
    }
  | { readonly _tag: "Refused"; readonly error: string };

class FlavorImportRefusal extends Data.TaggedError("FlavorImportRefusal")<{
  readonly message: string;
}> {}

const refusal = (message: string) => new FlavorImportRefusal({ message });

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

/** Runs `run`; a refusal it throws stays one, anything else becomes `<what>: <error>`. */
const attempt = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof FlavorImportRefusal ? cause : refusal(`${what}: ${errorText(cause)}`),
  });

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `child` is `parent` or inside it. */
const containsPath = (parent: string, child: string) => {
  const relative = Path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
};

/** The request file's contents; null when it is not a version 1 request with an absolute source. */
export function parseFlavorImportRequest(text: string): FlavorImportRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(record.requestedAt)) ||
    typeof record.sourceHomeDir !== "string" ||
    !Path.isAbsolute(record.sourceHomeDir) ||
    typeof record.token !== "string" ||
    !FLAVOR_IMPORT_TOKEN_PATTERN.test(record.token)
  ) {
    return null;
  }
  return {
    version: 1,
    requestedAt: record.requestedAt,
    sourceHomeDir: record.sourceHomeDir,
    token: record.token,
  };
}

/**
 * Reads a regular file without following a link at its last component. Non-blocking, so a FIFO
 * in its place is refused instead of holding startup until something writes to it.
 */
async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const readRequest = (markerPath: string) =>
  Effect.promise(async () => {
    try {
      const contents = await readRegularFile(markerPath, REQUEST_MAX_BYTES);
      return contents === null ? null : parseFlavorImportRequest(contents.toString("utf8"));
    } catch {
      return null;
    }
  });

/** Atomically, never through a link: an earlier result may be replaced, never followed. */
const writeResult = (
  homeDir: string,
  result: Omit<FlavorImportResult, "version" | "completedAt">,
) =>
  Effect.promise(async () => {
    const resultPath = Path.join(homeDir, FLAVOR_IMPORT_RESULT_FILE_NAME);
    const temporary = `${resultPath}.${process.pid}.tmp`;
    const contents: FlavorImportResult = {
      version: 1,
      completedAt: new Date().toISOString(),
      ...result,
    };
    try {
      await rm(temporary, { force: true });
      await writeFile(temporary, `${JSON.stringify(contents)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, resultPath);
    } catch {
      // Best effort: the result only tells Ryco how the copy went.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });

interface Source {
  readonly stateDir: string;
  readonly dbPath: string;
}

/** Everything about the request's source that can be checked before anything is copied. */
async function checkSource(
  input: FlavorImportInput,
  request: FlavorImportRequest,
): Promise<Source> {
  const source = Path.resolve(request.sourceHomeDir);
  const target = Path.resolve(input.baseDir);
  if (
    !Path.isAbsolute(input.allowedSourceHome) ||
    source !== Path.resolve(input.allowedSourceHome)
  ) {
    throw refusal(FLAVOR_IMPORT_MESSAGES.notAllowed);
  }
  if (source === target) throw refusal(FLAVOR_IMPORT_MESSAGES.ownHome);
  const home = await lstatOrNull(source);
  if (home?.isSymbolicLink()) throw refusal(linkedEntry(source));
  if (home === null || !home.isDirectory()) throw refusal(FLAVOR_IMPORT_MESSAGES.noDatabase);
  const [realSource, realTarget] = await Promise.all([realpath(source), realpath(target)]);
  if (containsPath(realSource, realTarget) || containsPath(realTarget, realSource)) {
    throw refusal(FLAVOR_IMPORT_MESSAGES.ownHome);
  }
  const stateDir = Path.join(source, SOURCE_STATE_DIRECTORY);
  const state = await lstatOrNull(stateDir);
  if (state?.isSymbolicLink()) throw refusal(linkedEntry(stateDir));
  if (state === null || !state.isDirectory()) throw refusal(FLAVOR_IMPORT_MESSAGES.noDatabase);
  const dbPath = Path.join(stateDir, Path.basename(input.dbPath));
  const database = await lstatOrNull(dbPath);
  if (database?.isSymbolicLink()) throw refusal(linkedEntry(dbPath));
  if (database === null || !database.isFile()) throw refusal(FLAVOR_IMPORT_MESSAGES.noDatabase);
  for (const suffix of DATABASE_SIDECARS) {
    const sidecar = await lstatOrNull(`${dbPath}${suffix}`);
    if (sidecar !== null && !sidecar.isFile()) throw refusal(linkedEntry(`${dbPath}${suffix}`));
  }
  // Nightly's state folder is replaced entry by entry: it must be the folder itself.
  if ((await lstatOrNull(input.stateDir))?.isSymbolicLink()) {
    throw refusal(linkedEntry(input.stateDir));
  }
  return { stateDir, dbPath };
}

/** Fails when `root` (a staged copy) holds anything but folders and regular files. */
async function assertPlainTree(root: string, shownAs: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory()) throw refusal(linkedEntry(shownAs));
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    for (const entry of await readdir(Path.join(root, relative), { withFileTypes: true })) {
      const entryPath = Path.join(relative, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (!entry.isFile()) throw refusal(linkedEntry(Path.join(shownAs, entryPath)));
    }
  }
}

const execFileAsync = promisify(execFile);

/** A copy of the folder `from` at the new path `to`, cloned where the filesystem can. */
async function copyFolder(from: string, to: string): Promise<void> {
  if (process.platform === "darwin") {
    // clonefile(2) on APFS, a full copy elsewhere; links are copied as links (and refused below).
    // Node's COPYFILE_FICLONE does a full copy on macOS (libuv).
    await execFileAsync("/bin/cp", ["-cRp", from, to]);
    return;
  }
  await cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

/** Stages the allowlisted files and folders of Ryco's state folder; returns the names it found. */
async function stageEntries(sourceStateDir: string, stagingDir: string): Promise<string[]> {
  const staged: string[] = [];
  for (const name of FLAVOR_IMPORT_COPIED_FILES) {
    const from = Path.join(sourceStateDir, name);
    const info = await lstatOrNull(from);
    if (info === null) continue;
    const contents = info.isFile() ? await readRegularFile(from, Number.MAX_SAFE_INTEGER) : null;
    if (contents === null) throw refusal(linkedEntry(from));
    await writeFile(Path.join(stagingDir, name), stagedFileContents(name, contents), {
      flag: "wx",
      mode: 0o600,
    });
    staged.push(name);
  }
  for (const name of FLAVOR_IMPORT_COPIED_FOLDERS) {
    const from = Path.join(sourceStateDir, name);
    const info = await lstatOrNull(from);
    if (info === null) continue;
    if (!info.isDirectory()) throw refusal(linkedEntry(from));
    const to = Path.join(stagingDir, name);
    await copyFolder(from, to);
    await assertPlainTree(to, from);
    staged.push(name);
  }
  return staged;
}

/**
 * Moves every staged entry over Nightly's, in one synchronous pass: the copied files and folders,
 * then the database's sidecars, then the database. An entry Ryco does not have is removed from
 * Nightly too, so Nightly ends up with exactly Ryco's. Nightly's previous entries wait in a folder
 * beside its state folder (same volume) until every move succeeded; a failure moves them back,
 * and a failure to move them back keeps that folder and names it.
 */
function commitStagedEntries(input: {
  readonly homeDir: string;
  readonly stagingDir: string;
  readonly targetStateDir: string;
  readonly databaseName: string;
  readonly rename: (from: string, to: string) => void;
}): void {
  const { stagingDir, targetStateDir } = input;
  if (!lstatSync(Path.join(stagingDir, input.databaseName)).isFile()) {
    throw refusal("The copy of Ryco's database is missing.");
  }
  mkdirSync(targetStateDir, { recursive: true, mode: 0o700 });
  const previousDir = mkdtempSync(Path.join(input.homeDir, PREVIOUS_PREFIX));
  const names = [
    ...FLAVOR_IMPORT_COPIED_FILES,
    ...FLAVOR_IMPORT_COPIED_FOLDERS,
    ...DATABASE_SIDECARS.map((suffix) => `${input.databaseName}${suffix}`),
    input.databaseName,
  ];
  const moved: Array<{ readonly name: string; readonly hadPrevious: boolean }> = [];
  try {
    for (const name of names) {
      const target = Path.join(targetStateDir, name);
      const hadPrevious = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
      if (hadPrevious) input.rename(target, Path.join(previousDir, name));
      moved.push({ name, hadPrevious });
      const staged = Path.join(stagingDir, name);
      if (lstatSync(staged, { throwIfNoEntry: false }) !== undefined) input.rename(staged, target);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const { name, hadPrevious } of moved.toReversed()) {
      try {
        rmSync(Path.join(targetStateDir, name), { recursive: true, force: true });
        if (hadPrevious) renameSync(Path.join(previousDir, name), Path.join(targetStateDir, name));
      } catch (rollbackError) {
        failures.push(`${name}: ${errorText(rollbackError)}`);
      }
    }
    if (failures.length > 0) {
      throw refusal(
        `The copy could not be moved into place (${errorText(error)}), and Ryco Nightly could not put all of its previous data back. It is in ${previousDir} (${failures.join("; ")}).`,
      );
    }
    rmSync(previousDir, { recursive: true, force: true });
    throw refusal(
      `The copy could not be moved into place (${errorText(error)}). Ryco Nightly's data is unchanged.`,
    );
  }
  rmSync(previousDir, { recursive: true, force: true });
}

/** Removes staging folders a crashed copy left in Nightly's home (copies only, never originals). */
const removeLeftoverStaging = (homeDir: string) =>
  Effect.promise(async () => {
    const entries = await readdir(homeDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
        await rm(Path.join(homeDir, entry.name), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  });

/** Migrates the staged database to this build's schema, scrubs it and folds it into one file. */
const migrateAndScrub = (input: FlavorImportInput, stagedDbPath: string, now: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(input.migratedCopy(stagedDbPath)).pipe(
        Effect.mapError((cause) =>
          refusal(
            `Ryco Nightly could not upgrade the copy of Ryco's database: ${errorText(cause)}`,
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const report = yield* scrubFlavorImportCopy(now);
        const sql = yield* SqlClient.SqlClient;
        // One self-contained file: nothing of the copy lives in a WAL that could be left behind.
        yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
        yield* sql.unsafe("PRAGMA journal_mode = DELETE");
        return report;
      }).pipe(
        Effect.provide(context),
        Effect.mapError((cause) =>
          refusal(
            `Ryco Nightly could not prepare the copy of Ryco's database: ${errorText(cause)}`,
          ),
        ),
      );
    }),
  );

/** Set once Nightly's entries were replaced: from then on its data is the copy. */
interface CopyProgress {
  committed: boolean;
}

/** The copy itself, under Nightly's database ownership; fails with a refusal that says why. */
const copyRequestedData = (
  input: FlavorImportInput,
  request: FlavorImportRequest,
  progress: CopyProgress,
) =>
  Effect.gen(function* () {
    const source = yield* attempt("Ryco's data folder could not be read", () =>
      checkSource(input, request),
    );
    return yield* input
      .asDatabaseOwner(
        input.dbPath,
        "copy Ryco's data into Ryco Nightly",
        copySource(input, source, progress),
      )
      .pipe(Effect.catchTag("DatabaseOwnedError", (error) => Effect.fail(refusal(error.message))));
  });

const copySource = (input: FlavorImportInput, source: Source, progress: CopyProgress) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (
        (yield* attempt("Ryco Nightly's data could not be read", () =>
          lstatOrNull(input.restoreJournalPath(input.dbPath)),
        )) !== null
      ) {
        return yield* refusal(FLAVOR_IMPORT_MESSAGES.restoreInterrupted);
      }
      yield* removeLeftoverStaging(input.baseDir);
      const stagingDir = yield* Effect.acquireRelease(
        attempt("Ryco Nightly could not prepare the copy", async () =>
          mkdtempSync(Path.join(input.baseDir, STAGING_PREFIX)),
        ),
        (directory) =>
          Effect.promise(() =>
            rm(directory, { recursive: true, force: true }).catch(() => undefined),
          ),
      );
      const databaseName = Path.basename(input.dbPath);
      const stagedDbPath = Path.join(stagingDir, databaseName);
      const copy = yield* copyLiveDatabase({
        dbPath: source.dbPath,
        destination: stagedDbPath,
        openSqlite: input.openSqlite,
      }).pipe(Effect.mapError((error) => refusal(error.message)));
      if (copy.schema > input.supportedMigrationId) {
        return yield* refusal(FLAVOR_IMPORT_MESSAGES.newer);
      }
      const scrub = yield* migrateAndScrub(
        input,
        stagedDbPath,
        new Date((input.now ?? Date.now)()).toISOString(),
      );
      const entries = yield* attempt("Ryco's files could not be copied", () =>
        stageEntries(source.stateDir, stagingDir),
      );
      yield* Effect.try({
        try: () => {
          commitStagedEntries({
            homeDir: input.baseDir,
            stagingDir,
            targetStateDir: input.stateDir,
            databaseName,
            rename: input.rename ?? renameSync,
          });
          progress.committed = true;
        },
        catch: (cause) =>
          cause instanceof FlavorImportRefusal
            ? cause
            : refusal(`The copy could not be moved into place: ${errorText(cause)}`),
      }).pipe(Effect.uninterruptible);
      yield* Effect.promise(() => syncDirectory(input.stateDir).catch(() => undefined));
      return { schema: copy.schema, entries, scrub };
    }),
  );

const consumeRequest = (input: FlavorImportInput, markerPath: string) =>
  Effect.gen(function* () {
    const request = yield* readRequest(markerPath);
    if (request === null) {
      yield* writeResult(input.baseDir, { ok: false, error: FLAVOR_IMPORT_MESSAGES.unreadable });
      return { _tag: "Refused", error: FLAVOR_IMPORT_MESSAGES.unreadable } as const;
    }
    // Only the request of this launch: one written while Nightly was already open never
    // reached a launch, and must not replace what Nightly gathers until its next start.
    if (request.token !== input.requestToken) {
      yield* writeResult(input.baseDir, { ok: false, error: FLAVOR_IMPORT_MESSAGES.otherLaunch });
      return { _tag: "Refused", error: FLAVOR_IMPORT_MESSAGES.otherLaunch } as const;
    }
    const age = (input.now ?? Date.now)() - Date.parse(request.requestedAt);
    if (age > FLAVOR_IMPORT_REQUEST_MAX_AGE_MS || age < -REQUEST_FUTURE_TOLERANCE_MS) {
      return { _tag: "Stale" } as const;
    }
    const progress: CopyProgress = { committed: false };
    return yield* copyRequestedData(input, request, progress).pipe(
      Effect.map((copied): FlavorImportOutcome => ({ _tag: "Copied", ...copied })),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const failure = Cause.squash(cause);
        return Effect.succeed<FlavorImportOutcome>({
          _tag: "Refused",
          error:
            failure instanceof FlavorImportRefusal
              ? failure.message
              : `The copy failed: ${errorText(failure)}`,
        });
      }),
      // Also when the app quits meanwhile: once the entries moved, the copy is what Nightly has.
      Effect.onExit((exit) =>
        writeResult(
          input.baseDir,
          exit._tag === "Success"
            ? exit.value._tag === "Refused"
              ? { ok: false, error: exit.value.error }
              : { ok: true }
            : progress.committed
              ? { ok: true }
              : { ok: false, error: FLAVOR_IMPORT_MESSAGES.interrupted },
        ),
      ),
    );
  });

const logOutcome = (outcome: FlavorImportOutcome) => {
  switch (outcome._tag) {
    case "Copied":
      return Effect.logInfo("copied Ryco's data into Ryco Nightly", {
        schema: outcome.schema,
        entries: outcome.entries,
        cleared: outcome.scrub.cleared.length,
        rewritten: outcome.scrub.rewritten,
        unknownCleared: outcome.scrub.unknownCleared,
      });
    case "Refused":
      return Effect.logWarning("did not copy Ryco's data into Ryco Nightly", {
        reason: outcome.error,
      });
    case "Stale":
      return Effect.logInfo("dropped a request to copy Ryco's data that was not recent");
    case "NotRequested":
      return Effect.void;
  }
};

/**
 * Copies Ryco's data into Ryco Nightly when a request is waiting in Nightly's home. Never fails;
 * the request is gone afterwards whatever happened.
 */
export const consumeFlavorImport = (input: FlavorImportInput): Effect.Effect<FlavorImportOutcome> =>
  Effect.gen(function* () {
    const markerPath = Path.join(input.baseDir, FLAVOR_IMPORT_REQUEST_FILE_NAME);
    const marker = yield* Effect.promise(() => lstatOrNull(markerPath).catch(() => undefined));
    if (marker === null) return { _tag: "NotRequested" } as const;
    return yield* consumeRequest(input, markerPath).pipe(
      Effect.tap(logOutcome),
      Effect.ensuring(
        Effect.promise(() =>
          // Recursive: a folder by that name must not stay behind and be met on every start.
          rm(markerPath, { recursive: true, force: true }).catch(() => undefined),
        ),
      ),
    );
  });

/** {@link consumeFlavorImport} with this server's configuration and persistence. */
export const runFlavorImport = (
  config: Pick<ServerConfigShape, "flavorImport" | "baseDir" | "stateDir" | "dbPath">,
): Effect.Effect<FlavorImportOutcome> =>
  config.flavorImport === undefined
    ? Effect.succeed({ _tag: "NotRequested" })
    : consumeFlavorImport({
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        dbPath: config.dbPath,
        allowedSourceHome: config.flavorImport.allowedSourceHome,
        requestToken: config.flavorImport.requestToken,
        supportedMigrationId: SUPPORTED_MIGRATION_ID,
        openSqlite: makeRuntimeSqliteLayer,
        migratedCopy: makePrivateSqliteCopyLive,
        asDatabaseOwner,
        restoreJournalPath: databaseRestoreJournalPath,
      });
