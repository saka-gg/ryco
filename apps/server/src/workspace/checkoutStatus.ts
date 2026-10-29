import { readdir } from "node:fs/promises";
import path from "node:path";

import { classifyIgnoredPath, type ParsedWorktreeStatus } from "@ryco/shared/workspaceLifecycle";

/**
 * What a checkout's `git status --ignored=matching` says about losing work, classified
 * with the shared ignored-file rule (`classifyIgnoredPath`). One module for every
 * checkout removal path: the workspace lifecycle preflight, Agent Control plans and
 * storage cleanup apply the same rule and show the same reasons.
 */
export interface CheckoutStatus extends ParsedWorktreeStatus {
  /** Output exceeded its bound: treated as blocking, never as clean. */
  readonly truncated: boolean;
}

/** Bound on directory entries visited while deciding ignored directories are empty. */
const IGNORED_DIRECTORY_SCAN_LIMIT = 4_096;

/**
 * Whether `directory` holds anything but (nested) empty directories. Files,
 * symlinks and unreadable directories count as content; null when the bound
 * runs out first (callers keep the entry).
 */
async function directoryHoldsContent(
  directory: string,
  budget: { remaining: number },
): Promise<boolean | null> {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      budget.remaining -= 1;
      if (budget.remaining < 0) return null;
      if (!entry.isDirectory()) return true;
      pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

/**
 * `--ignored=matching` lists an ignored directory even when it holds only
 * empty directories, which traditional mode never reported: nothing there can
 * be lost, so such entries are dropped. `includeRegenerable` also drops empty
 * cache directories (storage cleanup, which keeps every cache folder that holds
 * anything); the lifecycle preview lists them as caches it discards.
 */
export async function withoutEmptyIgnoredDirectories(
  checkout: string,
  status: ParsedWorktreeStatus,
  options: { readonly includeRegenerable?: boolean } = {},
): Promise<ParsedWorktreeStatus> {
  const lists = {
    protectedIgnored: status.protectedIgnored,
    regenerableIgnored: options.includeRegenerable ? status.regenerableIgnored : [],
  };
  if (
    ![...lists.protectedIgnored, ...lists.regenerableIgnored].some((entry) => entry.endsWith("/"))
  )
    return status;
  const budget = { remaining: IGNORED_DIRECTORY_SCAN_LIMIT };
  const keep = async (entries: readonly string[]) => {
    const kept: string[] = [];
    for (const entry of entries) {
      if (
        entry.endsWith("/") &&
        (await directoryHoldsContent(path.join(checkout, entry), budget)) === false
      )
        continue;
      kept.push(entry);
    }
    return kept;
  };
  return {
    ...status,
    protectedIgnored: await keep(lists.protectedIgnored),
    ...(options.includeRegenerable
      ? { regenerableIgnored: await keep(lists.regenerableIgnored) }
      : {}),
  };
}

/** Anything Git would refuse to discard, or ignored content that is not a known cache. */
export const checkoutHasBlockingChanges = (status: CheckoutStatus): boolean =>
  status.truncated ||
  status.modified > 0 ||
  status.untracked > 0 ||
  status.protectedIgnored.length > 0;

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * "2 ignored files that are not a known cache<verb> (.env, local.sqlite)": the wording the
 * removal reasons and the lifecycle preview share.
 */
export const describeProtectedIgnored = (entries: readonly string[], verb = "") =>
  `${plural(entries.length, "ignored file")} that ${entries.length === 1 ? "is" : "are"} not a known cache${verb} (${entries.slice(0, 3).join(", ")})`;

/**
 * Why removing the checkout without discarding anything is refused, one reason per
 * kind of content that would be lost; empty when nothing would be.
 */
export function checkoutChangeBlockers(status: CheckoutStatus): string[] {
  const blockers: string[] = [];
  if (status.truncated) blockers.push("The checkout has too many changes to verify safely.");
  if (status.modified > 0)
    blockers.push(`${plural(status.modified, "tracked file")} has uncommitted changes.`);
  if (status.untracked > 0)
    blockers.push(`${plural(status.untracked, "untracked file")} would be lost.`);
  if (status.protectedIgnored.length > 0)
    blockers.push(`${describeProtectedIgnored(status.protectedIgnored, " would be lost")}.`);
  return blockers;
}

/**
 * Ignored directories the shared rule calls regenerable (`node_modules/`, `dist/`, …),
 * as Git listed them (relative, with the trailing slash). Ignored regenerable files
 * (`*.tsbuildinfo`, `.DS_Store`) are not in this list.
 */
export const ignoredCacheDirectories = (status: ParsedWorktreeStatus): string[] =>
  status.regenerableIgnored.filter((entry) => entry.endsWith("/"));

/**
 * The shared rule for cleanup that runs without a review (storage cleanup): an ignored entry is
 * regenerable only by its own name (`node_modules/`, `tsconfig.tsbuildinfo`, `.DS_Store`), not
 * because a folder above it has a cache-like name. Matching mode lists an entry on its own when
 * Git does not ignore the folder above it as a whole or that folder holds tracked files, so the
 * folder (`build/`, `dist/`) is not shown to be a cache: `build/signing.properties` stays
 * protected. Remove checkout, which the user reviews first, keeps the full rule.
 */
export function withRegenerableByOwnNameOnly(status: ParsedWorktreeStatus): ParsedWorktreeStatus {
  const byOwnName = (entry: string) =>
    classifyIgnoredPath(entry.slice(entry.replace(/\/$/, "").lastIndexOf("/") + 1)) ===
    "regenerable";
  const inferred = status.regenerableIgnored.filter((entry) => !byOwnName(entry));
  if (inferred.length === 0) return status;
  return {
    ...status,
    protectedIgnored: [...status.protectedIgnored, ...inferred],
    regenerableIgnored: status.regenerableIgnored.filter(byOwnName),
  };
}
