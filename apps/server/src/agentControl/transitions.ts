import type { AgentControlOperationStatus, AgentControlProposalStatus } from "@ryco/contracts";

/**
 * Who is performing a state transition.
 *
 * - `user`: a human decision through the approval surfaces.
 * - `executor`: the (future) approved-plan executor — the only actor that
 *   may move an accepted proposal into `executing` and the only consumer of
 *   accepted proposals.
 * - `system`: server lifecycle (expiry sweeps, shutdown compensation).
 * - `standing-approval`: the automation scheduler approving a scheduled run of a
 *   schedule its owner set to run without asking (the owner's decision, made when
 *   they approved the schedule). It may only approve; nothing else uses it.
 */
export type AgentControlTransitionActor = "user" | "executor" | "system" | "standing-approval";

type TransitionTable<Status extends string> = Record<
  Status,
  Partial<Record<Status, ReadonlyArray<AgentControlTransitionActor>>>
>;

/**
 * Legal proposal transitions with the actors permitted to perform them.
 * Anything absent here is illegal — terminal states have no exits, plans
 * are never edited in place, and nothing ever re-enters
 * `pending-user-approval`.
 */
const PROPOSAL_TRANSITIONS: TransitionTable<AgentControlProposalStatus> = {
  "pending-user-approval": {
    approved: ["user", "standing-approval"],
    rejected: ["user"],
    cancelled: ["user", "system"],
    expired: ["system"],
  },
  approved: {
    executing: ["executor"],
    cancelled: ["user", "system"],
    expired: ["system"],
  },
  executing: {
    completed: ["executor"],
    failed: ["executor"],
    cancelled: ["executor"],
  },
  rejected: {},
  expired: {},
  completed: {},
  failed: {},
  cancelled: {},
};

/**
 * Legal operation transitions. Operations exist only downstream of an
 * executing proposal, so nearly every transition belongs to the executor;
 * `system` may only abandon a never-started operation.
 */
const OPERATION_TRANSITIONS: TransitionTable<AgentControlOperationStatus> = {
  pending: {
    running: ["executor"],
    cancelled: ["executor", "system"],
  },
  running: {
    completed: ["executor"],
    failed: ["executor"],
    compensating: ["executor"],
    cancelled: ["executor"],
  },
  compensating: {
    completed: ["executor"],
    failed: ["executor"],
  },
  completed: {},
  failed: {},
  cancelled: {},
};

function transitionIssue<Status extends string>(
  table: TransitionTable<Status>,
  input: {
    readonly from: Status;
    readonly to: Status;
    readonly actor: AgentControlTransitionActor;
  },
): string | null {
  const allowedActors = table[input.from][input.to];
  if (allowedActors === undefined) {
    return `no legal transition from ${input.from} to ${input.to}`;
  }
  if (!allowedActors.includes(input.actor)) {
    return `actor ${input.actor} may not transition ${input.from} to ${input.to}`;
  }
  return null;
}

/** `null` when legal; otherwise a human-readable refusal reason. */
export function proposalTransitionIssue(input: {
  readonly from: AgentControlProposalStatus;
  readonly to: AgentControlProposalStatus;
  readonly actor: AgentControlTransitionActor;
}): string | null {
  return transitionIssue(PROPOSAL_TRANSITIONS, input);
}

/** `null` when legal; otherwise a human-readable refusal reason. */
export function operationTransitionIssue(input: {
  readonly from: AgentControlOperationStatus;
  readonly to: AgentControlOperationStatus;
  readonly actor: AgentControlTransitionActor;
}): string | null {
  return transitionIssue(OPERATION_TRANSITIONS, input);
}
