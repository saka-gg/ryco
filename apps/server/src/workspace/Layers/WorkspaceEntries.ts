import * as OS from "node:os";
import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";
import { execFile } from "node:child_process";

import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Option,
  Path,
  Result,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import {
  type FilesystemBrowseInput,
  type ProjectEntry,
  type ProjectListEntriesResult,
} from "@ryco/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@ryco/shared/path";
import {
  normalizeWorkspaceEntryQuery,
  rankWorkspaceEntries,
  workspaceEntryDepth,
  workspaceEntryParentPath,
  type WorkspaceEntryKind,
  type WorkspaceEntrySearchKey,
} from "@ryco/shared/workspaceEntrySearch";

import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import type { VcsDriverShape } from "../../vcs/VcsDriver.ts";
import {
  WorkspaceEntries,
  WorkspaceEntriesBrowseError,
  WorkspaceEntriesError,
  type WorkspaceEntriesShape,
} from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { WorkspaceAccessPolicy } from "../Services/WorkspaceAccessPolicy.ts";

/**
 * The `@` file picker index is stale-while-revalidate: reads never wait for a
 * rebuild once a root has an index. Reads of an index older than this
 * revalidate it in the background.
 */
const WORKSPACE_INDEX_REVALIDATE_AFTER_MS = 15_000;
/**
 * An invalidated root read within this window rebuilds in the background so
 * the next `@` is warm; colder roots just drop their index.
 */
const WORKSPACE_INDEX_HOT_WINDOW_MS = 10 * 60_000;
/** Collapses bursts of invalidations (checkpoint capture, file writes) into one rebuild. */
const WORKSPACE_INDEX_REBUILD_DEBOUNCE_MS = 250;
/**
 * A cold read waits this long for the full build, then gets a tracked-files
 * index (one fast `ls-files -c`) while the full build finishes in the
 * background.
 */
const WORKSPACE_INDEX_COLD_BUILD_DEADLINE_MS = 4_000;
/** A failed build is reported to readers this long before it is retried. */
const WORKSPACE_INDEX_FAILURE_RETRY_MS = 5_000;
/** Index builds running at once across all roots (each spawns git or walks a tree). */
const WORKSPACE_INDEX_BUILD_CONCURRENCY = 2;
/** Entries held across every cached index; the least recently read roots go first. */
const WORKSPACE_INDEX_ENTRY_BUDGET = 300_000;
const WORKSPACE_INDEX_MAX_ROOTS = 32;
/**
 * Search corpus cap for one VCS root. Search scans every indexed path, so this
 * is far above the listEntries payload cap; past it, shallower paths win.
 */
const WORKSPACE_INDEX_MAX_ENTRIES = 200_000;
/** The non-VCS fallback walks the tree breadth-first and stops here. */
const WORKSPACE_FILESYSTEM_INDEX_MAX_ENTRIES = 25_000;
/** listEntries payload cap; the files tree opens collapsed, so it gets the shallowest entries. */
const WORKSPACE_LIST_ENTRIES_MAX = 25_000;
/** Index construction yields to the event loop between chunks of this many paths. */
const WORKSPACE_INDEX_BUILD_CHUNK = 20_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

type IndexedWorkspaceEntry = WorkspaceEntrySearchKey;

interface WorkspaceIndex {
  readonly builtAt: number;
  /** Mutable: file writes patch new paths in place. */
  readonly entries: IndexedWorkspaceEntry[];
  /** Covers only part of the workspace: a size cap was hit, or a tracked-files fallback. */
  readonly partial: boolean;
  /** The listEntries payload, built on first request and dropped when `entries` change. */
  listing: ProjectListEntriesResult | null;
}

