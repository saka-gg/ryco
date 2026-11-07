/**
 * attachmentInstructionDelivery - How Ryco's assistant-attachment instructions
 * reach a provider.
 *
 * The instructions describe a session-wide capability, so they belong in the
 * session's system or developer instructions (Claude `systemPrompt.append`,
 * Codex collaboration-mode developer instructions). Adapters without such a
 * channel get them once, prefixed to the first turn of each runtime session, with
 * the device routing rules when that session has Ryco's device tools.
 * A native command (`/compact`, `/init`, custom commands) is never prefixed:
 * provider CLIs only treat input that starts with `/` as a command.
 *
 * @module attachmentInstructionDelivery
 */
import { ASSISTANT_ATTACHMENT_INSTRUCTIONS } from "../assistantAttachments.ts";
import { DEVICE_ROUTING_INSTRUCTIONS } from "../providerTools/deviceToolRouting.ts";

/** Input a provider CLI parses as a native slash command; it must reach the provider verbatim. */
export function isSlashCommandInput(input: string | undefined): boolean {
  return input?.trimStart().startsWith("/") ?? false;
}

/**
 * The first-turn input carrying the attachment instructions (and, while the session has
 * Ryco's device tools, the device routing rules) ahead of the user's text.
 */
export function withAttachmentInstructions(
  input: string | undefined,
  options: { readonly deviceTools?: boolean } = {},
): string {
  const instructions = options.deviceTools
    ? `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\n${DEVICE_ROUTING_INSTRUCTIONS}`
    : ASSISTANT_ATTACHMENT_INSTRUCTIONS;
  const text = input ?? "";
  return text.length > 0 ? `${instructions}\n\n${text}` : instructions;
}

const MAX_TRACKED_THREADS = 4_096;

/**
 * Remembers, per thread, the runtime session whose conversation already holds
 * the first-turn instructions. A new runtime, or a rollback that may have
 * dropped the turn carrying them, asks for them again. Bounded: the oldest
 * threads are forgotten first, which at worst repeats the instructions once.
 */
export function makeAttachmentInstructionTracker() {
  const delivered = new Map<string, string>();
  return {
    /** Whether a turn on this runtime still needs the instructions; no runtime id always does. */
    needs: (threadId: string, runtimeSessionId: string | undefined): boolean =>
      runtimeSessionId === undefined || delivered.get(threadId) !== runtimeSessionId,
    markDelivered: (threadId: string, runtimeSessionId: string | undefined): void => {
      if (runtimeSessionId === undefined) return;
      delivered.delete(threadId);
      delivered.set(threadId, runtimeSessionId);
      while (delivered.size > MAX_TRACKED_THREADS) {
        const oldest = delivered.keys().next().value;
        if (oldest === undefined) break;
        delivered.delete(oldest);
      }
    },
    /** The thread's conversation may have lost them (a rollback or compaction): deliver them again. */
    forget: (threadId: string): void => {
      delivered.delete(threadId);
    },
  };
}
