/**
 * One builder for server-initiated "continue this thread" turn starts: usage-limit
 * auto-resume, goal continuations and restart continuation. The turn runs with the
 * thread's own modes, never a client's staged composer state. It names no model: a
 * client stores a pick on the thread when it is made, and the provider reactor applies
 * the chat's stored pick to a turn that names none only where the session can take it
 * (`implicitTurnModelSelection`), so an unattended turn never fails on a session that
 * cannot switch models nor ends background work a model restart would end.
 *
 * @module threadContinuation
 */
import type {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  OrchestrationThreadShell,
  RestartContinuationGuard,
  ThreadTurnStartCommand,
} from "@ryco/contracts";

export type ClientThreadTurnStartCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: "thread.turn.start" }
>;

export function buildThreadContinuationTurnStart(
  thread: Pick<OrchestrationThreadShell, "id" | "runtimeMode" | "interactionMode" | "tokenMode">,
  input: {
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly createdAt: string;
    readonly guards?: Partial<
      Pick<ClientThreadTurnStartCommand, "usageLimitResumeGuard" | "delegationReturnGuard">
    >;
  },
): ClientThreadTurnStartCommand {
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: thread.id,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.text,
      attachments: [],
    },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    ...(thread.tokenMode !== undefined ? { tokenMode: thread.tokenMode } : {}),
    ...(input.guards?.usageLimitResumeGuard
      ? { usageLimitResumeGuard: input.guards.usageLimitResumeGuard }
      : {}),
    ...(input.guards?.delegationReturnGuard
      ? { delegationReturnGuard: input.guards.delegationReturnGuard }
      : {}),
    createdAt: input.createdAt,
  };
}

/**
 * The automatic continuation after a server restart. Its guard is server-only, so it is
 * an internal command dispatched straight to the engine, never through client command
 * application.
 */
export function buildRestartContinuationTurnStart(
  thread: Parameters<typeof buildThreadContinuationTurnStart>[0],
  input: {
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly createdAt: string;
    readonly guard: RestartContinuationGuard;
  },
): typeof ThreadTurnStartCommand.Type {
  const command = buildThreadContinuationTurnStart(thread, input);
  return {
    ...command,
    message: { ...command.message, attachments: [] },
    restartContinuationGuard: input.guard,
  };
}
