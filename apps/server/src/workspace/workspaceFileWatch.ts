/**
 * Live revalidation of one open workspace file (`projects.subscribeFileChanges`).
 * The handler imports this module on the first subscription: nothing here is
 * needed at boot, and the server's boot chunks have a size budget
 * (`serverBundleBoundaries.test.ts`).
 *
 * Each subscription watches the file's real parent folder, not the file: an
 * atomic save renames a new file over the old one, which a watch on the old
 * file's inode would never see. One process-wide registry keeps a single
 * reference-counted `fs.watch` per folder and fans its events out by name.
 *
 * Every evaluation resolves the path again through the workspace's
 * containment rules before it looks at the file, so a file that becomes a
 * link out of the project reads as deleted and is never stat-ed or hashed.
 * Events carry the `projects.readFile` version of the file's bytes, never its
 * content: a client that sees a version it does not hold reads the file
 * through `projects.readFile`, with that read's limits and authorization.
 */
import { watch as watchFileSystem, type BigIntStats, type FSWatcher } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type ProjectFileChangeEvent,
  ProjectWatchFileError,
  type ProjectWatchFileInput,
} from "@ryco/contracts";
import {
  NotRegularFileError,
  type OpenedRegularFile,
  openRegularFile,
} from "@ryco/shared/regularFile";
import { Cause, Clock, Duration, Effect, Option, Queue, Schema, Stream } from "effect";

import type { WorkspaceFileSystemShape } from "./Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./Services/WorkspacePaths.ts";
import { fileVersion, sameFileState, WORKSPACE_PREVIEW_MAX_BYTES } from "./previewFile.ts";

/** A burst of events (a save, a checkout) is evaluated once, this long after its last event. */
export const FILE_WATCH_DEBOUNCE_MS = 100;
/**
 * Per subscription: evaluations (and so events) are at least this far apart,
 * and a file that keeps changing is still evaluated this often. Only the
 * latest state is kept in between.
 */
export const FILE_WATCH_MIN_EVENT_INTERVAL_MS = 250;
/** One open file per panel; a connection that asks for more is refused with `limit`. */
export const MAX_FILE_WATCHES_PER_CONNECTION = 8;
/**
 * Folders watched at once across the node. FSEvents and inotify capacity is
 * finite and the settings and keybindings watchers share it, so a new folder
 * past this is refused with `limit` rather than risking theirs.
 */
export const MAX_WATCHED_DIRECTORIES = 256;
/** Events queued for a slow client; older ones are dropped, each event is a full state. */
const FILE_WATCH_EVENT_BUFFER = 8;

const watchFailure = (reason: ProjectWatchFileError["reason"]) =>
  new ProjectWatchFileError({
    reason,
    message:
      reason === "outside-root"
        ? "Workspace file path must stay within the project root."
        : reason === "limit"
          ? "Too many files are watched already."
          : "The file's folder cannot be watched now.",
  });

/** Gets each event in a folder for one name; `onFailure` when the folder's watch stops. */
interface DirectoryListener {
  readonly onChange: () => void;
  readonly onFailure: () => void;
}

type WatchFolder = (
  directory: string,
  onEvent: (filename: string | Buffer | null) => void,
) => FSWatcher;

export interface FileWatchRegistry {
  /**
   * Starts delivering `directory`'s events for `name` to `listener`, sharing
   * the folder's watch with every other listener. Null when the node already
   * watches `MAX_WATCHED_DIRECTORIES` other folders. Throws when the folder
   * cannot be watched. The returned release is idempotent; the folder's watch
   * closes with its last listener.
   */
  readonly listen: (
    directory: string,
    name: string,
    listener: DirectoryListener,
  ) => (() => void) | null;
  /** Folders watched now. */
  readonly watchedDirectories: () => number;
}

interface WatchedDirectory {
  readonly watcher: FSWatcher;
  readonly listeners: Map<string, Set<DirectoryListener>>;
  closed: boolean;
}

