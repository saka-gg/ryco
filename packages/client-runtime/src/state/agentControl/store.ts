import type { AgentControlProposalStreamEventView, EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

import {
  EMPTY_AGENT_CONTROL_QUEUE_STATE,
  applyAgentControlStreamEvent,
  type AgentControlQueueState,
} from "./logic.ts";

export interface AgentControlStoreState {
  readonly queueByEnvironmentId: Readonly<Record<string, AgentControlQueueState>>;
  readonly applyStreamEvent: (
    environmentId: EnvironmentId,
    event: AgentControlProposalStreamEventView,
  ) => void;
  readonly clearEnvironment: (environmentId: EnvironmentId) => void;
}

/**
 * Shared Agent Control proposal-queue store, keyed by environment. Web,
 * desktop, and mobile all render from this one store; the only writer is
 * the per-environment subscription started by `startAgentControlProposalSync`.
 */
export const useAgentControlStore = create<AgentControlStoreState>((set) => ({
  queueByEnvironmentId: {},
  applyStreamEvent: (environmentId, event) =>
    set((state) => {
      const current = state.queueByEnvironmentId[environmentId] ?? EMPTY_AGENT_CONTROL_QUEUE_STATE;
      const next = applyAgentControlStreamEvent(current, event);
      if (next === current) {
        return state;
      }
      return {
        queueByEnvironmentId: { ...state.queueByEnvironmentId, [environmentId]: next },
      };
    }),
  clearEnvironment: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.queueByEnvironmentId)) {
        return state;
      }
      const next = { ...state.queueByEnvironmentId };
      delete next[environmentId];
      return { queueByEnvironmentId: next };
    }),
}));

export function selectAgentControlQueueState(
  state: Pick<AgentControlStoreState, "queueByEnvironmentId">,
  environmentId: EnvironmentId,
): AgentControlQueueState {
  return state.queueByEnvironmentId[environmentId] ?? EMPTY_AGENT_CONTROL_QUEUE_STATE;
}
