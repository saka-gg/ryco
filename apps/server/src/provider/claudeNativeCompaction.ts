import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_NATIVE_COMPACTION_COMMAND_NAME = "compact";

/** Claude Code's own command that compacts the conversation. */
export const CLAUDE_NATIVE_COMPACTION_COMMAND = `/${CLAUDE_NATIVE_COMPACTION_COMMAND_NAME}`;

/** Only an attachment-free exact native command bypasses prompt decoration. */
export function isClaudeNativeCompaction(input: {
  readonly input?: string | undefined;
  readonly attachments?: readonly unknown[] | undefined;
}): boolean {
  return (
    input.input?.trim() === CLAUDE_NATIVE_COMPACTION_COMMAND &&
    (input.attachments?.length ?? 0) === 0
  );
}

/** Whether a system/init frame lists the native compaction command among its slash commands. */
export function claudeInitAdvertisesNativeCompaction(initMessage: SDKMessage): boolean {
  const commands = Reflect.get(initMessage, "slash_commands");
  return Array.isArray(commands) && commands.includes(CLAUDE_NATIVE_COMPACTION_COMMAND_NAME);
}
