/**
 * `.worktreeinclude`: a file at the root of a checkout, in gitignore syntax, naming untracked
 * files (usually gitignored ones: `.env`, local config, a toolchain) that every worktree made
 * from that checkout gets a copy of, so an agent's first run there does not fail on a missing
 * `.env`. Ported from Synara's GitCore (`listWorktreeTransferPaths`): the files are what
 * `git ls-files --others --ignored --exclude-from=.worktreeinclude` lists in the source checkout.
 *
 * Loaded through `import()` when a worktree is created, never at boot; it imports no boot
 * module (the git runner is handed in).
 *
 * @module vcs/worktreeInclude
 */
import { promises as fsPromises } from "node:fs";
import nodePath from "node:path";

import { Effect } from "effect";

export const WORKTREE_INCLUDE_FILE_NAME = ".worktreeinclude";

/** Synara's cap on the listing (`WORKTREE_TRANSFER_MAX_OUTPUT_BYTES`). */
export const WORKTREE_INCLUDE_MAX_LIST_BYTES = 64 * 1024 * 1024;

export interface WorktreeIncludeResult {
  readonly copied: ReadonlyArray<string>;
  /** Already present in the new worktree (a file its branch tracks): left as the branch has it. */
  readonly skipped: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly path: string; readonly detail: string }>;
}

/** The NUL-separated paths `git ls-files -z` printed, keeping only ones inside the checkout. */
export function parseWorktreeIncludePaths(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split("\0")
        .filter((entry) => entry.length > 0)
        .filter(
          (entry) =>
            !nodePath.isAbsolute(entry) &&
            !entry.split(/[\\/]/u).some((segment) => segment === ".." || segment === ""),
        ),
    ),
  ].toSorted();
}

const errorDetail = (cause: unknown) =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

/**
 * Copies each listed path from `sourceRoot` into `worktreePath`. A path the new worktree
 * already has is left alone, and one that fails is reported, never failing the worktree.
 * Symlinks are copied as links, like the dependency hydration does.
 */
export const copyWorktreeIncludedFiles = (input: {
  readonly sourceRoot: string;
  readonly worktreePath: string;
  readonly paths: ReadonlyArray<string>;
}): Effect.Effect<WorktreeIncludeResult> =>
  Effect.forEach(
    input.paths,
    (relativePath) =>
      Effect.promise(async () => {
        const target = nodePath.join(input.worktreePath, relativePath);
        const insideTarget = nodePath.relative(input.worktreePath, target);
        if (insideTarget.startsWith("..") || nodePath.isAbsolute(insideTarget)) {
          return { kind: "failed" as const, path: relativePath, detail: "outside the worktree" };
        }
        try {
          await fsPromises.lstat(target);
          return { kind: "skipped" as const, path: relativePath };
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
            return { kind: "failed" as const, path: relativePath, detail: errorDetail(cause) };
          }
        }
        try {
          await fsPromises.mkdir(nodePath.dirname(target), { recursive: true });
          await fsPromises.cp(nodePath.join(input.sourceRoot, relativePath), target, {
            dereference: false,
            errorOnExist: false,
            force: false,
            recursive: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
          return { kind: "copied" as const, path: relativePath };
        } catch (cause) {
          return { kind: "failed" as const, path: relativePath, detail: errorDetail(cause) };
        }
      }),
    { concurrency: 4 },
  ).pipe(
    Effect.map((outcomes) => ({
      copied: outcomes.flatMap((outcome) => (outcome.kind === "copied" ? [outcome.path] : [])),
      skipped: outcomes.flatMap((outcome) => (outcome.kind === "skipped" ? [outcome.path] : [])),
      failed: outcomes.flatMap((outcome) =>
        outcome.kind === "failed" ? [{ path: outcome.path, detail: outcome.detail }] : [],
      ),
    })),
  );