interface WorkspaceIndexSlot {
  readonly cwd: string;
  index: WorkspaceIndex | null;
  lastReadAt: number;
  /** Invalidated since `index` was built. */
  dirty: boolean;
  /** Bumped on every invalidation, so a build that raced one leaves the slot dirty. */
  generation: number;
  refreshing: boolean;
  /** Completes when the running refresh ends, however it ends. */
  refreshDone: Deferred.Deferred<void> | null;
  rebuildScheduled: boolean;
  degradedBuildStarted: boolean;
  /** Cold readers wait here for the first index (full or degraded) of a refresh. */
  waiters: Deferred.Deferred<WorkspaceIndex, WorkspaceEntriesError> | null;
  failure: { readonly error: WorkspaceEntriesError; readonly at: number } | null;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

function toIndexedEntry(path: string, kind: WorkspaceEntryKind): IndexedWorkspaceEntry {
  return { path, kind, normalizedPath: path.toLowerCase() };
}

function toProjectEntry(entry: IndexedWorkspaceEntry): ProjectEntry {
  const parentPath = workspaceEntryParentPath(entry.path);
  return parentPath === undefined
    ? { path: entry.path, kind: entry.kind }
    : { path: entry.path, kind: entry.kind, parentPath };
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const separatorIndex = relativePath.indexOf("/");
  const firstSegment = separatorIndex === -1 ? relativePath : relativePath.slice(0, separatorIndex);
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

/**
 * Adds every ancestor directory of `filePath`, deepest first, stopping at the
 * first one already present: its own ancestors were added with it.
 */
function addDirectoryAncestors(directories: Set<string>, filePath: string): void {
  for (
    let separatorIndex = filePath.lastIndexOf("/");
    separatorIndex > 0;
    separatorIndex = filePath.lastIndexOf("/", separatorIndex - 1)
  ) {
    const directoryPath = filePath.slice(0, separatorIndex);
    if (directories.has(directoryPath)) return;
    directories.add(directoryPath);
  }
}

/**
 * Keeps the shallowest files (listing order breaks ties, so tracked files
 * precede untracked ones) until files plus their directories reach `budget`.
 */
function selectShallowestFiles(
  filePaths: ReadonlyArray<string>,
  budget: number,
): { readonly files: string[]; readonly directories: Set<string> } {
  const byDepth: string[][] = [];
  for (const filePath of filePaths) {
    const depth = workspaceEntryDepth(filePath);
    (byDepth[depth] ??= []).push(filePath);
  }
  const files: string[] = [];
  const directories = new Set<string>();
  for (const bucket of byDepth) {
    if (bucket === undefined) continue;
    for (const filePath of bucket) {
      if (files.length + directories.size >= budget) {
        return { files, directories };
      }
      files.push(filePath);
      addDirectoryAncestors(directories, filePath);
    }
  }
  return { files, directories };
}

function selectShallowestEntries(
  entries: ReadonlyArray<IndexedWorkspaceEntry>,
  limit: number,
): ReadonlyArray<IndexedWorkspaceEntry> {
  if (entries.length <= limit) return entries;
  const byDepth: IndexedWorkspaceEntry[][] = [];
  for (const entry of entries) {
    (byDepth[workspaceEntryDepth(entry.path)] ??= []).push(entry);
  }
  const kept: IndexedWorkspaceEntry[] = [];
  for (const bucket of byDepth) {
    if (bucket === undefined) continue;
    for (const entry of bucket) {
      if (kept.length >= limit) return kept;
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * The listEntries payload: the whole index, or its shallowest entries past
 * the cap. Only `path` and `kind` travel (the parent derives from the path),
 * and nothing is sorted: tree consumers order each directory themselves.
 */
function buildWorkspaceListing(index: WorkspaceIndex): ProjectListEntriesResult {
  const selected = selectShallowestEntries(index.entries, WORKSPACE_LIST_ENTRIES_MAX);
  return {
    entries: selected.map((entry) => ({ path: entry.path, kind: entry.kind })),
    truncated: index.partial || selected.length < index.entries.length,
  };
}

/** The build failure to report, or null when the build was only interrupted. */
function failureOf(
  cause: Cause.Cause<WorkspaceEntriesError>,
  cwd: string,
): WorkspaceEntriesError | null {
  if (Cause.hasInterruptsOnly(cause)) return null;
  const error = Cause.findError(cause);
  if (Result.isSuccess(error)) return error.success;
  const squashed = Cause.squash(cause);
  return new WorkspaceEntriesError({
    cwd,
    operation: "workspaceEntries.buildIndex",
    detail: squashed instanceof Error ? squashed.message : String(squashed),
    cause: squashed,
  });
}

// Cap parallelism when probing directory entries for Finder-alias magic
// bytes. Each probe opens a file and reads 4 bytes, so on huge directories
// unbounded parallelism can saturate file descriptors and the kernel's I/O
// queue. Sixteen is a good middle ground — small enough to stay polite,
// large enough to overlap I/O latency.
const ALIAS_PROBE_CONCURRENCY = 16;

async function mapWithConcurrency<A, B>(
  items: readonly A[],
  concurrency: number,
  fn: (item: A, index: number) => Promise<B>,
): Promise<B[]> {
  if (items.length === 0) return [];
  const results: B[] = Array.from({ length: items.length });
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function isPermissionDeniedError(cause: unknown): boolean {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { readonly code?: unknown }).code
      : undefined;
  return code === "EACCES" || code === "EPERM";
}

// macOS Finder aliases are binary files (not symlinks). Modern ones (10.5+)
// are bookmark-format NSURL data and start with magic bytes "book". Pre-10.5
// "alis"-format aliases stored their type/creator metadata in the HFS
// FinderInfo extended attribute rather than the file body; detecting those
// would require reading `com.apple.FinderInfo`, which has no native Node API
// and is essentially extinct on modern installs. We intentionally only
// support modern bookmark aliases here.
const MACOS_BOOKMARK_ALIAS_MAGIC = "book";
// Real Finder bookmark files are tiny (typically well under 2 KB). Capping
// the probe at 64 KB lets us skip media, archives, binaries, etc. with a
// single cheap `stat` syscall in directories like ~/Downloads, instead of
// paying for an `open + read + close` on every file matching the prefix.
const MACOS_ALIAS_MAX_PROBE_BYTES = 64 * 1024;
// The script emits one resolved path per alias in argv order, using NUL as
// the terminator. POSIX paths cannot contain NUL bytes, so this is the only
// delimiter that is guaranteed to be unambiguous; tabs and newlines are legal
// in filenames and would break simpler formats.
const MACOS_ALIAS_RESOLVE_SCRIPT = `on run argv
  set results to ""
  set nul to ASCII character 0
  repeat with rawPath in argv
    set p to rawPath as string
    try
      tell application "Finder"
        set theTarget to original item of (POSIX file p as alias)
        set resolved to POSIX path of (theTarget as alias)
      end tell
      set results to results & resolved & nul
    on error
      set results to results & nul
    end try
  end repeat
  return results
end run`;

export async function isMacOSBookmarkAlias(filePath: string): Promise<boolean> {
  // Cheap stat prefilter: bookmark files are small, so anything outside the
  // plausible range can't be one and isn't worth opening.
  try {
    const stats = await fsPromises.stat(filePath);
    if (stats.size < 4 || stats.size > MACOS_ALIAS_MAX_PROBE_BYTES) return false;
  } catch {
    return false;
  }
  return readsMacOSBookmarkMagic(filePath);
}

async function readsMacOSBookmarkMagic(filePath: string): Promise<boolean> {
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(filePath, "r");
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    if (bytesRead < 4) return false;
    return buffer.toString("ascii") === MACOS_BOOKMARK_ALIAS_MAGIC;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Directories with more regular-file candidates than this are not probed for
// aliases at all: one open() per file would dominate the browse.
const MACOS_ALIAS_PROBE_MAX_CANDIDATES = 500;
const MACOS_ALIAS_PROBE_CACHE_MAX_ENTRIES = 2_048;
// Finder aliases carry the original item's name (usually a folder) or end in
// " alias"; files with these extensions are content, never worth opening.
const MACOS_ALIAS_CONTENT_EXTENSIONS = new Set(
  (
    "7z avi bmp c cjs cpp css csv dmg doc docx gif go gz h heic htm html ico java " +
    "jpeg jpg js json jsx key lock log m4a md mjs mov mp3 mp4 numbers pages pdf pkg " +
    "png ppt pptx py rar rb rs scss sh sql svg swift tar tgz toml ts tsx txt wav " +
    "webm webp xls xlsx xml yaml yml zip"
  ).split(" "),
);
// Probe results keyed by path, size and mtime: re-browsing a folder (the
// palette prefetches parent paths) never re-opens the same files.
const macOSAliasProbeCache = new Map<string, boolean>();

function hasContentExtension(fileName: string): boolean {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return false;
  return MACOS_ALIAS_CONTENT_EXTENSIONS.has(fileName.slice(dotIndex + 1).toLowerCase());
}

/**
 * Alias probe for one browse candidate. Unlike {@link isMacOSBookmarkAlias}
 * it never reads a dataless file: in File Provider locations (iCloud Drive,
 * Dropbox) reading an online-only file's bytes downloads it.
 */
async function probeBrowseAliasCandidate(filePath: string, fileName: string): Promise<boolean> {
  if (hasContentExtension(fileName)) return false;
  let cacheKey: string;
  try {
    const stats = await fsPromises.stat(filePath);
    if (stats.size < 4 || stats.size > MACOS_ALIAS_MAX_PROBE_BYTES) return false;
    // No allocated blocks but a non-zero size: an online-only placeholder.
    if (stats.blocks === 0) return false;
    cacheKey = `${filePath}\0${stats.size}\0${stats.mtimeMs}`;
  } catch {
    return false;
  }
  const cached = macOSAliasProbeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const isAlias = await readsMacOSBookmarkMagic(filePath);
  if (macOSAliasProbeCache.size >= MACOS_ALIAS_PROBE_CACHE_MAX_ENTRIES) {
    const oldestKey = macOSAliasProbeCache.keys().next().value;
    if (oldestKey !== undefined) macOSAliasProbeCache.delete(oldestKey);
  }
  macOSAliasProbeCache.set(cacheKey, isAlias);
  return isAlias;
}

async function resolveMacOSAliasTargets(
  aliasPaths: readonly string[],
): Promise<Map<string, string>> {
  if (process.platform !== "darwin" || aliasPaths.length === 0) {
    return new Map();
  }
  // The first osascript invocation on a given install triggers macOS's TCC
  // prompt to "control Finder". If the user doesn't click Allow immediately,
  // osascript blocks waiting for their response. A short timeout would kill
  // the subprocess before they can react and leave aliases silently missing
  // from the picker, so we use a generous ceiling. Subsequent calls are
  // effectively instantaneous.
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "osascript",
      ["-e", MACOS_ALIAS_RESOLVE_SCRIPT, "--", ...aliasPaths],
      { timeout: 30_000, maxBuffer: 1_024 * 1_024 },
      (error, out) => {
        if (error) {
          resolve("");
          return;
        }
        resolve(out);
      },
    );
  });
  const map = new Map<string, string>();
  // The script emits `<resolved>\0` for each argv entry (empty chunk for
  // unresolvable aliases). Split on NUL and match positionally to aliasPaths.
  const chunks = stdout.split("\0");
  for (let i = 0; i < aliasPaths.length; i += 1) {
    const aliasPath = aliasPaths[i];
    const resolved = chunks[i]?.replace(/\/$/, "") ?? "";
    if (aliasPath && resolved) {
      map.set(aliasPath, resolved);
    }
  }
  return map;
}

const resolveBrowseTarget = (
  input: FilesystemBrowseInput,
  pathService: Path.Path,
): Effect.Effect<string, WorkspaceEntriesBrowseError> =>
  Effect.gen(function* () {
    if (process.platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Windows-style paths are only supported on Windows.",
      });
    }

    if (!isExplicitRelativePath(input.partialPath)) {
      return pathService.resolve(expandHomePath(input.partialPath, pathService));
    }

    if (!input.cwd) {
      return yield* new WorkspaceEntriesBrowseError({
        cwd: input.cwd,
        partialPath: input.partialPath,
        operation: "workspaceEntries.resolveBrowseTarget",
        detail: "Relative filesystem browse paths require a current project.",
      });
    }

    return pathService.resolve(expandHomePath(input.cwd, pathService), input.partialPath);
  });

export const makeWorkspaceEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceAccessPolicy = yield* WorkspaceAccessPolicy;

