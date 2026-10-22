import { createContext, useContext } from "react";
import type { AgentControlProposalView, EnvironmentId } from "@ryco/contracts";
import type { AgentControlClientExecutionCheck } from "@ryco/client-runtime/state/agentControl";

/**
 * Runs client-executed Agent Control proposals (`copyProjectToNode`) from this
 * client: it accepts with `executeOnClient` and then runs the copy against the
 * target. Without one (the default, mobile-like) every such card shows "Approve
 * in Ryco on a computer connected to <target>" in place of Approve.
 */
export interface AgentControlClientExecutor {
  /** Whether this client can run a client-executed plan against `target` now. */
  readonly canExecute: AgentControlClientExecutionCheck;
  /**
   * Approves the proposal and runs it here. Rejects with an `Error` whose
   * message the card shows.
   */
  readonly approve: (input: {
    readonly environmentId: EnvironmentId;
    readonly proposal: AgentControlProposalView;
  }) => Promise<void>;
}

export const AgentControlClientExecutorContext = createContext<AgentControlClientExecutor | null>(
  null,
);

export function useAgentControlClientExecutor(): AgentControlClientExecutor | null {
  return useContext(AgentControlClientExecutorContext);
}
