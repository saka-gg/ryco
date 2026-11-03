/**
 * Opt-in delegation limits (`AgentControlDelegationLimits`): how deep a delegation tree may grow
 * and how many tasks one tree may create. A delegation tree starts at the nearest thread that was
 * not delegated itself (`threadLineage.ts`); its tasks sit at depth 1, their tasks at depth 2.
 *
 * Lineage is provenance and grants nothing. These rules read it only to refuse: a limit can
 * take delegation away from a thread, never give a thread anything.
 *
 * Pure module: no services, no I/O.
 *
 * @module delegationLimits
 */
import type { ThreadId, ThreadLineage } from "@ryco/contracts";

import { DELEGATED_THREAD_RELATIONSHIP, MAX_THREAD_LINEAGE_DEPTH } from "./threadLineage.ts";

export interface DelegationLimits {
  readonly maxDepth: number | null;
  readonly maxTasksPerTree: number | null;
}

export const NO_DELEGATION_LIMITS: DelegationLimits = { maxDepth: null, maxTasksPerTree: null };

/** Parent reads a walk may make: lineage never chains deeper (`resolveChildThreadLineage`). */
export const DELEGATION_TREE_WALK_LIMIT = MAX_THREAD_LINEAGE_DEPTH;

export const hasDelegationLimits = (limits: DelegationLimits): boolean =>
  limits.maxDepth !== null || limits.maxTasksPerTree !== null;

/** The part of a thread the rules read. */
export interface DelegationNode {
  readonly id: ThreadId;
  readonly lineage?: ThreadLineage | null | undefined;
}

/** Where a thread sits in its delegation tree. */
export interface DelegationPosition {
  /** Delegated hops above the thread: 0 for a thread that was not delegated. */
  readonly depth: number;
  /** The tree's root: the thread itself unless it was delegated. */
  readonly rootThreadId: ThreadId;
}

export const isDelegatedLineage = (lineage: ThreadLineage | null | undefined): boolean =>
  lineage?.relationship === DELEGATED_THREAD_RELATIONSHIP;

/**
 * A thread's place in its delegation tree, walking its delegated parents. A parent that is gone
 * ends the walk with the hops counted so far. A chain that loops or runs past the lineage bound
 * counts as the deepest possible, which every depth limit refuses.
 */
export function delegationPosition(
  thread: DelegationNode,
  lookup: (threadId: ThreadId) => DelegationNode | undefined,
): DelegationPosition {
  const lineage = thread.lineage;
  const rootThreadId = isDelegatedLineage(lineage) ? lineage!.rootThreadId : thread.id;
  let depth = 0;
  let cursor: DelegationNode | undefined = thread;
  while (cursor !== undefined && isDelegatedLineage(cursor.lineage)) {
    depth += 1;
    if (depth > MAX_THREAD_LINEAGE_DEPTH) return { depth: Number.MAX_SAFE_INTEGER, rootThreadId };
    cursor = lookup(cursor.lineage!.parentThreadId);
  }
  return { depth, rootThreadId };
}

/** Whether a thread at `depth` may delegate at all: its tasks would sit at `depth + 1`. */
export const mayDelegateAtDepth = (limits: DelegationLimits, depth: number): boolean =>
  limits.maxDepth === null || depth + 1 <= limits.maxDepth;

/**
 * Whether `newTasks` more tasks from a thread at `callerDepth`, in a tree that already has
 * `treeTasks`, would pass the limits. Agent Control explains a refusal in words
 * (`agentControl/delegationLimitCheck.ts`); the decider only backstops it.
 */
export function exceedsDelegationLimits(input: {
  readonly limits: DelegationLimits;
  readonly callerDepth: number;
  readonly treeTasks: number;
  readonly newTasks: number;
}): boolean {
  return (
    !mayDelegateAtDepth(input.limits, input.callerDepth) ||
    (input.limits.maxTasksPerTree !== null &&
      input.treeTasks + input.newTasks > input.limits.maxTasksPerTree)
  );
}

/** The decider's refusal of a create past the limits: a race the earlier checks did not see. */
export const DELEGATION_LIMIT_DECIDER_DETAIL =
  "Delegation limit: this delegation tree reached its depth or task limit.";

/** Tasks the tree rooted at `rootThreadId` has: delegated threads that record it as their root. */
export function delegationTreeTaskCount(
  threads: Iterable<DelegationNode & { readonly deletedAt?: string | null }>,
  rootThreadId: ThreadId,
): number {
  let count = 0;
  for (const thread of threads) {
    if (
      isDelegatedLineage(thread.lineage) &&
      thread.lineage!.rootThreadId === rootThreadId &&
      (thread.deletedAt ?? null) === null
    )
      count += 1;
  }
  return count;
}
