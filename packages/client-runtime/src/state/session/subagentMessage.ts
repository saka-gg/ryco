import type { ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { RuntimeSessionId } from "@ryco/contracts/base-schemas";
import {
  MESSAGE_BACKGROUND_TASK_ERROR_MESSAGES,
  type OrchestrationMessageBackgroundTaskInput,
} from "@ryco/contracts/orchestration";

import type { RuntimeSubagent } from "./subagentRuntime.ts";
import { activeSubagentIdentity, type SubagentStopIdentity } from "./subagentStop.ts";

/**
 * Which running agents a person may send a message, with what identity, and what a failure
 * says. The agent reads the message at its next step; nothing interrupts it. Shared by web's
 * Agents panel and the phone. Kept out of the state/session barrel like `subagentStop`: only
 * lazily loaded agent details need it.
 */

/** The exact task a message targets; the node refuses it once the runtime or attempt moved on. */
export type SubagentMessageIdentity = SubagentStopIdentity;

/** What a surface needs to offer a message box on an agent; the app owns gating and the request. */
export interface SubagentMessageAction {
  readonly threadRef: ScopedThreadRef;
  /** The thread's current provider runtime: agents an earlier runtime reported can't be reached. */
  readonly runtimeSessionId: string | null;
  /** Why the box is shown but can't send right now, or null when it can. */
  readonly unavailableReason: string | null;
  /** Resolves once the node queued the message for the agent's next step. */
  readonly send: (identity: SubagentMessageIdentity, text: string) => Promise<void>;
}

/**
 * The identity to message `agent` with, or null when it can't take one: an active direct subagent
 * its provider flagged as able to read messages, reported by the thread's current runtime. The
 * node re-checks all of it.
 */
export function subagentMessageIdentity(
  agent: RuntimeSubagent,
  currentRuntimeSessionId: string | null,
): SubagentMessageIdentity | null {
  return activeSubagentIdentity(agent, currentRuntimeSessionId, agent.canMessage);
}

export function subagentMessageRequest(
  threadId: ThreadId,
  identity: SubagentMessageIdentity,
  text: string,
): OrchestrationMessageBackgroundTaskInput {
  return {
    threadId,
    taskId: identity.taskId,
    text,
    expected: {
      runtimeSessionId: RuntimeSessionId.make(identity.runtimeSessionId),
      attempt: identity.attempt,
    },
  };
}

/** What a rejected message says: the node's classified reasons, in the contract's own words. */
export function describeSubagentMessageFailure(cause: unknown): string {
  const failure = cause as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  } | null;
  if (
    failure?._tag === "OrchestrationMessageBackgroundTaskError" &&
    typeof failure.reason === "string" &&
    Object.hasOwn(MESSAGE_BACKGROUND_TASK_ERROR_MESSAGES, failure.reason)
  ) {
    return MESSAGE_BACKGROUND_TASK_ERROR_MESSAGES[
      failure.reason as keyof typeof MESSAGE_BACKGROUND_TASK_ERROR_MESSAGES
    ];
  }
  return typeof failure?.message === "string" && failure.message.trim().length > 0
    ? failure.message
    : "Could not send your message.";
}
