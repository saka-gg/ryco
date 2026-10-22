// FILE: agentControlCopyExecutor.ts
// Purpose: The Agent Control client executor for `copyProjectToNode`
//          proposals: decides whether this client can run a proposal's copy
//          against its target, and approving accepts with `executeOnClient`
//          and runs the copy through `copyRuntime/copyManager` (which reports
//          `started` / `completed` / `failed` to the proposal's node).
// Layer: Web, loaded on demand by `agent-control/agentControlClientExecutor`
//        (`useAgentControlClientExecutor`) the first time a card asks whether
//        it can approve a client-executed proposal; never in the app shell's
//        static graph. Stub until the executor work replaces it: it can execute
//        nothing, so every such card keeps "Approve in Ryco on a computer
//        connected to <target>".

import type { AgentControlClientExecutor } from "../agent-control/agentControlClientExecutor";

/**
 * The app's executor, as `useAgentControlClientExecutor` reads it: it re-reads
 * `getExecutor()` whenever `subscribe` fires, so an executor whose answers
 * change (a node connected, the tier changed) hands out a new object then and
 * the cards re-render.
 */
export interface AgentControlCopyExecutorSource {
  readonly getExecutor: () => AgentControlClientExecutor;
  readonly subscribe: (listener: () => void) => () => void;
}

const UNAVAILABLE_EXECUTOR: AgentControlClientExecutor = {
  canExecute: () => false,
  approve: () => Promise.reject(new Error("Approving this request here is not available yet.")),
};

/** Called once, the first time the executor is needed; lives for the app's lifetime. */
export function startAgentControlCopyExecutor(): AgentControlCopyExecutorSource {
  return {
    getExecutor: () => UNAVAILABLE_EXECUTOR,
    subscribe: () => () => undefined,
  };
}
