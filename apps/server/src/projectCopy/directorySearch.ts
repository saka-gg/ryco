/**
 * DirectorySearch - the folder search behind `filesystem.searchDirectories`.
 *
 * A bounded breadth-first walk over a node's code roots, level by level with a few directory
 * reads in flight, ranked with the workspace-entry (`@` picker) ranker. It never follows a
 * symlink or a Finder alias (both are not directories to `readdir`), treats a git repository as
 * a leaf, skips build output, caches, hidden folders and the macOS folders a privacy prompt
 * guards, and stops at a directory, per-directory entry and time budget. The outcome tells the
 * three apart: the walk stopped early (`truncated`), more folders matched than it returns
 * (`limitReached`), and directories it read only in part (`cappedDirectories`). An empty query lists
 * the roots' own folders instead, git repositories first.
 *
 * Paths come back as the roots were given (never realpath'd), so they match the node's stored
 * project roots.
 *
 * @module DirectorySearch
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";

import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  type RankedSearchResult,
} from "@ryco/shared/searchRanking";
import { scoreWorkspaceEntry } from "@ryco/shared/workspaceEntrySearch";

import { foldPathCase, hasGitEntry } from "../project/projectDestination.ts";
import { isPrivacyGuardedHomeFolderName } from "./privacyGuardedFolders.ts";

export const DIRECTORY_SEARCH_MAX_DIRECTORIES = 20_000;
export const DIRECTORY_SEARCH_TIME_BUDGET_MS = 1_500;
/** Entries read from one directory; past that the rest of it is not searched. */
export const DIRECTORY_SEARCH_MAX_ENTRIES_PER_DIRECTORY = 10_000;
/** Directory reads (and, for an empty query, `.git` probes) in flight at once. */
const READ_CONCURRENCY = 8;
/** Ranks a non-repository just behind a repository with the same score; scores are integers. */
const NON_REPOSITORY_PENALTY = 0.5;
/** `.git/HEAD` is one short line; anything longer is not a branch reference. */
const HEAD_MAX_BYTES = 512;
/** A FIFO planted as `HEAD` must not block the search: open it without waiting for a writer. */
const READ_WITHOUT_BLOCKING = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Never searched, nor descended into: build output, dependency trees, version-control and
 * tool caches, and the folders OS-managed state lives in (`Library` holds the cloud-storage
 * placeholder roots `Library/CloudStorage` and `Library/Mobile Documents`; `AppData` is the
 * Windows equivalent).
 */
const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  "dist",
  "build",
  "target",
  ".venv",
  "vendor",
  "Library",
  ".Trash",
  ".cache",
  "AppData",
]);

/** Leading `@`, `/` (and `.` unless the query asks for hidden folders) carry no meaning. */
const QUERY_LEADING_PATTERN = /^(?:~\/)?[@./]*/;
const HIDDEN_QUERY_LEADING_PATTERN = /^(?:~\/)?[@/]*/;

export interface DirectorySearchInput {
  /** Absolute directories to walk, already checked by the access policy; walked as given. */
  readonly roots: ReadonlyArray<string>;
  readonly query: string;
  readonly limit: number;
  /** Matches are at most this many levels below their root. */
  readonly maxDepth: number;
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform | undefined;
  /** Privacy-protected home folders that are code roots may be descended into. */
  readonly codeRoots?: ReadonlyArray<string> | undefined;
  readonly maxDirectories?: number | undefined;
  readonly timeBudgetMs?: number | undefined;
  readonly maxEntriesPerDirectory?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
}

export interface DirectorySearchHit {
  readonly path: string;
  readonly name: string;
  readonly parentPath: string;
  /** Levels below its root: a root's own folders are at depth 1. */
  readonly depth: number;
  readonly isGitRepository: boolean;
  readonly gitBranch: string | null;
  /** Lower is better. */
  readonly score: number;
}

export interface DirectorySearchOutcome {
  readonly hits: ReadonlyArray<DirectorySearchHit>;
  /**
   * The walk stopped at its directory or time budget, so folders were left unsearched. One
   * huge directory is not that: see `cappedDirectories`.
   */
  readonly truncated: boolean;
  /** More folders matched than `limit`: `hits` are the best of them. */
  readonly limitReached: boolean;
  /** Directories read only up to the per-directory entry budget; the rest of each was skipped. */
  readonly cappedDirectories: number;
  readonly scannedDirectories: number;
}

interface WalkRoot {
  readonly path: string;
  readonly index: number;
  readonly isHome: boolean;
}