export function makeFileWatchRegistry(options?: {
  readonly watchFolder?: WatchFolder;
  readonly maxDirectories?: number;
}): FileWatchRegistry {
  const watchFolder: WatchFolder =
    options?.watchFolder ??
    ((directory, onEvent) =>
      // Not persistent: a watch never keeps the process alive on its own.
      watchFileSystem(directory, { persistent: false }, (_event, filename) => onEvent(filename)));
  const maxDirectories = options?.maxDirectories ?? MAX_WATCHED_DIRECTORIES;
  const directories = new Map<string, WatchedDirectory>();

  const close = (directory: string, entry: WatchedDirectory) => {
    if (entry.closed) return;
    entry.closed = true;
    if (directories.get(directory) === entry) directories.delete(directory);
    // Its error listener stays: an emitter without one throws on a late error.
    entry.watcher.close();
  };

  const listen: FileWatchRegistry["listen"] = (directory, name, listener) => {
    let entry = directories.get(directory);
    if (entry === undefined) {
      if (directories.size >= maxDirectories) return null;
      const listeners = new Map<string, Set<DirectoryListener>>();
      const folderName = NodePath.basename(directory);
      const watcher = watchFolder(directory, (filename) => {
        // Some platforms omit the name, and an event about the folder itself (removed,
        // renamed) carries the folder's own name, sometimes in place of its files' events:
        // every listener then re-evaluates.
        const changed = filename === null ? null : NodePath.basename(filename.toString());
        const everyone = changed === null || changed === folderName;
        for (const [watchedName, named] of listeners) {
          if (!everyone && changed !== watchedName) continue;
          for (const each of Array.from(named)) each.onChange();
        }
      });
      const created: WatchedDirectory = { watcher, listeners, closed: false };
      entry = created;
      watcher.on("error", () => {
        if (created.closed) return;
        close(directory, created);
        const failed = Array.from(listeners.values()).flatMap((named) => Array.from(named));
        listeners.clear();
        for (const each of failed) each.onFailure();
      });
      directories.set(directory, created);
    }
    const watched = entry;
    let named = watched.listeners.get(name);
    if (named === undefined) {
      named = new Set();
      watched.listeners.set(name, named);
    }
    named.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = watched.listeners.get(name);
      current?.delete(listener);
      if (current?.size === 0) watched.listeners.delete(name);
      if (watched.listeners.size === 0) close(directory, watched);
    };
  };

  return { listen, watchedDirectories: () => directories.size };
}

/** The node's registry, shared by every connection. */
const processFileWatchRegistry = makeFileWatchRegistry();

/** Files one connection watches now, against `MAX_FILE_WATCHES_PER_CONNECTION`. */
export interface ConnectionFileWatches {
  active: number;
}

/**
 * When the next evaluation may run: `FILE_WATCH_DEBOUNCE_MS` after the latest
 * event, but no later than `FILE_WATCH_MIN_EVENT_INTERVAL_MS` after the first
 * one still waiting (a file that keeps changing is still evaluated), and never
 * sooner than that interval after the previous evaluation.
 */
export function nextFileWatchEvaluationAt(input: {
  readonly firstSignalAt: number;
  readonly lastSignalAt: number;
  readonly lastEvaluationAt: number;
}): number {
  return Math.max(
    Math.min(
      input.lastSignalAt + FILE_WATCH_DEBOUNCE_MS,
      input.firstSignalAt + FILE_WATCH_MIN_EVENT_INTERVAL_MS,
    ),
    input.lastEvaluationAt + FILE_WATCH_MIN_EVENT_INTERVAL_MS,
  );
}

type WatchedFileState =
  | { readonly kind: "deleted" }
  | {
      readonly kind: "file";
      readonly realPath: string;
      readonly version: string | null;
      /** The stat the version was taken at; a later identical stat skips the hash. */
      readonly stat: BigIntStats | null;
    };

const DELETED: WatchedFileState = { kind: "deleted" };

function isMissingPathError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The state of the file at `realPath`, a real path containment just approved.
 * "retry" when the file changed while it was read: its own event follows.
 */
