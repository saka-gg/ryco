import type {
  AgentControlProposal,
  AgentControlProposalId,
  EnvironmentId,
  ProjectId,
} from "@ryco/contracts";
import {
  useAgentControlStore,
  type AgentControlQueueState,
} from "@ryco/client-runtime/state/agentControl";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { projectCheckoutKey } from "../../../projectCheckouts.logic";
import type { AutomationCheckoutRef } from "./automationProjectCounts.logic";
import {
  retainScheduleProposalHistory,
  useScheduleProposalHistoryStore,
  type ScheduleProposalHistory,
} from "./scheduleProposalHistory";
import { environmentIdsOfKey, proposalSyncKey } from "./useAutomationProposalSync";

interface DismissedLapsedState {
  /** Proposal ids by environment, dismissed this session. */
  readonly byEnvironment: Readonly<Record<string, readonly AgentControlProposalId[]>>;
}

/** Session-only: a dismissed lapsed proposal stays dismissed until the app reloads. */
const useDismissedLapsedStore = create<DismissedLapsedState>()(() => ({ byEnvironment: {} }));

/** "Dismiss" / "Remove" on a proposal that expired undecided. */
export function dismissLapsedScheduleProposal(
  environmentId: EnvironmentId,
  proposalId: AgentControlProposalId,
): void {
  useDismissedLapsedStore.setState((state) => {
    const current = state.byEnvironment[environmentId] ?? [];
    if (current.includes(proposalId)) return state;
    return { byEnvironment: { ...state.byEnvironment, [environmentId]: [...current, proposalId] } };
  });
}

/** Undo a dismissal. */
export function restoreLapsedScheduleProposal(
  environmentId: EnvironmentId,
  proposalId: AgentControlProposalId,
): void {
  useDismissedLapsedStore.setState((state) => {
    const current = state.byEnvironment[environmentId] ?? [];
    if (!current.includes(proposalId)) return state;
    return {
      byEnvironment: {
        ...state.byEnvironment,
        [environmentId]: current.filter((id) => id !== proposalId),
      },
    };
  });
}

/** Test-only. */
export function resetDismissedLapsedProposalsForTests(): void {
  useDismissedLapsedStore.setState({ byEnvironment: {} });
}

const NO_PROPOSALS: readonly AgentControlProposal[] = [];
const NO_DISMISSED: ReadonlySet<AgentControlProposalId> = new Set();

/* One array per queue state, so a checkout's proposals keep their identity
   until its device's queue actually changes. */
const proposalsByQueue = new WeakMap<AgentControlQueueState, readonly AgentControlProposal[]>();
function queueProposalsOf(queue: AgentControlQueueState | undefined) {
  if (!queue) return NO_PROPOSALS;
  let proposals = proposalsByQueue.get(queue);
  if (!proposals) {
    proposals = Object.values(queue.proposalsById);
    proposalsByQueue.set(queue, proposals);
  }
  return proposals;
}

/* One array per (queue, history) pair: the identity changes only with either. */
const mergedByQueue = new WeakMap<
  readonly AgentControlProposal[],
  WeakMap<ScheduleProposalHistory, readonly AgentControlProposal[]>
>();

/**
 * A device's queue proposals plus the finished schedule proposals the
 * session remembers beyond the queue's short list of finished ones. Stable
 * identity per queue state and history.
 */
export function checkoutQueueProposals(
  queue: AgentControlQueueState | undefined,
  history: ScheduleProposalHistory | undefined,
): readonly AgentControlProposal[] {
  const live = queueProposalsOf(queue);
  if (!history) return live;
  let byHistory = mergedByQueue.get(live);
  if (!byHistory) {
    byHistory = new WeakMap();
    mergedByQueue.set(live, byHistory);
  }
  let merged = byHistory.get(history);
  if (!merged) {
    const listed = new Set(live.map((proposal) => proposal.proposalId));
    const remembered = Object.values(history).filter(
      (proposal) => !listed.has(proposal.proposalId),
    );
    merged = remembered.length > 0 ? [...live, ...remembered] : live;
    byHistory.set(history, merged);
  }
  return merged;
}

const dismissedByList = new WeakMap<
  readonly AgentControlProposalId[],
  ReadonlySet<AgentControlProposalId>
>();
function dismissedSetOf(list: readonly AgentControlProposalId[] | undefined) {
  if (!list?.length) return NO_DISMISSED;
  let set = dismissedByList.get(list);
  if (!set) {
    set = new Set(list);
    dismissedByList.set(list, set);
  }
  return set;
}

/** What a checkout's device queue says, for telling lapsed schedule proposals apart. */
export interface CheckoutProposalQueue {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The device's queue delivered its snapshot; until then nothing can be called lapsed. */
  readonly hydrated: boolean;
  /**
   * Every proposal the device's queue holds — live and recent (expired ones
   * included), any project and kind — plus the finished schedule proposals
   * the session remembers after the queue let them go, in no particular
   * order. The snapshot of the automation centre drops expired proposals.
   */
  readonly queueProposals: readonly AgentControlProposal[];
  /** Lapsed proposals the reader dismissed this session. */
  readonly dismissed: ReadonlySet<AgentControlProposalId>;
}

/**
 * The raw material for "Proposal expired · Propose again": each checkout's
 * device queue, the finished schedule proposals remembered beyond it, and
 * the session's dismissals. Pair it with `useAutomationProposalSync` (or
 * `useProjectAutomations`, which syncs) so the queues are live; while
 * mounted it also reads each device's longest recent list once per
 * connection. Identities are stable per device queue and history.
 */
export function useLapsedScheduleProposals(
  checkouts: readonly AutomationCheckoutRef[],
): ReadonlyMap<string, CheckoutProposalQueue> {
  const environmentsKey = proposalSyncKey(checkouts.map((checkout) => checkout.environmentId));
  useEffect(() => {
    const releases = environmentIdsOfKey(environmentsKey).map(retainScheduleProposalHistory);
    return () => {
      for (const release of releases) release();
    };
  }, [environmentsKey]);
  const queues = useAgentControlStore(
    useShallow((state) =>
      checkouts.map((checkout) => state.queueByEnvironmentId[checkout.environmentId]),
    ),
  );
  const histories = useScheduleProposalHistoryStore(
    useShallow((state) => checkouts.map((checkout) => state.byEnvironment[checkout.environmentId])),
  );
  const dismissed = useDismissedLapsedStore(
    useShallow((state) => checkouts.map((checkout) => state.byEnvironment[checkout.environmentId])),
  );
  return useMemo(
    () =>
      new Map(
        checkouts.map((checkout, index) => {
          const key = projectCheckoutKey(checkout.environmentId, checkout.projectId);
          const queue = queues[index];
          return [
            key,
            {
              key,
              environmentId: checkout.environmentId,
              projectId: checkout.projectId,
              hydrated: queue?.hydrated ?? false,
              queueProposals: checkoutQueueProposals(queue, histories[index]),
              dismissed: dismissedSetOf(dismissed[index]),
            },
          ];
        }),
      ),
    [checkouts, dismissed, histories, queues],
  );
}
