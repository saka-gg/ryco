import type { AgentControlProposal, AgentControlProposalId } from "@ryco/contracts";
import { Effect, Option } from "effect";
import {
  completionReturnSummary,
  type CompletionReturnRepository,
} from "../persistence/Layers/AgentControlCompletionReturns.ts";
import type { AgentControlProposalRepositoryShape } from "../persistence/Services/AgentControlProposals.ts";
import type { AgentControlProposalEventsShape } from "./Services/AgentControlProposalEvents.ts";

export interface CompletionReturnPublishDeps {
  readonly repository: Pick<typeof CompletionReturnRepository.Service, "listForProposal">;
  readonly proposals: Pick<AgentControlProposalRepositoryShape, "getById">;
  readonly events: Pick<AgentControlProposalEventsShape, "publish">;
}

/**
 * Republish the delegation proposal with its current completion-return summaries, so the
 * proposal card shows every ledger transition. Shared by the delivery worker and the
 * delegated-task tools.
 */
export const publishCompletionReturns = (
  deps: CompletionReturnPublishDeps,
  proposalId: AgentControlProposalId,
) =>
  Effect.gen(function* () {
    const proposal = yield* deps.proposals.getById({ proposalId });
    if (Option.isNone(proposal)) return;
    const completionReturns = (yield* deps.repository.listForProposal(proposalId)).map(
      completionReturnSummary,
    );
    yield* deps.events.publish({
      ...proposal.value,
      updatedAt: completionReturns.reduce(
        (latest, result) => (result.updatedAt > latest ? result.updatedAt : latest),
        proposal.value.updatedAt,
      ),
      completionReturns,
    } satisfies AgentControlProposal);
  });
