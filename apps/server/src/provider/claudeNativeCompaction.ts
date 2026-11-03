import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { NATIVE_COMPACTION_COMMAND } from "@ryco/shared/threadActivity";

// Claude Code lists its slash commands by name, without the slash.
const CLAUDE_NATIVE_COMPACTION_COMMAND_NAME = NATIVE_COMPACTION_COMMAND.slice(1);

/** Whether a system/init frame lists the native compaction command among its slash commands. */
export function claudeInitAdvertisesNativeCompaction(initMessage: SDKMessage): boolean {
  const commands = Reflect.get(initMessage, "slash_commands");
  return Array.isArray(commands) && commands.includes(CLAUDE_NATIVE_COMPACTION_COMMAND_NAME);
}
