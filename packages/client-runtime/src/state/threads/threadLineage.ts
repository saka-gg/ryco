/**
 * Client helpers for server-owned thread lineage (spec 12, delegation-lineage).
 *
 * Lineage is provenance only. `relationship` is an open string on the wire; any
 * value other than "delegated" is treated as "no known relationship" and the
 * thread renders flat.
 */
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { ThreadLineage } from "@ryco/contracts";
import { Schema } from "effect";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import type { SidebarThreadSummary } from "./types.ts";

export const DELEGATED_THREAD_RELATIONSHIP = "delegated";
const MAX_LINEAGE_WALK = 64;

/** Validates untrusted cached lineage before it is reused. */
export const isThreadLineage = Schema.is(ThreadLineage);

export function isDelegatedThreadLineage(
  lineage: ThreadLineage | null | undefined,
): lineage is ThreadLineage {
  return (
    lineage !== null &&
    lineage !== undefined &&
    lineage.relationship === DELEGATED_THREAD_RELATIONSHIP
  );
}

/** Null and undefined both mean "no lineage" and compare equal. */
export function threadLineagesEqual(
  left: ThreadLineage | null | undefined,
  right: ThreadLineage | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.parentThreadId === right.parentThreadId &&
    left.rootThreadId === right.rootThreadId &&
    left.relationship === right.relationship
  );
}

type DelegatedChildCandidate = Pick<
  SidebarThreadSummary,
  "id" | "environmentId" | "createdAt" | "archivedAt" | "lineage"
>;

/**
 * Direct, delegated, non-archived children of `parent` in the same environment,
 * oldest first. Deliberately one level: the thread view lists direct children,
 * the inbox flattens descendants (spec D8).
 */
export function selectDelegatedChildThreads<T extends DelegatedChildCandidate>(
  threads: ReadonlyArray<T>,
  parent: ScopedThreadRef,
): T[] {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === parent.environmentId &&
        thread.archivedAt === null &&
        isDelegatedThreadLineage(thread.lineage) &&
        thread.lineage.parentThreadId === parent.threadId,
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

/** State-derived attention bucket, ignoring pin/focus placement. */
export type DelegatedNestingUrgency = "needs-input" | "active" | "recent" | "snoozed" | "settled";

export interface DelegatedNestingItem {
  /** `scopedThreadKey(scopeThreadRef(environmentId, threadId))` */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly lineage: ThreadLineage | null | undefined;
  readonly pinned: boolean;
  readonly focused: boolean;
  /** State-derived section, ignoring pin/focus placement. */
  readonly urgency: DelegatedNestingUrgency;
}

export interface DelegatedNestingPlan {
  /** Child key to its host key. The host is always top-level. */
  readonly hostByChildKey: ReadonlyMap<string, string>;
  /** Host key to its folded children, in input order. */
  readonly childKeysByHostKey: ReadonlyMap<string, ReadonlyArray<string>>;
}

const URGENCY_RANK: Record<DelegatedNestingUrgency, number> = {
  "needs-input": 0,
  active: 1,
  recent: 2,
  snoozed: 3,
  settled: 4,
};

/** The single attention predicate: only quiet, unplaced delegated children fold. */
function canNest(item: DelegatedNestingItem): boolean {
  return (
    isDelegatedThreadLineage(item.lineage) &&
    !item.pinned &&
    !item.focused &&
    URGENCY_RANK[item.urgency] >= URGENCY_RANK.recent
  );
}

function nearestVisibleAncestorKey(
  item: DelegatedNestingItem,
  lineage: ThreadLineage,
  itemByKey: ReadonlyMap<string, DelegatedNestingItem>,
  lineageByKey: ReadonlyMap<string, ThreadLineage | null | undefined> | undefined,
): string | null {
  const visited = new Set<string>([item.key]);
  let cursor: ThreadLineage | null | undefined = lineage;
  for (let hops = 0; hops < MAX_LINEAGE_WALK && isDelegatedThreadLineage(cursor); hops += 1) {
    const parentKey = scopedThreadKey(scopeThreadRef(item.environmentId, cursor.parentThreadId));
    if (visited.has(parentKey)) break;
    if (itemByKey.has(parentKey)) return parentKey;
    visited.add(parentKey);
    cursor = lineageByKey?.get(parentKey);
  }
  // Dead end (e.g. a deleted middle child without a shell): use a visible root.
  const rootKey = scopedThreadKey(scopeThreadRef(item.environmentId, lineage.rootThreadId));
  return rootKey !== item.key && itemByKey.has(rootKey) ? rootKey : null;
}

/**
 * Plans which delegated children fold under a top-level host (spec D7-D9).
 *
 * A child folds only when it is delegated, not pinned, not focused, quiet
 * (`recent`, `snoozed` or `settled`) and not more urgent than its nearest
 * visible ancestor. Nested descendants flatten to the topmost visible host.
 * Invisible intermediates are walked through `lineageByKey`.
 */
export function planDelegatedNesting(
  items: ReadonlyArray<DelegatedNestingItem>,
  options?: { readonly lineageByKey?: ReadonlyMap<string, ThreadLineage | null | undefined> },
): DelegatedNestingPlan {
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const candidateHostByKey = new Map<string, string>();

  for (const item of items) {
    if (!canNest(item) || !isDelegatedThreadLineage(item.lineage)) continue;
    const hostKey = nearestVisibleAncestorKey(item, item.lineage, itemByKey, options?.lineageByKey);
    const host = hostKey === null ? undefined : itemByKey.get(hostKey);
    if (host === undefined) continue;
    // Only the nearest visible ancestor is considered, so the result is predictable.
    if (URGENCY_RANK[item.urgency] < URGENCY_RANK[host.urgency]) continue;
    candidateHostByKey.set(item.key, host.key);
  }

  // Break cycles: every item on a candidate cycle stays top-level. Deleting
  // during iteration is safe: a removed key would resolve to an empty path.
  for (const startKey of candidateHostByKey.keys()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | undefined = startKey;
    while (cursor !== undefined && candidateHostByKey.has(cursor) && !onPath.has(cursor)) {
      path.push(cursor);
      onPath.add(cursor);
      cursor = candidateHostByKey.get(cursor);
    }
    if (cursor !== undefined && onPath.has(cursor)) {
      for (const key of path.slice(path.indexOf(cursor))) candidateHostByKey.delete(key);
    }
  }

  // Flatten to the topmost host. The remaining candidate graph is acyclic.
  const hostByChildKey = new Map<string, string>();
  const childKeysByHostKey = new Map<string, string[]>();
  for (const item of items) {
    let hostKey = candidateHostByKey.get(item.key);
    if (hostKey === undefined) continue;
    let next = candidateHostByKey.get(hostKey);
    while (next !== undefined) {
      hostKey = next;
      next = candidateHostByKey.get(hostKey);
    }
    hostByChildKey.set(item.key, hostKey);
    const children = childKeysByHostKey.get(hostKey);
    if (children === undefined) childKeysByHostKey.set(hostKey, [item.key]);
    else children.push(item.key);
  }

  return { hostByChildKey, childKeysByHostKey };
}
