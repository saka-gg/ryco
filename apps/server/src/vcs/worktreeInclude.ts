/**
 * `.worktreeinclude`: a file at the root of a checkout, in gitignore syntax, naming gitignored
 * files (`.env`, local config) that every worktree made from that checkout gets a copy of, so an
 * agent's first run there does not fail on a missing `.env`. Ported from Synara's GitCore
 * (`listWorktreeTransferPaths`): the candidates are what
 * `git ls-files --others --ignored --exclude-from=.worktreeinclude` lists in the source
 * checkout. Ryco keeps only those Git also ignores by its standard rules, so a copy never turns
 * into an untracked change that a commit could pick up.
 *
 * Loaded through `import()` when a worktree is created, never at boot; it imports no boot
 * module (the git runner stays in the driver).
 *
 * @module vcs/worktreeInclude
 */
import { promises as fsPromises } from "node:fs";
import nodePath from "node:path";

import { Duration, Effect } from "effect";

export const WORKTREE_INCLUDE_FILE_NAME = ".worktreeinclude";

/** Synara's cap on a listing (`WORKTREE_TRANSFER_MAX_OUTPUT_BYTES`). */
export const WORKTREE_INCLUDE_MAX_LIST_BYTES = 64 * 1024 * 1024;
/** At most this many files are copied; the rest are reported, not copied. */
export const WORKTREE_INCLUDE_MAX_FILES = 1_000;
/** At most this many bytes are copied in total. */
export const WORKTREE_INCLUDE_MAX_BYTES = 256 * 1024 * 1024;
/** The copy never holds a new worktree back for longer. */
export const WORKTREE_INCLUDE_TIMEOUT = Duration.minutes(2);

export interface WorktreeIncludeResult {
  readonly copied: ReadonlyArray<string>;
  /** Already present in the new worktree (a file its branch tracks): left as the branch has it. */
  readonly skipped: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly path: string; readonly detail: string }>;
}

const toPathList = (stdout: string) =>
  stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .filter(
      (entry) =>
        !nodePath.isAbsolute(entry) &&
        !entry.split(/[\\/]/u).some((segment) => segment === ".." || segment === ""),
    );

/**
 * The files to copy: the NUL-separated paths `.worktreeinclude` matched (`included`) that Git
 * also ignores by its standard rules (`ignored`), inside the checkout, sorted, once each.
 */
export function parseWorktreeIncludePaths(included: string, ignored: string): string[] {
  const ignoredPaths = new Set(toPathList(ignored));
  return [...new Set(toPathList(included))].filter((entry) => ignoredPaths.has(entry)).toSorted();
}

const errorDetail = (cause: unknown) =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

const isInside = (root: string, candidate: string) => {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
};

/**
 * Refuses a target whose existing parent folders in the new worktree include a symlink (a
 * branch can track one pointing anywhere) or a non-folder: creating or writing through it
 * would land outside the worktree.
 */
async function assertRealParents(worktreeRoot: string, relativePath: string): Promise<void> {
  const parts = relativePath.split(/[\\/]/u).slice(0, -1);
  let current = worktreeRoot;
  for (const part of parts) {
    current = nodePath.join(current, part);
    let entry;
    try {
      entry = await fsPromises.lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (entry.isSymbolicLink()) throw new Error(`${current} is a symlink in the new worktree`);
    if (!entry.isDirectory()) throw new Error(`${current} is not a folder in the new worktree`);
  }
}

type Outcome =
  | { readonly kind: "copied" | "skipped"; readonly path: string }
  | { readonly kind: "failed"; readonly path: string; readonly detail: string };

async function copyOne(
  sourceRoot: string,
  worktreeRoot: string,
  realWorktreeRoot: string,
  relativePath: string,
): Promise<Outcome> {
  const target = nodePath.join(worktreeRoot, relativePath);
  if (!isInside(worktreeRoot, target)) {
    return { kind: "failed", path: relativePath, detail: "outside the worktree" };
  }
  try {
    await fsPromises.lstat(target);
    return { kind: "skipped", path: relativePath };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      return { kind: "failed", path: relativePath, detail: errorDetail(cause) };
    }
  }
  try {
    await assertRealParents(worktreeRoot, relativePath);
    await fsPromises.mkdir(nodePath.dirname(target), { recursive: true });
    // Folders created above are new and real; check once more where the file will land.
    const realParent = await fsPromises.realpath(nodePath.dirname(target));
    if (!isInside(realWorktreeRoot, realParent)) {
      return { kind: "failed", path: relativePath, detail: "outside the worktree" };
    }
    await fsPromises.cp(nodePath.join(sourceRoot, relativePath), target, {
      dereference: false,
      errorOnExist: false,
      force: false,
      recursive: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    return { kind: "copied", path: relativePath };
  } catch (cause) {
    return { kind: "failed", path: relativePath, detail: errorDetail(cause) };
  }
}

/**
 * Copies each listed path from `sourceRoot` into `worktreePath`, one at a time and within the
 * file, byte and time bounds. A path the new worktree already has is left alone, and one that
 * fails or is over a bound is reported, never failing the worktree. Symlinks are copied as links.
 */
export const copyWorktreeIncludedFiles = (input: {
  readonly sourceRoot: string;
  readonly worktreePath: string;
  readonly paths: ReadonlyArray<string>;
}): Effect.Effect<WorktreeIncludeResult> =>
  Effect.promise(async (signal) => {
    const copied: string[] = [];
    const skipped: string[] = [];
    const failed: { path: string; detail: string }[] = [];
    const realWorktreeRoot = await fsPromises.realpath(input.worktreePath);
    let bytes = 0;
    for (const [index, relativePath] of input.paths.entries()) {
      if (signal.aborted) break;
      if (index >= WORKTREE_INCLUDE_MAX_FILES) {
        failed.push({ path: relativePath, detail: "over the file limit" });
        continue;
      }
      let size = 0;
      try {
        size = (await fsPromises.lstat(nodePath.join(input.sourceRoot, relativePath))).size;
      } catch (cause) {
        failed.push({ path: relativePath, detail: errorDetail(cause) });
        continue;
      }
      if (bytes + size > WORKTREE_INCLUDE_MAX_BYTES) {
        failed.push({ path: relativePath, detail: "over the size limit" });
        continue;
      }
      const outcome = await copyOne(
        input.sourceRoot,
        input.worktreePath,
        realWorktreeRoot,
        relativePath,
      );
      if (outcome.kind === "failed") {
        failed.push({ path: outcome.path, detail: outcome.detail });
      } else if (outcome.kind === "copied") {
        bytes += size;
        copied.push(outcome.path);
      } else {
        skipped.push(outcome.path);
      }
    }
    return { copied, skipped, failed };
  }).pipe(
    Effect.timeoutOrElse({
      duration: WORKTREE_INCLUDE_TIMEOUT,
      orElse: () =>
        Effect.succeed<WorktreeIncludeResult>({
          copied: [],
          skipped: [],
          failed: [{ path: WORKTREE_INCLUDE_FILE_NAME, detail: "the copy timed out" }],
        }),
    }),
  );
