/**
 * turnReplyMessage - Which assistant message a turn is keyed on.
 *
 * Tools that show a stored attachment in the agent's own thread
 * (`ryco_attach_file`, `ryco_html_render`) publish it as an assistant message
 * of its own with blank text. Such a carrier is never the turn's reply while
 * the turn has any other assistant message: the turn's checkpoint summary
 * (changed-files card) and a delegated task's result key on the reply, and
 * fall back to the carrier only when the turn has nothing else.
 *
 * @module turnReplyMessage
 */
import type { TurnId } from "@ryco/contracts";

export interface TurnReplyCandidate {
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly streaming: boolean;
}

/** A finished assistant message that only carries attachments: blank text and at least one attachment. */
export const isAttachmentOnlyMessage = (message: TurnReplyCandidate): boolean =>
  !message.streaming && message.text.trim().length === 0 && (message.attachments?.length ?? 0) > 0;

/**
 * The latest assistant message of `turnId` that is not an attachment-only
 * carrier, else the latest carrier. `messages` are in creation order.
 */
export const selectTurnReplyMessage = <
  M extends TurnReplyCandidate & { readonly role: string; readonly turnId: TurnId | null },
>(
  messages: ReadonlyArray<M>,
  turnId: TurnId,
): M | undefined => {
  let carrier: M | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.turnId !== turnId) continue;
    if (!isAttachmentOnlyMessage(message)) return message;
    carrier ??= message;
  }
  return carrier;
};
