/**
 * Principal-agnostic control-request (proposal) reads shared by the private
 * session catalog and the standalone external catalog. A proposal the
 * caller did not create reads as not found, so absence and authorization
 * failure stay indistinguishable.
 *
 * @module agentControl/Mcp/proposalReads
 */
import {
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_DEFAULT,
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
  AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES,
  AgentControlMcpControlRequestResult,
  type AgentControlProposal,
  type AgentControlProposalStatus,
} from "@ryco/contracts";
import { Duration, Effect, Option, Schema, Stream } from "effect";

import type { AgentControlProposalEventsShape } from "../Services/AgentControlProposalEvents.ts";
import {
  toAgentControlProposalReceipt,
  type AgentControlProposalServiceShape,
} from "../Services/AgentControlProposalService.ts";
import { ToolFailure, clampLimit, failTool } from "./threadReads.ts";

export type ProposalVisibility = (proposal: AgentControlProposal) => boolean;

export const proposalWaitConditionMet = (
  status: AgentControlProposalStatus,
  waitFor: "decided" | "terminal",
): boolean =>
  waitFor === "terminal"
    ? AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES.includes(status)
    : status !== "pending-user-approval";

export const readVisibleProposal = (
  proposals: Pick<AgentControlProposalServiceShape, "getProposal">,
  proposalId: AgentControlProposal["proposalId"],
  visible: ProposalVisibility,
) =>
  proposals.getProposal(proposalId).pipe(
    Effect.mapError((error) =>
      error._tag === "AgentControlDisabledError"
        ? new ToolFailure("Agent Control is disabled.")
        : new ToolFailure("Control request read failed."),
    ),
    Effect.flatMap((proposal) =>
      Option.isSome(proposal) && visible(proposal.value)
        ? Effect.succeed(proposal.value)
        : failTool("Control request not found."),
    ),
  );

export const readControlRequestReceipt = (
  proposals: Pick<AgentControlProposalServiceShape, "getProposal">,
  proposalId: AgentControlProposal["proposalId"],
  visible: ProposalVisibility,
) =>
  readVisibleProposal(proposals, proposalId, visible).pipe(
    Effect.map((proposal) =>
      Schema.encodeSync(AgentControlMcpControlRequestResult)({
        receipt: toAgentControlProposalReceipt(proposal),
      }),
    ),
  );

export const waitForControlRequestReceipt = (input: {
  readonly proposals: Pick<AgentControlProposalServiceShape, "getProposal">;
  readonly proposalEvents: Pick<AgentControlProposalEventsShape, "subscribe">;
  readonly proposalId: AgentControlProposal["proposalId"];
  readonly waitFor: "decided" | "terminal" | undefined;
  readonly timeoutMs: number | undefined;
  readonly visible: ProposalVisibility;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const waitFor = input.waitFor ?? "decided";
      const timeoutMs = clampLimit(
        input.timeoutMs,
        AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_DEFAULT,
        AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
      );
      // Subscribe before the initial read so no transition between the
      // read and the stream start can be missed.
      const subscription = yield* input.proposalEvents.subscribe;
      const current = yield* readVisibleProposal(input.proposals, input.proposalId, input.visible);
      if (proposalWaitConditionMet(current.status, waitFor)) {
        return Schema.encodeSync(AgentControlMcpControlRequestResult)({
          receipt: toAgentControlProposalReceipt(current),
          timedOut: false,
        });
      }

      const matched = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (event) =>
            event.proposal.proposalId === input.proposalId &&
            input.visible(event.proposal) &&
            proposalWaitConditionMet(event.proposal.status, waitFor),
        ),
        Stream.runHead,
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.map(Option.flatten),
      );

      if (Option.isSome(matched)) {
        return Schema.encodeSync(AgentControlMcpControlRequestResult)({
          receipt: toAgentControlProposalReceipt(matched.value.proposal),
          timedOut: false,
        });
      }

      // Timed out (or the feed shut down): return the freshest state —
      // the read sweeps expiry first, so an overdue proposal converges.
      const latest = yield* readVisibleProposal(input.proposals, input.proposalId, input.visible);
      return Schema.encodeSync(AgentControlMcpControlRequestResult)({
        receipt: toAgentControlProposalReceipt(latest),
        timedOut: !proposalWaitConditionMet(latest.status, waitFor),
      });
    }),
  );