  /**
   * One pass over the listing: drops paths under ignored top-level
   * directories and collects each file's ancestor directories. No sorting:
   * search ranks by score and listEntries consumers order their own tree.
   */
  const indexListedFiles = Effect.fn("WorkspaceEntries.indexListedFiles")(function* (
    listedPaths: ReadonlyArray<string>,
    listingPartial: boolean,
  ) {
    let filePaths: string[] = [];
    let directories = new Set<string>();
    for (let start = 0; start < listedPaths.length; start += WORKSPACE_INDEX_BUILD_CHUNK) {
      if (start > 0) {
        // Keep other sessions' streams flowing while a huge listing is indexed.
        yield* Effect.yieldNow;
      }
      const end = Math.min(listedPaths.length, start + WORKSPACE_INDEX_BUILD_CHUNK);
      for (let index = start; index < end; index += 1) {
        const filePath = toPosixPath(listedPaths[index] ?? "");
        if (filePath.length === 0 || isPathInIgnoredDirectory(filePath)) continue;
        filePaths.push(filePath);
        addDirectoryAncestors(directories, filePath);
      }
    }

    let partial = listingPartial;
    if (filePaths.length + directories.size > WORKSPACE_INDEX_MAX_ENTRIES) {
      ({ files: filePaths, directories } = selectShallowestFiles(
        filePaths,
        WORKSPACE_INDEX_MAX_ENTRIES,
      ));
      partial = true;
    }

    const entries: IndexedWorkspaceEntry[] = [];
    for (const directoryPath of directories) {
      entries.push(toIndexedEntry(directoryPath, "directory"));
    }
    for (const filePath of filePaths) {
      entries.push(toIndexedEntry(filePath, "file"));
    }
    return {
      builtAt: yield* Clock.currentTimeMillis,
      entries,
      partial,
      listing: null,
    } satisfies WorkspaceIndex;
  });