interface QueuedDirectory {
  readonly path: string;
  /** The ranker's path: lowercased, `/`-separated; see `scoringPrefix`. */
  readonly rankPath: string;
  readonly depth: number;
  readonly root: WalkRoot;
  /** The path crosses the wire as a trimmed string only when its last name has no edge spaces. */
  readonly trimmed: boolean;
}

interface Candidate {
  readonly path: string;
  readonly name: string;
  readonly parentPath: string;
  readonly depth: number;
  readonly rootIndex: number;
  /** False for privacy-protected folders: nothing inside them is opened, `.git` included. */
  readonly probe: boolean;
}

/** A name or path the wire's trimmed-string schema accepts. */
const isTrimmed = (value: string) => value.length > 0 && value === value.trim();

/**
 * The branch `.git/HEAD` names, following a `.git` file (`gitdir: …`, a linked worktree or a
 * submodule) to its git dir. Null when detached or unreadable.
 */
export const readGitBranch = async (repository: string): Promise<string | null> => {
  const readHead = async (file: string) => {
    const handle = await open(file, READ_WITHOUT_BLOCKING);
    try {
      const buffer = Buffer.alloc(HEAD_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_MAX_BYTES, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  };
  try {
    const dotGit = path.join(repository, ".git");
    const entry = await lstat(dotGit);
    let gitDir = dotGit;
    if (entry.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readHead(dotGit))?.[1];
      if (pointer === undefined) return null;
      gitDir = path.resolve(repository, pointer);
    } else if (!entry.isDirectory()) {
      return null;
    }
    const reference = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(
      await readHead(path.join(gitDir, "HEAD")),
    )?.[1];
    return reference ?? null;
  } catch {
    return null;
  }
};

/** Run `task` over `items` with at most `concurrency` in flight; stops early when `stop()`. */
const forEachBounded = async <T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  stop: () => boolean,
  task: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++]!;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
};

/**
 * Search `roots` for folders matching `query`. Never fails: an unreadable folder is skipped,
 * and an aborted `signal` ends the walk with what it found so far.
 */
