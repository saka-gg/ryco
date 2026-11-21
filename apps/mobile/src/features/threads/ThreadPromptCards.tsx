import type { PendingApproval, PendingUserInput } from "@ryco/client-runtime/state/session";
import { resolveOptionalAnswerRoute } from "@ryco/client-runtime/state/user-input";
import type { AgentControlProposalView } from "@ryco/contracts";
import type { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { ScrollView } from "react-native";

import { AgentControlProposalCard } from "./AgentControlProposalCard";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { SecretRequestCard } from "./SecretRequestCard";
import type { MobileSecretRequestCards } from "./secretRequestCardModel";
import { UserActionRequestCard } from "./UserActionRequestCard";
import type { MobileUserActionRequestCards } from "./userActionRequestCardModel";

/**
 * What waits on the reader, over the composer: approvals and questions (the live ones, and the
 * ones a background alert described until the live detail loads), secret requests, user action
 * requests (a tab or terminal handed to the user) and Agent Control proposals. The screen decides
 * whether any show.
 */
export function ThreadPromptCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly alertApprovals: ReadonlyArray<PendingApproval>;
  readonly alertUserInputs: ReadonlyArray<PendingUserInput>;
  /** The alert left questions or options out: its cards show, answers wait. */
  readonly alertPartial: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly optionalUserInputs: ReadonlyArray<PendingUserInput>;
  /** The thread's session, for how an optional question's answer reaches the agent. */
  readonly session: Parameters<typeof resolveOptionalAnswerRoute>[0]["session"];
  readonly onSendAsMessage: (
    userInput: PendingUserInput,
    answers: Record<string, string | string[]>,
  ) => Promise<void>;
  /** Cards from a saved body or a cached thread are shown, not answered. */
  readonly promptsDisabled: boolean;
  readonly secretRequests: MobileSecretRequestCards;
  readonly userActionRequests: MobileUserActionRequestCards;
  /** Opens one of the thread's terminals (a terminal hand-off's Show). */
  readonly onShowTerminal?: ((terminalId: string) => void) | undefined;
  readonly agentControlProposals: ReadonlyArray<AgentControlProposalView>;
  readonly agentControlDisabled: boolean;
}) {
  const { environmentId, threadId, promptsDisabled } = props;
  return (
    <ScrollView
      className="grow-0"
      style={{ maxHeight: "42%" }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingVertical: 4 }}
    >
      {props.pendingApprovals.map((approval) => (
        <PendingApprovalCard
          key={approval.requestId}
          environmentId={environmentId}
          threadId={threadId}
          approval={approval}
          disabled={promptsDisabled}
        />
      ))}
      {props.alertApprovals.map((approval) => (
        <PendingApprovalCard
          key={`alert:${approval.requestId}`}
          environmentId={environmentId}
          threadId={threadId}
          approval={approval}
          fromAlert
        />
      ))}
      {props.alertUserInputs.map((userInput) => (
        <PendingUserInputCard
          key={`alert:${userInput.requestId}`}
          environmentId={environmentId}
          threadId={threadId}
          userInput={userInput}
          fromAlert={{ partial: props.alertPartial }}
        />
      ))}
      {[...props.pendingUserInputs, ...props.optionalUserInputs].map((userInput) => (
        <PendingUserInputCard
          key={userInput.userInputIdentity?.requestEventId ?? userInput.requestId}
          environmentId={environmentId}
          threadId={threadId}
          userInput={userInput}
          route={resolveOptionalAnswerRoute({ userInput, session: props.session })}
          onSendAsMessage={props.onSendAsMessage}
          disabled={promptsDisabled}
        />
      ))}
      {props.secretRequests.requests.map((request) => (
        <SecretRequestCard
          key={request.requestId}
          environmentId={environmentId}
          threadId={threadId}
          request={request}
          disabledReason={props.secretRequests.access.reason}
        />
      ))}
      {props.userActionRequests.requests.map((request) => (
        <UserActionRequestCard
          key={request.requestId}
          environmentId={environmentId}
          threadId={threadId}
          request={request}
          disabledReason={props.userActionRequests.access.reason}
          hint={props.userActionRequests.hints.get(request.requestId)}
          onShow={
            request.surface === "terminal" &&
            request.target !== null &&
            props.onShowTerminal !== undefined
              ? () => props.onShowTerminal?.(request.target ?? "")
              : undefined
          }
        />
      ))}
      {props.agentControlProposals.map((proposal) => (
        <AgentControlProposalCard
          key={proposal.proposalId}
          environmentId={environmentId}
          proposal={proposal}
          disabled={props.agentControlDisabled}
        />
      ))}
    </ScrollView>
  );
}