  const listVcsIndex = Effect.fn("WorkspaceEntries.listVcsIndex")(function* (
    cwd: string,
    driver: VcsDriverShape,
    mode: "full" | "tracked",
  ) {
    const listed = yield* driver
      .listWorkspaceFiles(cwd, mode === "tracked" ? { trackedOnly: true } : undefined)
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceEntriesError({
              cwd,
              operation: "workspaceEntries.listWorkspaceFiles",
              detail: cause.message,
              cause,
            }),
        ),
      );
    return yield* indexListedFiles(listed.paths, listed.truncated || mode === "tracked");
  });

  const detectVcsDriver = (cwd: string) =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.map((handle) => handle?.driver ?? null),
      Effect.catch(() => Effect.succeed(null)),
    );

  const readDirectoryEntries = Effect.fn("WorkspaceEntries.readDirectoryEntries")(function* (
    cwd: string,
    relativeDir: string,
  ): Effect.fn.Return<
    { readonly relativeDir: string; readonly dirents: Dirent[] | null },
    WorkspaceEntriesError
  > {
    return yield* Effect.tryPromise({
      try: async () => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        const dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
        return { relativeDir, dirents };
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.readDirectoryEntries",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        () => relativeDir.length > 0,
        () => Effect.succeed({ relativeDir, dirents: null }),
      ),
    );
  });

  const buildWorkspaceIndexFromFilesystem = Effect.fn(
    "WorkspaceEntries.buildWorkspaceIndexFromFilesystem",
  )(function* (cwd: string): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    // Only reached for roots outside any VCS work tree, so there are no
    // ignore rules to apply beyond IGNORED_DIRECTORY_NAMES.
    let pendingDirectories: string[] = [""];
    const entries: IndexedWorkspaceEntry[] = [];
    let truncated = false;

    while (pendingDirectories.length > 0 && !truncated) {
      const currentDirectories = pendingDirectories;
      pendingDirectories = [];

      const directoryEntries = yield* Effect.forEach(
        currentDirectories,
        (relativeDir) => readDirectoryEntries(cwd, relativeDir),
        { concurrency: WORKSPACE_SCAN_READDIR_CONCURRENCY },
      );

      const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
        const { relativeDir, dirents } = directoryEntry;
        if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

        dirents.sort((left, right) => left.name.localeCompare(right.name));
        const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
        for (const dirent of dirents) {
          if (!dirent.name || dirent.name === "." || dirent.name === "..") {
            continue;
          }
          if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
            continue;
          }
          if (!dirent.isDirectory() && !dirent.isFile()) {
            continue;
          }

          const relativePath = toPosixPath(
            relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
          );
          if (isPathInIgnoredDirectory(relativePath)) {
            continue;
          }
          candidates.push({ dirent, relativePath });
        }
        return candidates;
      });

      for (const candidateEntries of candidateEntriesByDirectory) {
        for (const candidate of candidateEntries) {
          entries.push(
            toIndexedEntry(
              candidate.relativePath,
              candidate.dirent.isDirectory() ? "directory" : "file",
            ),
          );

          if (candidate.dirent.isDirectory()) {
            pendingDirectories.push(candidate.relativePath);
          }

          if (entries.length >= WORKSPACE_FILESYSTEM_INDEX_MAX_ENTRIES) {
            truncated = true;
            break;
          }
        }

        if (truncated) {
          break;
        }
      }
    }

    return {
      builtAt: yield* Clock.currentTimeMillis,
      entries,
      partial: truncated,
      listing: null,
    } satisfies WorkspaceIndex;
  });

  /**
   * Inside a work tree the index comes from the VCS listing only. A failed
   * full listing falls back to tracked files, never to a readdir walk of a
   * tree that is probably slow to walk; the walk serves non-VCS folders.
   */
  const buildWorkspaceIndex = Effect.fn("WorkspaceEntries.buildWorkspaceIndex")(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const driver = yield* detectVcsDriver(cwd);
    if (!driver) {
      return yield* buildWorkspaceIndexFromFilesystem(cwd);
    }
    return yield* listVcsIndex(cwd, driver, "full").pipe(
      Effect.catch((error) =>
        listVcsIndex(cwd, driver, "tracked").pipe(
          Effect.tap(() =>
            Effect.logWarning("workspace index: full listing failed; indexed tracked files only", {
              cwd,
              detail: error.detail,
            }),
          ),
          Effect.catch(() => Effect.fail(error)),
        ),
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Stale-while-revalidate index store
  // -------------------------------------------------------------------------

  const slots = new Map<string, WorkspaceIndexSlot>();
  const backgroundFibers = yield* FiberSet.make<void, never>();
  const buildPermits = yield* Semaphore.make(WORKSPACE_INDEX_BUILD_CONCURRENCY);

  const runInBackground = (effect: Effect.Effect<void>) =>
    FiberSet.run(backgroundFibers, effect).pipe(Effect.asVoid);

  const isHot = (slot: WorkspaceIndexSlot, now: number) =>
    now - slot.lastReadAt < WORKSPACE_INDEX_HOT_WINDOW_MS;

  const isBackingOff = (slot: WorkspaceIndexSlot, now: number) =>
    slot.failure !== null && now - slot.failure.at < WORKSPACE_INDEX_FAILURE_RETRY_MS;

  const ensureSlot = (cwd: string): WorkspaceIndexSlot => {
    const existing = slots.get(cwd);
    if (existing) return existing;
    const slot: WorkspaceIndexSlot = {
      cwd,
      index: null,
      lastReadAt: 0,
      dirty: false,
      generation: 0,
      refreshing: false,
      refreshDone: null,
      rebuildScheduled: false,
      degradedBuildStarted: false,
      waiters: null,
      failure: null,
    };
    slots.set(cwd, slot);
    return slot;
  };

  /** Drops the least recently read roots until the store fits its budgets. */
  const enforceBudget = (keep: WorkspaceIndexSlot) => {
    let totalEntries = 0;
    for (const slot of slots.values()) totalEntries += slot.index?.entries.length ?? 0;
    while (totalEntries > WORKSPACE_INDEX_ENTRY_BUDGET || slots.size > WORKSPACE_INDEX_MAX_ROOTS) {
      let victim: WorkspaceIndexSlot | null = null;
      for (const slot of slots.values()) {
        if (slot === keep || slot.refreshing) continue;
        if (victim === null || slot.lastReadAt < victim.lastReadAt) victim = slot;
      }
      if (victim === null) return;
      slots.delete(victim.cwd);
      totalEntries -= victim.index?.entries.length ?? 0;
    }
  };

  const publishIndex = Effect.fn("WorkspaceEntries.publishIndex")(function* (
    slot: WorkspaceIndexSlot,
    index: WorkspaceIndex,
    generation: number | null,
  ) {
    slot.index = index;
    slot.failure = null;
    if (generation !== null && generation === slot.generation) {
      slot.dirty = false;
    }
    const waiters = slot.waiters;
    slot.waiters = null;
    if (waiters) yield* Deferred.succeed(waiters, index);
    enforceBudget(slot);
  });

  const recordBuildFailure = Effect.fn("WorkspaceEntries.recordBuildFailure")(function* (
    slot: WorkspaceIndexSlot,
    error: WorkspaceEntriesError,
  ) {
    slot.failure = { error, at: yield* Clock.currentTimeMillis };
    const waiters = slot.waiters;
    slot.waiters = null;
    if (waiters) yield* Deferred.fail(waiters, error);
  });

  const runRefresh = Effect.fn("WorkspaceEntries.refreshIndex")(function* (
    slot: WorkspaceIndexSlot,
  ) {
    const generation = slot.generation;
    const exit = yield* buildWorkspaceIndex(slot.cwd).pipe(
      buildPermits.withPermits(1),
      Effect.exit,
    );
    // `refreshing` clears only once the outcome is recorded: a reader arriving
    // in between joins this refresh instead of starting a duplicate build (or,
    // after a failure, reading neither an index nor the failure).
    if (Exit.isSuccess(exit)) {
      yield* publishIndex(slot, exit.value, generation);
      slot.refreshing = false;
      slot.degradedBuildStarted = false;
      // Invalidated mid-build: the result may predate the change.
      if (slot.dirty && isHot(slot, yield* Clock.currentTimeMillis)) {
        yield* scheduleRebuild(slot);
      }
      return;
    }
    const error = failureOf(exit.cause, slot.cwd);
    if (error === null) {
      // Interrupted (shutdown): release cold readers instead of leaving them parked.
      slot.refreshing = false;
      slot.degradedBuildStarted = false;
      const waiters = slot.waiters;
      slot.waiters = null;
      if (waiters) yield* Deferred.interrupt(waiters);
      return;
    }
    yield* Effect.logWarning("workspace index build failed", {
      cwd: slot.cwd,
      detail: error.detail,
    });
    yield* recordBuildFailure(slot, error);
    slot.refreshing = false;
    slot.degradedBuildStarted = false;
  });

  /**
   * Single-flight: at most one build per root, at most a few across roots.
   * Returns what cold readers wait on, captured before the build can settle it.
   */
  const startRefresh = Effect.fn("WorkspaceEntries.startRefresh")(function* (
    slot: WorkspaceIndexSlot,
  ) {
    if (slot.refreshing) return slot.waiters;
    // Synchronous from the check to here: a concurrent reader never sees a
    // refresh without the deferreds it waits on.
    slot.refreshing = true;
    if (slot.index === null && slot.waiters === null) {
      slot.waiters = Deferred.makeUnsafe<WorkspaceIndex, WorkspaceEntriesError>();
    }
    const waiters = slot.waiters;
    const done = Deferred.makeUnsafe<void>();
    slot.refreshDone = done;
    yield* runInBackground(
      runRefresh(slot).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (slot.refreshDone === done) {
              slot.refreshDone = null;
              // Backstop for a refresh that ended before recording an outcome.
              slot.refreshing = false;
            }
            return Deferred.succeed(done, undefined);
          }),
        ),
      ),
    );
    return waiters;
  });

  const scheduleRebuild = (slot: WorkspaceIndexSlot): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (slot.rebuildScheduled) return Effect.void;
      slot.rebuildScheduled = true;
      return runInBackground(
        Effect.sleep(WORKSPACE_INDEX_REBUILD_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              slot.rebuildScheduled = false;
              return slots.get(slot.cwd) === slot && slot.dirty ? startRefresh(slot) : Effect.void;
            }),
          ),
        ),
      );
    });

  /**
   * Past the cold-build deadline, readers get tracked files (one fast
   * `ls-files -c`, no untracked walk) while the full build keeps running and
   * replaces it when done.
   */
  const startDegradedBuild = Effect.fn("WorkspaceEntries.startDegradedBuild")(function* (
    slot: WorkspaceIndexSlot,
  ) {
    if (slot.degradedBuildStarted || slot.index !== null) return;
    slot.degradedBuildStarted = true;
    yield* runInBackground(
      Effect.gen(function* () {
        const driver = yield* detectVcsDriver(slot.cwd);
        // A non-VCS folder has no cheaper listing: its readers keep waiting.
        if (!driver) return;
        yield* Effect.logWarning(
          "workspace index build exceeded its deadline; serving tracked files",
          { cwd: slot.cwd, deadlineMs: WORKSPACE_INDEX_COLD_BUILD_DEADLINE_MS },
        );
        const degraded = yield* listVcsIndex(slot.cwd, driver, "tracked").pipe(Effect.option);
        if (Option.isSome(degraded) && slot.index === null && slots.get(slot.cwd) === slot) {
          // Never clears `dirty`: only the full build may settle the root.
          yield* publishIndex(slot, degraded.value, null);
        }
      }),
    );
  });

  const awaitColdIndex = Effect.fn("WorkspaceEntries.awaitColdIndex")(function* (
    slot: WorkspaceIndexSlot,
    waiters: Deferred.Deferred<WorkspaceIndex, WorkspaceEntriesError> | null,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    if (waiters === null) {
      if (slot.index) return slot.index;
      if (slot.failure) return yield* slot.failure.error;
      return yield* new WorkspaceEntriesError({
        cwd: slot.cwd,
        operation: "workspaceEntries.awaitIndex",
        detail: "The workspace index is unavailable.",
      });
    }
    const first = yield* Deferred.await(waiters).pipe(
      Effect.timeoutOption(WORKSPACE_INDEX_COLD_BUILD_DEADLINE_MS),
    );
    if (Option.isSome(first)) return first.value;
    yield* startDegradedBuild(slot);
    return yield* Deferred.await(waiters);
  });

  /**
   * Returns the root's index without waiting whenever one exists, starting a
   * background revalidation when it is invalidated or old. Only the first
   * read of a root waits, and then for at most the cold-build deadline when
   * the root is a VCS checkout.
   *
   * `superseded` marks an index a rebuild will replace: invalidated since it
   * was built, or the tracked-files stand-in served past the cold-build
   * deadline while the full build still runs. Answers from it are not final.
   */
  const readIndex = Effect.fn("WorkspaceEntries.readIndex")(function* (
    cwd: string,
  ): Effect.fn.Return<
    { readonly index: WorkspaceIndex; readonly superseded: boolean },
    WorkspaceEntriesError
  > {
    const now = yield* Clock.currentTimeMillis;
    const slot = ensureSlot(cwd);
    slot.lastReadAt = now;
    const index = slot.index;
    if (index) {
      // Captured before a refresh starts: it can finish before this returns.
      const invalidated = slot.dirty;
      const needsRevalidation =
        invalidated || now - index.builtAt >= WORKSPACE_INDEX_REVALIDATE_AFTER_MS;
      if (needsRevalidation && !slot.refreshing && !isBackingOff(slot, now)) {
        yield* startRefresh(slot);
      }
      return { index, superseded: invalidated || slot.degradedBuildStarted };
    }
    if (!slot.refreshing && slot.failure !== null && isBackingOff(slot, now)) {
      return yield* slot.failure.error;
    }
    const built = yield* awaitColdIndex(slot, yield* startRefresh(slot));
    // Past the deadline `built` is the stand-in; the full build may have landed since.
    return {
      index: slot.index ?? built,
      superseded: slot.dirty || slot.degradedBuildStarted,
    };
  });

  /**
   * For readers that must reflect an invalidation (the files tree refetches
   * right after a turn): runs the pending rebuild now and waits for it, up to
   * the cold-build deadline, instead of answering from the invalidated index.
   */
  const awaitPendingChanges = Effect.fn("WorkspaceEntries.awaitPendingChanges")(function* (
    slot: WorkspaceIndexSlot,
  ) {
    // Twice at most: a rebuild already running may predate the invalidation.
    for (let attempt = 0; attempt < 2 && slot.dirty; attempt += 1) {
      if (!slot.refreshing) {
        if (isBackingOff(slot, yield* Clock.currentTimeMillis)) return;
        yield* startRefresh(slot);
      }
      const done = slot.refreshDone;
      if (done === null) return;
      const finished = yield* Deferred.await(done).pipe(
        Effect.timeoutOption(WORKSPACE_INDEX_COLD_BUILD_DEADLINE_MS),
      );
      if (Option.isNone(finished)) return;
    }
  });

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesError({
            cwd,
            operation: "workspaceEntries.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const slotsForRoot = Effect.fn("WorkspaceEntries.slotsForRoot")(function* (cwd: string) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
      Effect.catch(() => Effect.succeed(cwd)),
    );
    const matched: WorkspaceIndexSlot[] = [];
    for (const key of normalizedCwd === cwd ? [cwd] : [cwd, normalizedCwd]) {
      const slot = slots.get(key);
      if (slot) matched.push(slot);
    }
    return matched;
  });

  /** Marks the root changed: rebuilt shortly in the background while in use, else dropped. */
  const markRootChanged = Effect.fn("WorkspaceEntries.markRootChanged")(function* (
    slot: WorkspaceIndexSlot,
  ) {
    slot.dirty = true;
    slot.generation += 1;
    if (slot.index === null) {
      // A cold build is running; the generation bump keeps its result dirty.
      return;
    }
    if (isHot(slot, yield* Clock.currentTimeMillis)) {
      yield* scheduleRebuild(slot);
    } else if (!slot.refreshing) {
      slots.delete(slot.cwd);
    }
  });

  const invalidate: WorkspaceEntriesShape["invalidate"] = Effect.fn("WorkspaceEntries.invalidate")(
    function* (cwd) {
      for (const slot of yield* slotsForRoot(cwd)) {
        yield* markRootChanged(slot);
      }
    },
  );

  const recordFileWrite: WorkspaceEntriesShape["recordFileWrite"] = Effect.fn(
    "WorkspaceEntries.recordFileWrite",
  )(function* (cwd, relativePath) {
    const filePath = toPosixPath(relativePath);
    for (const slot of yield* slotsForRoot(cwd)) {
      const index = slot.index;
      if (index === null) {
        yield* markRootChanged(slot);
        continue;
      }
      if (isPathInIgnoredDirectory(filePath)) continue;
      // One pass over the index: is the file listed, and which ancestors are not?
      const missingDirectories = new Set<string>();
      addDirectoryAncestors(missingDirectories, filePath);
      let alreadyIndexed = false;
      for (const entry of index.entries) {
        if (entry.kind === "directory") {
          missingDirectories.delete(entry.path);
        } else if (entry.path === filePath) {
          alreadyIndexed = true;
          break;
        }
      }
      // Saving an indexed file changes nothing the index holds.
      if (alreadyIndexed) continue;
      for (const directoryPath of missingDirectories) {
        index.entries.push(toIndexedEntry(directoryPath, "directory"));
      }
      index.entries.push(toIndexedEntry(filePath, "file"));
      index.listing = null;
      // Visible immediately; a background rebuild settles its ignore status.
      yield* markRootChanged(slot);
    }
  });

  const browse: WorkspaceEntriesShape["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const initialParentPath = endsWithSeparator
        ? resolvedInputPath
        : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      yield* workspaceAccessPolicy
        .assertExistingPath({
          path: initialParentPath,
          operation: "filesystemBrowse",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceEntriesBrowseError({
                cwd: input.cwd,
                partialPath: input.partialPath,
                operation: "workspaceEntries.browse.accessPolicy",
                detail: cause.message,
                cause,
              }),
          ),
        );

      // If the user typed a path whose last component is a macOS Finder alias
      // (e.g. `~/mongodb-test-alis/`), the entry is a regular file on disk and
      // readdir would fail. Resolve it to its target directory first so the
      // listing works and the returned parentPath reflects the real location.
      const resolvedParentPath = yield* Effect.promise(async () => {
        try {
          if (process.platform !== "darwin" || !endsWithSeparator) {
            return initialParentPath;
          }
          try {
            const stats = await fsPromises.lstat(initialParentPath);
            if (!stats.isFile()) return initialParentPath;
          } catch {
            return initialParentPath;
          }
          if (!(await isMacOSBookmarkAlias(initialParentPath))) {
            return initialParentPath;
          }
          const resolved = await resolveMacOSAliasTargets([initialParentPath]);
          return resolved.get(initialParentPath) ?? initialParentPath;
        } catch {
          // Defense in depth: alias resolution is best-effort; never let an
          // unexpected rejection here become an Effect defect.
          return initialParentPath;
        }
      });
      const parentPath = yield* workspaceAccessPolicy
        .assertExistingPath({
          path: resolvedParentPath,
          operation: "filesystemBrowse",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceEntriesBrowseError({
                cwd: input.cwd,
                partialPath: input.partialPath,
                operation: "workspaceEntries.browse.accessPolicy",
                detail: cause.message,
                cause,
              }),
          ),
        );

      const dirents = yield* Effect.tryPromise({
        try: () => fsPromises.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesBrowseError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            operation: "workspaceEntries.browse.readDirectory",
            detail: `Unable to browse '${parentPath}': ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => isPermissionDeniedError(error.cause),
          () => Effect.succeed([] as Dirent[]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();

      const isDarwin = process.platform === "darwin";

      const candidates = dirents.filter((dirent) => {
        if (!dirent.name.toLowerCase().startsWith(lowerPrefix)) return false;
        if (!showHidden && dirent.name.startsWith(".")) return false;
        if (dirent.isDirectory() || dirent.isSymbolicLink()) return true;
        // On macOS, regular files can be Finder aliases (binary bookmark
        // files). We detect them by magic bytes below before resolving.
        if (isDarwin && dirent.isFile()) return true;
        return false;
      });
      let fileCandidateCount = 0;
      for (const dirent of candidates) {
        if (dirent.isFile()) fileCandidateCount += 1;
      }
      const probeAliases = isDarwin && fileCandidateCount <= MACOS_ALIAS_PROBE_MAX_CANDIDATES;

      // Follow symlinks (e.g. ~/Dropbox -> ~/Library/CloudStorage/Dropbox) and
      // macOS Finder aliases so they show up in the picker alongside real
      // directories. Aliases are resolved in a single batched osascript call.
      const { resolved, aliasTargets } = yield* Effect.promise(async () => {
        try {
          const initial = await mapWithConcurrency(
            candidates,
            ALIAS_PROBE_CONCURRENCY,
            async (dirent) => {
              if (dirent.isDirectory()) {
                return { dirent, pointsToDirectory: true, isAlias: false };
              }
              if (dirent.isSymbolicLink()) {
                try {
                  const stats = await fsPromises.stat(path.join(parentPath, dirent.name));
                  return { dirent, pointsToDirectory: stats.isDirectory(), isAlias: false };
                } catch {
                  return { dirent, pointsToDirectory: false, isAlias: false };
                }
              }
              if (probeAliases && dirent.isFile()) {
                const fullPath = path.join(parentPath, dirent.name);
                if (await probeBrowseAliasCandidate(fullPath, dirent.name)) {
                  return { dirent, pointsToDirectory: false, isAlias: true };
                }
              }
              return { dirent, pointsToDirectory: false, isAlias: false };
            },
          );

          const aliasCandidatePaths = initial
            .filter((item) => item.isAlias)
            .map((item) => path.join(parentPath, item.dirent.name));
          const aliasTargets = await resolveMacOSAliasTargets(aliasCandidatePaths);

          const finalItems = await mapWithConcurrency(
            initial,
            ALIAS_PROBE_CONCURRENCY,
            async (item) => {
              if (!item.isAlias) return item;
              const aliasPath = path.join(parentPath, item.dirent.name);
              const target = aliasTargets.get(aliasPath);
              if (!target) return item;
              try {
                const stats = await fsPromises.stat(target);
                return { ...item, pointsToDirectory: stats.isDirectory() };
              } catch {
                return item;
              }
            },
          );

          return { resolved: finalItems, aliasTargets };
        } catch {
          // Defense in depth: alias/symlink resolution is best-effort. Fall
          // back to the raw dirent list without any target-directory
          // promotion rather than letting an unexpected rejection surface as
          // an Effect defect.
          return {
            resolved: candidates.map((dirent) => ({
              dirent,
              pointsToDirectory: dirent.isDirectory(),
              isAlias: false,
            })),
            aliasTargets: new Map<string, string>(),
          };
        }
      });

      return {
        parentPath,
        ...(workspaceAccessPolicy.accessRoot !== undefined
          ? { workspaceAccessRoot: workspaceAccessPolicy.accessRoot }
          : {}),
        entries: resolved
          .filter((item) => item.pointsToDirectory)
          .map(({ dirent, isAlias }) => {
            const joined = path.join(parentPath, dirent.name);
            const entry: {
              name: string;
              fullPath: string;
              isSymlink?: boolean;
              isAlias?: boolean;
            } = {
              name: dirent.name,
              fullPath: isAlias ? (aliasTargets.get(joined) ?? joined) : joined,
            };
            if (dirent.isSymbolicLink() || isAlias) entry.isSymlink = true;
            if (isAlias) entry.isAlias = true;
            return entry;
          })
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntriesShape["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const { index, superseded } = yield* readIndex(yield* normalizeWorkspaceRoot(input.cwd));
      const limit = Math.max(0, Math.floor(input.limit));
      const ranked = rankWorkspaceEntries(
        index.entries,
        normalizeWorkspaceEntryQuery(input.query),
        limit,
      );
      return {
        entries: ranked.entries.map(toProjectEntry),
        truncated: index.partial || ranked.matchedCount > limit,
        ...(index.partial ? { partial: true } : {}),
        ...(superseded ? { refreshing: true } : {}),
      };
    },
  );

  const listEntries: WorkspaceEntriesShape["listEntries"] = Effect.fn(
    "WorkspaceEntries.listEntries",
  )(function* (input) {
    const cwd = yield* normalizeWorkspaceRoot(input.cwd);
    const read = yield* readIndex(cwd);
    const slot = slots.get(cwd);
    if (slot?.dirty === true) {
      yield* awaitPendingChanges(slot);
    }
    // The newest index: a rebuild may have landed while this read waited.
    const index = slot?.index ?? read.index;
    index.listing ??= buildWorkspaceListing(index);
    return index.listing;
  });

  return {
    browse,
    invalidate,
    recordFileWrite,
    listEntries,
    search,
  } satisfies WorkspaceEntriesShape;
});

export const WorkspaceEntriesLive = Layer.effect(WorkspaceEntries, makeWorkspaceEntries);