async function readWatchedFileState(
  realPath: string,
  previous: WatchedFileState | null,
): Promise<WatchedFileState | "retry"> {
  let stat: BigIntStats;
  try {
    // Not followed: a real path ends in a link only when one was swapped in since.
    stat = await NodeFs.lstat(realPath, { bigint: true });
  } catch (cause) {
    return isMissingPathError(cause)
      ? DELETED
      : { kind: "file", realPath, version: null, stat: null };
  }
  if (!stat.isFile() || stat.size > BigInt(WORKSPACE_PREVIEW_MAX_BYTES)) {
    return { kind: "file", realPath, version: null, stat };
  }
  if (
    previous?.kind === "file" &&
    previous.realPath === realPath &&
    previous.version !== null &&
    previous.stat !== null &&
    sameFileState(previous.stat, stat)
  ) {
    return previous;
  }
  let opened: OpenedRegularFile<BigIntStats>;
  try {
    // Never follows a final link and never waits on a FIFO.
    opened = await openRegularFile(realPath, { bigint: true });
  } catch (cause) {
    if (isMissingPathError(cause)) return DELETED;
    return cause instanceof NotRegularFileError
      ? { kind: "file", realPath, version: null, stat }
      : "retry";
  }
  try {
    if (!sameFileState(stat, opened.stat)) return "retry";
    const bytes = await opened.handle.readFile();
    const after = await opened.handle.stat({ bigint: true });
    if (bytes.byteLength !== Number(after.size) || !sameFileState(opened.stat, after)) {
      return "retry";
    }
    return { kind: "file", realPath, version: fileVersion(bytes), stat: after };
  } catch {
    return "retry";
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

function sameFolder(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export interface WorkspaceFileWatchDependencies {
  /** The workspace's containment rules (`WorkspaceFileSystem.resolveTarget`). */
  readonly resolveTarget: WorkspaceFileSystemShape["resolveTarget"];
  /** The subscribing connection's count of open watches. */
  readonly connection: ConnectionFileWatches;
  readonly registry?: FileWatchRegistry;
}

/**
 * Change notices for one workspace file: `current` (or `deleted`) once the
 * watch is in place, then `changed` or `deleted` whenever the file's version,
 * or whether it exists, changes. Fails with `outside-root` for a path that
 * leaves the root, `limit` past the per-connection and per-node caps, and
 * `unavailable` when the folder cannot be watched or its watch stops: the
 * folder was removed or replaced, or the file now lives in another folder. A
 * later subscription watches wherever the file is then.
 */
export const watchWorkspaceFile = (
  dependencies: WorkspaceFileWatchDependencies,
  input: ProjectWatchFileInput,
): Stream.Stream<ProjectFileChangeEvent, ProjectWatchFileError> =>
  Stream.callback<ProjectFileChangeEvent, ProjectWatchFileError>(
    (events) =>
      Effect.gen(function* () {
        const connection = dependencies.connection;
        if (connection.active >= MAX_FILE_WATCHES_PER_CONNECTION) {
          return yield* watchFailure("limit");
        }
        connection.active += 1;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            connection.active -= 1;
          }),
        );

        const resolveRealPath = dependencies
          .resolveTarget(input)
          .pipe(Effect.map((target) => target.realPath));
        const realPath = yield* resolveRealPath.pipe(
          Effect.mapError((cause) =>
            watchFailure(
              Schema.is(WorkspacePathOutsideRootError)(cause) ? "outside-root" : "unavailable",
            ),
          ),
        );
        const directory = NodePath.dirname(realPath);
        const folder = yield* Effect.tryPromise({
          try: () => NodeFs.stat(directory, { bigint: true }),
          catch: () => watchFailure("unavailable"),
        });
        if (!folder.isDirectory()) return yield* watchFailure("unavailable");

        const signals = yield* Queue.sliding<void>(1);
        const registry = dependencies.registry ?? processFileWatchRegistry;
        yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              registry.listen(directory, NodePath.basename(realPath), {
                onChange: () => {
                  Queue.offerUnsafe(signals, undefined);
                },
                onFailure: () => {
                  Queue.failCauseUnsafe(events, Cause.fail(watchFailure("unavailable")));
                },
              }),
            catch: (cause) => {
              const code = (cause as NodeJS.ErrnoException | null)?.code;
              // Out of watch descriptors: the node's capacity, not this folder.
              return watchFailure(code === "ENOSPC" || code === "EMFILE" ? "limit" : "unavailable");
            },
          }).pipe(
            Effect.flatMap((release) =>
              release === null ? Effect.fail(watchFailure("limit")) : Effect.succeed(release),
            ),
          ),
          (release) => Effect.sync(release),
        );

        let state: WatchedFileState | null = null;
        let lastEvaluationAt = Number.NEGATIVE_INFINITY;
        const evaluate = Effect.gen(function* () {
          lastEvaluationAt = yield* Clock.currentTimeMillis;
          // Containment again, every time: a file can become a link out of the root later.
          const resolved = yield* Effect.option(resolveRealPath);
          const next = Option.isNone(resolved)
            ? DELETED
            : yield* Effect.promise(() => readWatchedFileState(resolved.value, state));
          if (next === "retry") {
            Queue.offerUnsafe(signals, undefined);
            return;
          }
          const previous = state;
          state = next;
          if (
            previous === null ||
            previous.kind !== next.kind ||
            (previous.kind === "file" && next.kind === "file" && previous.version !== next.version)
          ) {
            Queue.offerUnsafe(
              events,
              next.kind === "deleted"
                ? { type: "deleted" }
                : { type: previous === null ? "current" : "changed", version: next.version },
            );
          }
          // This watch can no longer see the file's next change: its folder is gone or was
          // replaced, or the file now lives in another folder.
          const moved =
            next.kind === "deleted"
              ? yield* Effect.promise(() =>
                  NodeFs.stat(directory, { bigint: true }).then(
                    (current) => !current.isDirectory() || !sameFolder(folder, current),
                    () => true,
                  ),
                )
              : next.realPath !== realPath;
          if (moved) return yield* watchFailure("unavailable");
        });

        const waitForChange = Effect.gen(function* () {
          yield* Queue.take(signals);
          const firstSignalAt = yield* Clock.currentTimeMillis;
          let lastSignalAt = firstSignalAt;
          for (;;) {
            const now = yield* Clock.currentTimeMillis;
            const dueAt = nextFileWatchEvaluationAt({
              firstSignalAt,
              lastSignalAt,
              lastEvaluationAt,
            });
            if (now >= dueAt) return;
            const another = yield* Queue.take(signals).pipe(
              Effect.timeoutOption(Duration.millis(dueAt - now)),
            );
            if (Option.isSome(another)) lastSignalAt = yield* Clock.currentTimeMillis;
          }
        });

        yield* evaluate;
        for (;;) {
          yield* waitForChange;
          yield* evaluate;
        }
      }).pipe(
        // An unexpected failure ends the stream the way a stopped watch does.
        Effect.catchDefect(() => Effect.fail(watchFailure("unavailable"))),
      ),
    { bufferSize: FILE_WATCH_EVENT_BUFFER, strategy: "sliding" },
  );
