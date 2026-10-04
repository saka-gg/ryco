/**
 * One builder for server-initiated "continue this thread" turn starts: usage-limit
 * auto-resume today, delegated returns and restart continuation next. The turn runs
 * with the thread's own model and modes, never a client's staged composer state.
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
  thread: Pick<
    OrchestrationThreadShell,
    "id" | "modelSelection" | "runtimeMode" | "interactionMode" | "tokenMode"
  >,
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
    modelSelection: thread.modelSelection,
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