export const searchDirectories = async (
  input: DirectorySearchInput,
): Promise<DirectorySearchOutcome> => {
  const platform = input.platform ?? process.platform;
  const now = input.now ?? (() => performance.now());
  const maxDirectories = input.maxDirectories ?? DIRECTORY_SEARCH_MAX_DIRECTORIES;
  const maxEntries = input.maxEntriesPerDirectory ?? DIRECTORY_SEARCH_MAX_ENTRIES_PER_DIRECTORY;
  const deadline = now() + (input.timeBudgetMs ?? DIRECTORY_SEARCH_TIME_BUDGET_MS);
  const limit = Math.max(0, Math.floor(input.limit));
  const homeKey = foldPathCase(path.resolve(input.homeDir), platform);
  const rawQuery = homeRelativeQuery(input.query, homeKey, platform);
  const includeHidden = rawQuery.trimStart().startsWith(".");
  const query = normalizeSearchQuery(rawQuery.replaceAll("\\", "/"), {
    trimLeadingPattern: includeHidden ? HIDDEN_QUERY_LEADING_PATTERN : QUERY_LEADING_PATTERN,
  });
  // A path-like query ranks home-relative paths ("code/ryco"), a plain one root-relative paths.
  const pathQuery = query.includes("/");
  const rootKeys = new Set(input.roots.map((root) => foldPathCase(root, platform)));
  const codeRootKeys = new Set(
    (input.codeRoots ?? []).map((root) => foldPathCase(path.resolve(root), platform)),
  );
  const roots: ReadonlyArray<WalkRoot> = input.roots.map((root, index) => ({
    path: root,
    index,
    isHome: foldPathCase(root, platform) === homeKey,
  }));

  let scannedDirectories = 0;
  let truncated = false;
  let limitReached = false;
  let cappedDirectories = 0;
  const outOfBudget = () => {
    if (input.signal?.aborted) return true;
    if (scannedDirectories >= maxDirectories || now() > deadline) {
      truncated = true;
      return true;
    }
    return false;
  };

  /**
   * A folder of a home root that macOS guards and this search may not open: neither a code root
   * nor named by a path-like query (`documents/…`). A query that is only its name lists it.
   */
  const isGuarded = (parent: QueuedDirectory, name: string, childPath: string) => {
    if (parent.depth !== 0 || !parent.root.isHome) return false;
    return (
      isPrivacyGuardedHomeFolderName(name, platform) &&
      !codeRootKeys.has(foldPathCase(childPath, platform)) &&
      !query.startsWith(`${name.toLowerCase()}/`)
    );
  };

  const searchable = (name: string) =>
    !SKIPPED_DIRECTORY_NAMES.has(name) && (includeHidden || !name.startsWith("."));

  /**
   * The searchable child folders of `directory`, or null when it cannot be read. `isRepository`
   * reports a `.git` entry; `capped` that it held more than `maxEntries` entries.
   */
  const readChildren = async (
    directory: string,
  ): Promise<{
    readonly names: ReadonlyArray<string>;
    readonly isRepository: boolean;
    readonly capped: boolean;
  } | null> => {
    const names: Array<string> = [];
    let isRepository = false;
    let seen = 0;
    try {
      const handle = await opendir(directory, { bufferSize: 128 });
      // Leaving the loop closes the handle.
      for await (const entry of handle) {
        if (++seen > maxEntries) return { names, isRepository, capped: true };
        if (entry.name === ".git") isRepository = true;
        // Symlinks and Finder aliases are not directories here, so they are never followed.
        else if (entry.isDirectory() && searchable(entry.name)) names.push(entry.name);
      }
    } catch {
      return null;
    }
    return { names, isRepository, capped: false };
  };

  const rootItems: ReadonlyArray<QueuedDirectory> = roots.map((root) => ({
    path: root.path,
    rankPath: pathQuery ? scoringPrefix(root, input.homeDir) : "",
    depth: 0,
    root,
    trimmed: isTrimmed(path.basename(root.path) || root.path),
  }));

  if (query.length === 0) {
    return listRoots(rootItems);
  }

  const ranked: Array<RankedSearchResult<Candidate>> = [];
  const multipleRoots = roots.length > 1;
  let frontier: ReadonlyArray<QueuedDirectory> = rootItems;
  while (frontier.length > 0 && !outOfBudget()) {
    const next: Array<QueuedDirectory> = [];
    await forEachBounded(frontier, READ_CONCURRENCY, outOfBudget, async (directory) => {
      scannedDirectories += 1;
      const read = await readChildren(directory.path);
      if (read === null) return;
      if (read.capped) cappedDirectories += 1;
      // A repository is a leaf, unless the caller asked to search inside it.
      if (read.isRepository && directory.depth > 0) return;
      const depth = directory.depth + 1;
      for (const name of read.names) {
        const childPath = path.join(directory.path, name);
        const rankPath = joinRankPath(directory.rankPath, name);
        // Another root covers what is inside it: listed here, walked there.
        const otherRoot = multipleRoots && rootKeys.has(foldPathCase(childPath, platform));
        const guarded = !otherRoot && isGuarded(directory, name, childPath);
        if (directory.trimmed && isTrimmed(name)) {
          const score = scoreWorkspaceEntry({ kind: "directory", normalizedPath: rankPath }, query);
          const full = ranked.length >= limit;
          // A match past a full list: whether it displaces one or not, there were more.
          if (score !== null && full) limitReached = true;
          const worst = full ? ranked[ranked.length - 1] : undefined;
          // Allocate a candidate only for a score the full list would admit.
          if (score !== null && limit > 0 && (worst === undefined || score <= worst.score)) {
            insertRankedSearchResult(
              ranked,
              {
                item: candidateOf(directory, name, childPath, depth, !guarded),
                score,
                tieBreaker: childPath,
              },
              limit,
            );
          }
        }
        if (depth < input.maxDepth && !otherRoot && !guarded) {
          next.push({
            path: childPath,
            rankPath,
            depth,
            root: directory.root,
            trimmed: isTrimmed(name),
          });
        }
      }
    });
    frontier = next;
  }

  // The final few get their `.git` probe whatever the walk spent: at most `limit` of them.
  const described = await describeCandidates(ranked, false);
  return {
    hits: described
      .flatMap((hit) => (hit === undefined ? [] : [hit]))
      .toSorted((left, right) => left.score - right.score || left.path.localeCompare(right.path)),
    truncated,
    limitReached,
    cappedDirectories,
    scannedDirectories,
  };

  /** The roots' own folders, git repositories first, then in root order and by name. */
  async function listRoots(items: ReadonlyArray<QueuedDirectory>): Promise<DirectorySearchOutcome> {
    const candidates: Array<RankedSearchResult<Candidate>> = [];
    // What the empty query scores every root's own folder (depth 0 below the root).
    const score = scoreWorkspaceEntry({ kind: "directory", normalizedPath: "" }, "") ?? 0;
    for (const root of items) {
      if (outOfBudget()) break;
      scannedDirectories += 1;
      const read = await readChildren(root.path);
      if (read === null) continue;
      if (read.capped) cappedDirectories += 1;
      if (!root.trimmed) continue;
      for (const name of read.names) {
        if (!isTrimmed(name)) continue;
        const childPath = path.join(root.path, name);
        const item = candidateOf(root, name, childPath, 1, !isGuarded(root, name, childPath));
        candidates.push({ item, score, tieBreaker: childPath });
      }
    }
    // Every folder is probed, so the repositories can come first; bounded by the budget.
    const described = await describeCandidates(candidates, true);
    const rows = described.flatMap((hit, index) =>
      hit === undefined ? [] : [{ hit, rootIndex: candidates[index]!.item.rootIndex, index }],
    );
    return {
      hits: rows
        .toSorted(
          (left, right) =>
            left.hit.score - right.hit.score ||
            left.rootIndex - right.rootIndex ||
            left.hit.name.localeCompare(right.hit.name, undefined, { sensitivity: "base" }) ||
            left.index - right.index,
        )
        .slice(0, limit)
        .map((row) => row.hit),
      truncated,
      limitReached: rows.length > limit,
      cappedDirectories,
      scannedDirectories,
    };
  }

  /**
   * Probe each candidate for `.git` (never inside a guarded folder) and read the repositories'
   * branches. `bounded` probes count against the directory and time budget; one the budget no
   * longer allows reads as "not a repository". Index-aligned with `entries`; a slot is empty
   * only when the search was aborted.
   */
  async function describeCandidates(
    entries: ReadonlyArray<RankedSearchResult<Candidate>>,
    bounded: boolean,
  ): Promise<ReadonlyArray<DirectorySearchHit | undefined>> {
    const hits: Array<DirectorySearchHit | undefined> = Array.from({ length: entries.length });
    let probes = 0;
    await forEachBounded(
      entries.map((_, index) => index),
      READ_CONCURRENCY,
      () => input.signal?.aborted === true,
      async (index) => {
        const { item, score } = entries[index]!;
        let isGitRepository = false;
        if (item.probe) {
          if (bounded && (scannedDirectories + probes >= maxDirectories || now() > deadline)) {
            truncated = true;
          } else {
            probes += 1;
            isGitRepository = await hasGitEntry(item.path);
          }
        }
        hits[index] = {
          path: item.path,
          name: item.name,
          parentPath: item.parentPath,
          depth: item.depth,
          isGitRepository,
          gitBranch: isGitRepository ? await readGitBranch(item.path) : null,
          score: score + (isGitRepository ? 0 : NON_REPOSITORY_PENALTY),
        };
      },
    );
    return hits;
  }
};

