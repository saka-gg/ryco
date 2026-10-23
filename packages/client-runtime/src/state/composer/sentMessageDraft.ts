import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@ryco/contracts/orchestration";

import type { ChatAttachment, ChatFileAttachment, ChatImageAttachment } from "../threads/types.ts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./sendEngine.ts";

// What a sent message brings back to the composer when the conversation is
// rewound to before it ("Edit from here"). Platform-neutral: each app turns
// the attachment bytes into its own draft attachments.

/**
 * The prompt to edit and send again: the text as it was sent, so a resend says
 * the same. An "Ultrathink:" prefix stays, since it is what selects ultrathink,
 * and so does attached terminal output, as text. Only the placeholder an
 * attachment-only send stands in with is dropped.
 */
export function composerPromptFromSentMessage(text: string): string {
  const prompt = text.trim();
  return prompt === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT ? "" : prompt;
}

/** Puts a returned prompt below the composer's unsent draft, which stays first. */
export function appendReturnedComposerPrompt(draft: string, returned: string): string {
  if (returned.length === 0) return draft;
  const kept = draft.trimEnd();
  return kept.length === 0 ? returned : `${kept}\n\n${returned}`;
}

export type ReturnableSentAttachment = ChatImageAttachment | ChatFileAttachment;

/** The sent message's attachments a composer can hold again (images and files). */
export function returnableSentAttachments(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): ReadonlyArray<ReturnableSentAttachment> {
  return (attachments ?? []).filter(
    (attachment): attachment is ReturnableSentAttachment =>
      attachment.type === "image" || attachment.type === "file",
  );
}

/**
 * Why the composer has no room for the returned attachments next to what it
 * already holds, or null. Checked before reverting: afterwards the server has
 * deleted the sent copies.
 */
export function returnedAttachmentsOverflow(input: {
  readonly existing: ReadonlyArray<{ readonly sizeBytes: number }>;
  readonly returned: ReadonlyArray<{ readonly sizeBytes: number }>;
}): string | null {
  if (input.returned.length === 0) return null;
  const totalBytes = [...input.existing, ...input.returned].reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0,
  );
  return input.existing.length + input.returned.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
    totalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES
    ? "Remove some attachments from the composer first, so this message's attachments fit."
    : null;
}

export const RETURNED_ATTACHMENTS_UNREADABLE_MESSAGE =
  "Couldn't load this message's attachments, so nothing was reverted.";

/** What one sent message returns to the composer with. */
export interface ReturnedSentMessage<TAttachment> {
  readonly prompt: string;
  readonly attachments: ReadonlyArray<TAttachment>;
}

/**
 * Reads a sent message back for the composer, before the revert that deletes
 * the node's copies is sent: checks the attachments fit next to the composer's
 * (and that this app can attach them), then loads each one, one at a time for
 * bounded memory and load. Throws a message to show when anything fails, and
 * then nothing may be reverted.
 */
export async function loadReturnedSentMessage<TAttachment>(input: {
  readonly message: {
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  };
  /** What the composer holds now. */
  readonly composerAttachments: ReadonlyArray<{ readonly sizeBytes: number }>;
  /** Why this app cannot attach some of them, or null. */
  readonly refuse?:
    | ((attachments: ReadonlyArray<ReturnableSentAttachment>) => string | null)
    | undefined;
  /** Turns one sent attachment into this app's draft attachment. */
  readonly load: (attachment: ReturnableSentAttachment) => Promise<TAttachment>;
}): Promise<ReturnedSentMessage<TAttachment>> {
  const sent = returnableSentAttachments(input.message.attachments);
  const refusal =
    returnedAttachmentsOverflow({ existing: input.composerAttachments, returned: sent }) ??
    (sent.length > 0 ? (input.refuse?.(sent) ?? null) : null);
  if (refusal !== null) throw new Error(refusal);
  const attachments: TAttachment[] = [];
  try {
    for (const attachment of sent) {
      attachments.push(await input.load(attachment));
    }
  } catch {
    throw new Error(RETURNED_ATTACHMENTS_UNREADABLE_MESSAGE);
  }
  return { prompt: composerPromptFromSentMessage(input.message.text), attachments };
}
