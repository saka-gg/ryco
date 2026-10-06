/**
 * The lab's notices for approvals that don't go through: a run whose
 * approval expired first, a change that couldn't be applied. A decision's
 * outcome arrives on the device's Agent Control queue (the approval's own
 * reply only says it was recorded, and an expired one is refused), so each
 * approval is watched there until it settles.
 */
import type { AgentControlProposalId } from "@ryco/contracts";
import { useEffect, useRef } from "react";

import { useEvent } from "../../../hooks/useEvent";
import { toastManager } from "../../ui/toast";
import { approvalOutcome, type ApprovalKind, type DialogQueueInput } from "./dialogModel.logic";

interface WatchedApproval {
  readonly checkoutKey: string;
  readonly kind: ApprovalKind;
}

/** Ends the watches whose approval settled, saying so for those that didn't go through. */
function settleApprovals(
  watched: Map<AgentControlProposalId, WatchedApproval>,
  queues: ReadonlyMap<string, DialogQueueInput>,
): void {
  for (const [proposalId, approval] of watched) {
    const proposal = queues
      .get(approval.checkoutKey)
      ?.queueProposals.find((candidate) => candidate.proposalId === proposalId);
    const outcome = approvalOutcome(proposal, approval.kind);
    if (outcome.kind === "pending") continue;
    watched.delete(proposalId);
    if (outcome.kind === "notice") toastManager.add({ type: outcome.tone, title: outcome.title });
  }
}

/**
 * Returns `watch(checkoutKey, proposalId, kind)`: call it as an approval is
 * sent. Watches end when the approval settles (or the dialog closes).
 */
export function useApprovalNotices(
  queues: ReadonlyMap<string, DialogQueueInput>,
): (checkoutKey: string, proposalId: AgentControlProposalId, kind: ApprovalKind) => void {
  const watchedRef = useRef(new Map<AgentControlProposalId, WatchedApproval>());
  useEffect(() => settleApprovals(watchedRef.current, queues), [queues]);
  return useEvent((checkoutKey: string, proposalId: AgentControlProposalId, kind: ApprovalKind) => {
    watchedRef.current.set(proposalId, { checkoutKey, kind });
    settleApprovals(watchedRef.current, queues);
  });
}
