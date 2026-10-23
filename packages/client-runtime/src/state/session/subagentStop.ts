import { isActiveSubagentStatus, type RuntimeSubagent } from "./subagentRuntime.ts";

/**
 * Which native subagents a client may stop on their own, and with what
 * identity. Kept out of the state/session barrel: the subagent fold sits on
 * the web app's boot graph, and only lazily loaded Stop controls need this.
 */

/** The exact task a stop targets; the node refuses it once the runtime or attempt moved on. */
export interface SubagentStopIdentity {
  readonly taskId: string;
  readonly runtimeSessionId: string;
  readonly attempt: number;
}

/** What a surface needs to offer Stop on agent rows; the app owns gating and the request. */
export interface SubagentStopAction {
  /** The thread's current provider runtime: agents an earlier runtime reported can't be stopped. */
  readonly runtimeSessionId: string | null;
  /** Why Stop is shown but can't be used right now, or null when it can. */
  readonly unavailableReason: string | null;
  /**
   * Resolves once the node accepted the stop. The row settles when the
   * provider reports the task stopped, never through a turn interrupt.
   */
  readonly stop: (identity: SubagentStopIdentity) => Promise<void>;
}

/**
 * The identity to stop `agent` with, or null when it can't be stopped on its
 * own. Only direct subagents qualify: stopping a workflow coordinator ends its
 * whole run, and workflow members are slots synthesized from workflow
 * progress, not provider tasks (their attempt is the workflow's retry count).
 * Older nodes flag those members stoppable, so this kind check is the guard.
 * The agent must also be active, flagged stoppable by its provider and
 * reported by the thread's current runtime; the node re-checks all of it.
 * Claude never stamps an attempt on agent tasks and expects 0 for them.
 */
export function subagentStopIdentity(
  agent: RuntimeSubagent,
  currentRuntimeSessionId: string | null,
): SubagentStopIdentity | null {
  if (
    agent.kind !== "subagent" ||
    !isActiveSubagentStatus(agent.status) ||
    !agent.canStop ||
    agent.runtimeSessionId === null ||
    agent.runtimeSessionId !== currentRuntimeSessionId
  ) {
    return null;
  }
  return {
    taskId: agent.id,
    runtimeSessionId: agent.runtimeSessionId,
    attempt: agent.attempt ?? 0,
  };
}
