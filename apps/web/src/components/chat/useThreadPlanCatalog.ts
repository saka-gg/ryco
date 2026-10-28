import { useMemo } from "react";
import type { ThreadId } from "@ryco/contracts";
import { useStore, type AppState } from "../../store";
import type { Thread } from "../../types";

const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];

export type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

interface CatalogEntryInputs {
  /** Whether a shell lists the thread. Its identity does not matter: every
   * streamed delta replaces the shell to move its `updatedAt`. */
  exists: boolean;
  proposedPlanIds: readonly string[] | undefined;
  proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;
  entry: ThreadPlanCatalogEntry;
}

/**
 * Selects the proposed-plan catalog for a set of threads while preserving
 * referential stability: unchanged threads keep their prior entry reference,
 * and an unchanged catalog keeps its array, so downstream memoized selectors
 * don't re-run needlessly.
 */
export function createThreadPlanCatalogSelector(
  threadIds: readonly ThreadId[],
): (state: AppState) => ThreadPlanCatalogEntry[] {
  let previousThreadIds: readonly ThreadId[] = [];
  let previousResult: ThreadPlanCatalogEntry[] = [];
  let previousEntries = new Map<ThreadId, CatalogEntryInputs>();

  return (state) => {
    const sameThreadIds =
      previousThreadIds.length === threadIds.length &&
      previousThreadIds.every((id, index) => id === threadIds[index]);
    const nextEntries = new Map<ThreadId, CatalogEntryInputs>();
    const nextResult: ThreadPlanCatalogEntry[] = [];
    let changed = !sameThreadIds;

    for (const threadId of threadIds) {
      let exists = false;
      let proposedPlanIds: readonly string[] | undefined;
      let proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;

      for (const environmentState of Object.values(state.environmentStateById)) {
        if (!environmentState.threadShellById[threadId]) {
          continue;
        }
        exists = true;
        proposedPlanIds = environmentState.proposedPlanIdsByThreadId[threadId];
        proposedPlansById = environmentState.proposedPlanByThreadId[threadId] as
          | Record<string, Thread["proposedPlans"][number]>
          | undefined;
        break;
      }

      const previous = previousEntries.get(threadId);
      if (!exists) {
        if (
          previous &&
          !previous.exists &&
          previous.proposedPlanIds === undefined &&
          previous.proposedPlansById === undefined
        ) {
          nextEntries.set(threadId, previous);
          continue;
        }
        changed = true;
        nextEntries.set(threadId, {
          exists: false,
          proposedPlanIds: undefined,
          proposedPlansById: undefined,
          entry: { id: threadId, proposedPlans: EMPTY_PROPOSED_PLANS },
        });
        continue;
      }

      if (
        previous &&
        previous.exists &&
        previous.proposedPlanIds === proposedPlanIds &&
        previous.proposedPlansById === proposedPlansById
      ) {
        nextEntries.set(threadId, previous);
        nextResult.push(previous.entry);
        continue;
      }

      changed = true;
      const proposedPlans =
        proposedPlanIds && proposedPlanIds.length > 0 && proposedPlansById
          ? proposedPlanIds.flatMap((planId) => {
              const proposedPlan = proposedPlansById?.[planId];
              return proposedPlan ? [proposedPlan] : [];
            })
          : EMPTY_PROPOSED_PLANS;
      const entry = { id: threadId, proposedPlans };
      nextEntries.set(threadId, {
        exists: true,
        proposedPlanIds,
        proposedPlansById,
        entry,
      });
      nextResult.push(entry);
    }

    if (!changed && previousResult.length === nextResult.length) {
      return previousResult;
    }

    previousThreadIds = threadIds;
    previousEntries = nextEntries;
    previousResult = nextResult;
    return nextResult;
  };
}

/** The proposed-plan catalog for a set of threads; see `createThreadPlanCatalogSelector`. */
export function useThreadPlanCatalog(threadIds: readonly ThreadId[]): ThreadPlanCatalogEntry[] {
  return useStore(useMemo(() => createThreadPlanCatalogSelector(threadIds), [threadIds]));
}
