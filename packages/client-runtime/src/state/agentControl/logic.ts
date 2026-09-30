/**
 * Pure Agent Control proposal-queue state: hydration from queue snapshots,
 * per-proposal deduplicated change-event application, and selectors.
 *
 * The server is the only policy authority — this module never decides
 * anything; it renders what the server published. Every change event
 * carries the full proposal document, so applying state is an upsert
 * keyed by `proposalId`:
 *
 *   - A snapshot replaces the environment's state wholesale (server
 *     revisions are per-process, not durable, so each snapshot is a fresh
 *     baseline).
 *   - Per proposal, a document may never move backward through the legal
 *     status progression (pending → approved → executing → terminal, each
 *     status entered at most once). Ordering by status rather than by
 *     event revision makes replayed, duplicated, or reordered deliveries
 *     all harmless — a stale document simply loses the upsert.
 *   - Terminal proposals stay as bounded history; the oldest are pruned.
 */
import {
  AGENT_CONTROL_QUEUE_RECENT_LIMIT_DEFAULT,
  AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES,
  type AgentControlProposal,
  type AgentControlProposalStatus,
  type AgentControlProposalStreamEvent,
  type ThreadId,
} from "@ryco/contracts";

export interface AgentControlQueueState {
  /** Whether a snapshot has been applied since (re)subscribing. */
  readonly hydrated: boolean;
  /** Highest observed change revision; informational, not used to drop. */
  readonly revision: number;
  readonly proposalsById: Readonly<Record<string, AgentControlProposal>>;
}

export const EMPTY_AGENT_CONTROL_QUEUE_STATE: AgentControlQueueState = {
  hydrated: false,
  revision: 0,
  proposalsById: {},
};

/** Terminal proposals kept as local history before pruning the oldest. */
export const AGENT_CONTROL_CLIENT_HISTORY_LIMIT = AGENT_CONTROL_QUEUE_RECENT_LIMIT_DEFAULT;

const TERMINAL_STATUSES: ReadonlySet<AgentControlProposalStatus> = new Set(
  AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES,
);

export function isTerminalAgentControlStatus(status: AgentControlProposalStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Position in the one-way status progression from the server's legal
 * transition table. All terminal statuses share a rank: a proposal enters
 * exactly one of them, so equal-rank documents are identical.
 */
const STATUS_PROGRESSION_RANK: Record<AgentControlProposalStatus, number> = {
  "pending-user-approval": 0,
  approved: 1,
  executing: 2,
  rejected: 3,
  expired: 3,
  completed: 3,
  failed: 3,
  cancelled: 3,
};

const hasPendingReturns = (proposal: AgentControlProposal) =>
  proposal.completionReturns?.some(
    (result) =>
      result.status === "waiting" || result.status === "ready" || result.status === "dispatching",
  ) ?? false;

function mergeCompletionReturns(
  current: AgentControlProposal["completionReturns"],
  incoming: AgentControlProposal["completionReturns"],
): AgentControlProposal["completionReturns"] {
  if (!incoming?.length) return current;
  const byChild = new Map((current ?? []).map((result) => [result.childThreadId, result]));
  let changed = false;
  for (const result of incoming) {
    const previous = byChild.get(result.childThreadId);
    if (
      previous &&
      (result.revision <= previous.revision ||
        result.parentThreadId !== previous.parentThreadId ||
        result.parentTurnId !== previous.parentTurnId ||
        result.initialMessageId !== previous.initialMessageId)
    )
      continue;
    byChild.set(result.childThreadId, result);
    changed = true;
  }
  return changed ? [...byChild.values()] : current;
}

function pruneTerminalHistory(
  proposalsById: Readonly<Record<string, AgentControlProposal>>,
): Readonly<Record<string, AgentControlProposal>> {
  const terminal = Object.values(proposalsById).filter(
    (proposal) => isTerminalAgentControlStatus(proposal.status) && !hasPendingReturns(proposal),
  );
  if (terminal.length <= AGENT_CONTROL_CLIENT_HISTORY_LIMIT) {
    return proposalsById;
  }
  const dropped = terminal
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(AGENT_CONTROL_CLIENT_HISTORY_LIMIT);
  const next = { ...proposalsById };
  for (const proposal of dropped) {
    delete next[proposal.proposalId];
  }
  return next;
}

export function applyAgentControlStreamEvent(
  state: AgentControlQueueState,
  event: AgentControlProposalStreamEvent,
): AgentControlQueueState {
  if (event.type === "snapshot") {
    const proposalsById: Record<string, AgentControlProposal> = {};
    for (const proposal of [...event.queue.active, ...event.queue.recent]) {
      proposalsById[proposal.proposalId] = proposal;
    }
    return {
      hydrated: true,
      revision: event.queue.revision,
      proposalsById,
    };
  }

  // Change events before the first snapshot have no state to update; the
  // snapshot that follows will cover them.
  if (!state.hydrated) {
    return state;
  }
  let next = event.proposal;
  const current = state.proposalsById[next.proposalId];
  if (current !== undefined) {
    const currentRank = STATUS_PROGRESSION_RANK[current.status];
    const nextRank = STATUS_PROGRESSION_RANK[next.status];
    // Stale document from a reordered delivery: the progression never
    // moves backward, so the lower-ranked document loses.
    if (nextRank < currentRank) {
      return state;
    }
    const completionReturns = mergeCompletionReturns(
      current.completionReturns,
      next.completionReturns,
    );
    if (nextRank === currentRank) {
      // Dispatch status and child completion are independent lifecycles.
      // Durable per-child revisions survive reconnect and clock changes.
      if (completionReturns === current.completionReturns) return state;
      next = {
        ...current,
        completionReturns,
        updatedAt: next.updatedAt > current.updatedAt ? next.updatedAt : current.updatedAt,
      };
    } else if (completionReturns) {
      next = { ...next, completionReturns };
    }
  }
  return {
    hydrated: true,
    revision: Math.max(state.revision, event.revision),
    proposalsById: pruneTerminalHistory({
      ...state.proposalsById,
      [next.proposalId]: next,
    }),
  };
}

/** Non-terminal proposals, oldest first — the live queue. */
export function selectActiveAgentControlProposals(
  state: AgentControlQueueState,
): ReadonlyArray<AgentControlProposal> {
  return Object.values(state.proposalsById)
    .filter(
      (proposal) => !isTerminalAgentControlStatus(proposal.status) || hasPendingReturns(proposal),
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.proposalId.localeCompare(right.proposalId),
    );
}

/** Terminal proposals, most recently updated first — the history. */
export function selectRecentAgentControlProposals(
  state: AgentControlQueueState,
): ReadonlyArray<AgentControlProposal> {
  return Object.values(state.proposalsById)
    .filter(
      (proposal) => isTerminalAgentControlStatus(proposal.status) && !hasPendingReturns(proposal),
    )
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.proposalId.localeCompare(left.proposalId),
    );
}

