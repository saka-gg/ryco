import type { ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { RuntimeSessionId } from "@ryco/contracts/base-schemas";
import type { OrchestrationMessageBackgroundTaskInput } from "@ryco/contracts/orchestration";

import { isActiveSubagentStatus, type RuntimeSubagent } from "./subagentRuntime.ts";
import type { SubagentStopIdentity } from "./subagentStop.ts";

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
 * The identity to message `agent` with, or null when it can't take one: it must be an active
 * direct subagent its provider flagged as able to read messages, reported by the thread's
 * current runtime. The node re-checks all of it.
 */
export function subagentMessageIdentity(
  agent: RuntimeSubagent,
  currentRuntimeSessionId: string | null,
): SubagentMessageIdentity | null {
  if (
    agent.kind !== "subagent" ||
    !isActiveSubagentStatus(agent.status) ||
    !agent.canMessage ||
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

/** What a rejected message says: the node's classified reasons get agent copy. */
export function describeSubagentMessageFailure(cause: unknown): string {
  const failure = cause as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  } | null;
  if (failure?._tag === "OrchestrationMessageBackgroundTaskError") {
    switch (failure.reason) {
      case "unsupported":
        return "This agent can't take messages.";
      case "session-not-found":
        return "This agent's session has ended.";
      case "task-ended":
        return "This agent already finished, so it can't read your message.";
      case "message-failed":
        return "Your message could not be sent. Try again.";
    }
  }
  return typeof failure?.message === "string" && failure.message.trim().length > 0
    ? failure.message
    : "Could not send your message.";
}
