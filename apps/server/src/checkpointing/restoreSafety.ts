/**
 * Shared-checkout safety for checkpoint restores (pure; filesystem access is
 * injected).
 *
 * A restore runs `git restore -- .` and `git clean -fd -- .` at the checkpoint
 * cwd, so it rewrites the whole working tree. Other threads that work in the
 * same working tree would lose their uncommitted edits. Nested worktrees and
 * repositories (a `.git` entry between the two paths) are left alone by both
 * commands and therefore do not overlap.
 *
 * @module restoreSafety
 */
import path from "node:path";

import type { ThreadId } from "@ryco/contracts";

export interface CheckoutPathOps {
  /** Resolves symlinks (`canonicalizeFilesystemPath`). */
  readonly canonicalize: (p: string) => string;
  /** `isCaseSensitiveFileSystem()`. */
  readonly caseSensitive: boolean;
  /** True when `dir` contains a `.git` entry (`isGitRepository`). */
  readonly hasGitEntry: (dir: string) => boolean;
}

function trimTrailingSeparators(value: string): string {
  const root = path.parse(value).root;
  let next = value;
  while (next.length > root.length && /[\\/]$/.test(next)) next = next.slice(0, -1);
  return next;
}

function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative.length > 0 &&
    relative !== "." &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Whether a restore at `checkoutRoot` (a working-tree root) would rewrite files
 * under `candidate`.
 */
export function sharesWorkingTree(
  checkoutRoot: string,
  candidate: string,
  ops: CheckoutPathOps,
): boolean {
  const rootPath = trimTrailingSeparators(ops.canonicalize(checkoutRoot));
  const candidatePath = trimTrailingSeparators(ops.canonicalize(candidate));
  const fold = (value: string) => (ops.caseSensitive ? value : value.toLowerCase());
  const root = fold(rootPath);
  const other = fold(candidatePath);
  if (other === root) return true;
  // The neighbour works above the checkout: conservatively overlapping.
  if (isStrictlyInside(other, root)) return true;
  if (!isStrictlyInside(root, other)) return false;
  // Inside the checkout: a `.git` entry between the paths marks a nested
  // worktree or repository, which `git restore`/`git clean -fd` leave alone.
  let dir = candidatePath;
  while (fold(dir) !== root) {
    if (ops.hasGitEntry(dir)) return false;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return true;
}

export type RestoreSource = "ref" | "head-fallback";

export interface RestoreNeighbour {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly paths: ReadonlyArray<string>;
  /** `threadBusyReason(...) !== null || backgroundLiveness === "working"`. */
  readonly busy: boolean;
  /** `getThreadLastActivityTimestamp(threadShellSettlementInput(...))`. */
  readonly lastActivityAt: string | null;
}

export type CheckpointRestoreConflictReason =
  | "neighbour-busy"
  | "neighbour-newer"
  | "head-fallback-shared";

export type CheckpointRestoreSafety =
  | { readonly kind: "safe" }
  | {
      readonly kind: "conflict";
      readonly reason: CheckpointRestoreConflictReason;
      readonly threads: ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }>;
    };

export function evaluateCheckpointRestoreSafety(input: {
  readonly checkoutRoot: string;
  readonly source: RestoreSource;
  readonly targetInstantMs: number;
  readonly neighbours: ReadonlyArray<RestoreNeighbour>;
  readonly ops: CheckoutPathOps;
}): CheckpointRestoreSafety {
  const overlapping = input.neighbours.filter((neighbour) =>
    neighbour.paths.some((candidate) =>
      sharesWorkingTree(input.checkoutRoot, candidate, input.ops),
    ),
  );
  const conflict = (
    reason: CheckpointRestoreConflictReason,
    threads: ReadonlyArray<RestoreNeighbour>,
  ): CheckpointRestoreSafety => ({
    kind: "conflict",
    reason,
    threads: threads.map(({ threadId, title }) => ({ threadId, title })),
  });
  if (input.source === "head-fallback" && overlapping.length > 0) {
    return conflict("head-fallback-shared", overlapping);
  }
  const busy = overlapping.filter((neighbour) => neighbour.busy);
  if (busy.length > 0) return conflict("neighbour-busy", busy);
  const newer = overlapping.filter((neighbour) => {
    if (neighbour.lastActivityAt === null) return false;
    const activityMs = Date.parse(neighbour.lastActivityAt);
    return Number.isFinite(activityMs) && activityMs > input.targetInstantMs;
  });
  if (newer.length > 0) return conflict("neighbour-newer", newer);
  return { kind: "safe" };
}

const MAX_LISTED_TITLES = 3;

function formatTitles(threads: ReadonlyArray<{ readonly title: string }>): string {
  const listed = threads.slice(0, MAX_LISTED_TITLES).map((thread) => `"${thread.title}"`);
  const more = threads.length - listed.length;
  const joined =
    listed.length <= 1
      ? (listed[0] ?? "")
      : `${listed.slice(0, -1).join(", ")}${more > 0 ? ", " : " and "}${listed.at(-1)}`;
  return more > 0 ? `${joined} and ${more} more` : joined;
}

/** Why the restore is unsafe, without the "Nothing was changed." prefix. */
export function checkpointRestoreConflictReason(
  result: Extract<CheckpointRestoreSafety, { readonly kind: "conflict" }>,
  turnCount: number,
): string {
  const titles = formatTitles(result.threads);
  const plural = result.threads.length > 1;
  switch (result.reason) {
    case "neighbour-busy":
      return `${titles} ${plural ? "are" : "is"} working in this checkout. Wait for ${plural ? "them" : "it"} to finish, or give this thread its own worktree.`;
    case "neighbour-newer":
      return `${titles} changed this checkout after checkpoint ${turnCount}, so restoring files would discard ${plural ? "their" : "its"} work.`;
    case "head-fallback-shared":
      return "Checkpoint 0 is missing, so restoring it would reset this checkout to the last commit and discard other threads' uncommitted work.";
  }
}

export function checkpointRestoreConflictMessage(
  result: Extract<CheckpointRestoreSafety, { readonly kind: "conflict" }>,
  turnCount: number,
): string {
  return `Nothing was changed. ${checkpointRestoreConflictReason(result, turnCount)}`;
}
