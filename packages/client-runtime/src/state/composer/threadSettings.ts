import type { CommandId, ThreadId } from "@ryco/contracts";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  type AgentTokenMode,
  type ClientOrchestrationCommand,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@ryco/contracts/orchestration";

/** The modes a turn runs in: the node takes them from the thread, not from the turn start. */
export interface ThreadTurnModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode?: AgentTokenMode | undefined;
}

export interface ThreadSettingsForNextTurnInput {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode: AgentTokenMode;
}

export type ThreadSettingsCommandKind = "runtime-mode" | "interaction-mode" | "token-mode";

/**
 * The mode writes that make the thread run its next turn in the chosen modes: only those that
 * differ from `current`, or all three when the thread's modes are not known to this client (a
 * thread the node created, such as the one `git.createWorktreeForProject` makes, in its own
 * defaults).
 */
export function threadSettingsForNextTurnCommands(
  current: ThreadTurnModes | null,
  input: ThreadSettingsForNextTurnInput,
  commandId: (kind: ThreadSettingsCommandKind) => CommandId,
): ClientOrchestrationCommand[] {
  const commands: ClientOrchestrationCommand[] = [];
  if (current === null || input.runtimeMode !== current.runtimeMode) {
    commands.push({
      type: "thread.runtime-mode.set",
      commandId: commandId("runtime-mode"),
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      createdAt: input.createdAt,
    });
  }
  if (current === null || input.interactionMode !== current.interactionMode) {
    commands.push({
      type: "thread.interaction-mode.set",
      commandId: commandId("interaction-mode"),
      threadId: input.threadId,
      interactionMode: input.interactionMode,
      createdAt: input.createdAt,
    });
  }
  if (current === null || input.tokenMode !== (current.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE)) {
    commands.push({
      type: "thread.token-mode.set",
      commandId: commandId("token-mode"),
      threadId: input.threadId,
      tokenMode: input.tokenMode,
      createdAt: input.createdAt,
    });
  }
  return commands;
}

/** Sends `threadSettingsForNextTurnCommands` in order; the turn start goes after it. */
export async function persistThreadSettingsForNextTurn(
  dispatch: (command: ClientOrchestrationCommand) => Promise<unknown>,
  current: ThreadTurnModes | null,
  input: ThreadSettingsForNextTurnInput,
  commandId: (kind: ThreadSettingsCommandKind) => CommandId,
): Promise<void> {
  for (const command of threadSettingsForNextTurnCommands(current, input, commandId)) {
    await dispatch(command);
  }
}