const candidateOf = (
  parent: QueuedDirectory,
  name: string,
  childPath: string,
  depth: number,
  probe: boolean,
): Candidate => ({
  path: childPath,
  name,
  parentPath: parent.path,
  depth,
  rootIndex: parent.root.index,
  probe,
});

const joinRankPath = (parent: string, name: string) =>
  parent.length === 0 ? name.toLowerCase() : `${parent}/${name.toLowerCase()}`;

/**
 * An absolute query at or below home in the home-relative form a path-like query ranks by
 * (`/Users/me/Code/ryco` → `code/ryco`, like `~/Code/ryco`), a trailing separator kept; any other
 * query as given. `homeKey` is home resolved and case-folded for `platform`.
 */
const homeRelativeQuery = (raw: string, homeKey: string, platform: NodeJS.Platform): string => {
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) return raw;
  const relative = path.relative(homeKey, foldPathCase(path.resolve(trimmed), platform));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return raw;
  }
  return relative.length > 0 && /[\\/]$/u.test(trimmed) ? `${relative}/` : relative;
};

/**
 * Where a root's paths start for a path-like query: its path below home (`code` for `~/Code`),
 * empty for home itself, or its absolute path (lowercased, `/`-separated) outside home.
 */
const scoringPrefix = (root: WalkRoot, homeDir: string): string => {
  if (root.isHome) return "";
  const relative = path.relative(path.resolve(homeDir), root.path);
  const below =
    relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : root.path;
  return below
    .toLowerCase()
    .split(path.sep)
    .filter((segment) => segment.length > 0)
    .join("/");
};