/**
 * Live proposals raised from inside `threadId` — the thread-local card
 * shows the caller thread its own outstanding requests.
 */
export function selectAgentControlProposalsForThread(
  state: AgentControlQueueState,
  threadId: ThreadId,
): ReadonlyArray<AgentControlProposal> {
  return [
    ...selectActiveAgentControlProposals(state),
    ...selectRecentAgentControlProposals(state).filter(
      (proposal) => proposal.completionReturns?.length,
    ),
  ].filter(
    (proposal) =>
      proposal.principal.kind === "provider-session" && proposal.principal.threadId === threadId,
  );
}

export interface AgentControlThreadActivity {
  readonly pending: ReadonlyArray<AgentControlProposal>;
  /** Latest first, including running actions and terminal history. */
  readonly activity: ReadonlyArray<AgentControlProposal>;
  readonly managerThreadId: ThreadId | null;
}

/** External clients have no caller thread, so their live requests need an environment surface. */
export function selectAgentControlExternalActivity(
  state: AgentControlQueueState,
): AgentControlThreadActivity {
  const active = selectActiveAgentControlProposals(state).filter(
    (proposal) => proposal.principal.kind === "external-integration",
  );
  return {
    pending: active.filter((proposal) => proposal.status === "pending-user-approval"),
    activity: active
      .filter((proposal) => proposal.status !== "pending-user-approval")
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.proposalId.localeCompare(left.proposalId),
      ),
    managerThreadId: null,
  };
}

/** Thread presentation only; never grants authority or changes server policy. */
export function selectAgentControlThreadActivity(
  state: AgentControlQueueState,
  threadId: ThreadId | null,
): AgentControlThreadActivity {
  if (threadId === null) return { pending: [], activity: [], managerThreadId: null };
  const proposals = Object.values(state.proposalsById).toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.proposalId.localeCompare(left.proposalId),
  );
  const local = proposals.filter(
    (proposal) =>
      proposal.principal.kind === "provider-session" && proposal.principal.threadId === threadId,
  );
  // Infer the last known manager only from accepted thread-management work.
  // Device/project operations and unaccepted requests do not establish a manager.
  // Child-return progress updates updatedAt long after the management action.
  // Order accepted work by its stable decision time, not that independent lifecycle.
  const manager = proposals
    .filter((proposal) => {
      if (
        proposal.principal.kind !== "provider-session" ||
        proposal.principal.threadId === threadId ||
        !["approved", "executing", "completed"].includes(proposal.status)
      )
        return false;
      switch (proposal.plan.kind) {
        case "createThreads":
          return (
            proposal.completionReturns?.some((result) => result.childThreadId === threadId) ||
            (proposal.result?.outcome === "completed" &&
              proposal.result.createdThreadIds?.includes(threadId)) ||
            proposal.result?.execution?.affectedThreadIds.includes(threadId)
          );
        case "sendMessage":
        case "interruptThread":
        case "updateThread":
          return proposal.plan.threadId === threadId;
        default:
          return false;
      }
    })
    .toSorted(
      (left, right) =>
        (right.decidedAt ?? right.createdAt).localeCompare(left.decidedAt ?? left.createdAt) ||
        right.proposalId.localeCompare(left.proposalId),
    )[0];
  return {
    pending: local.filter((proposal) => proposal.status === "pending-user-approval").toReversed(),
    activity: local.filter((proposal) => proposal.status !== "pending-user-approval"),
    managerThreadId:
      manager?.principal.kind === "provider-session" ? manager.principal.threadId : null,
  };
}
