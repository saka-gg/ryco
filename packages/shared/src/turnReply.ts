/**
 * turnReply - Which assistant message a turn is keyed on.
 *
 * Tools that show a stored attachment in the agent's own thread
 * (`ryco_attach_file`, `ryco_html_render`) publish it as an assistant message
 * of its own with blank text. Such a carrier is never the turn's reply while
 * the turn has any other assistant message: the turn's checkpoint summary
 * (changed-files card), a delegated task's result and a fork's boundary key on
 * the reply, and fall back to the carrier only when the turn has nothing else.
 *
 * @module turnReply
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

export interface TurnMessageCandidate extends TurnReplyCandidate {
  readonly role: string;
  readonly turnId?: TurnId | null | undefined;
}

/**
 * Whether a message of a turn that comes after the turn's reply means the
 * turn went on past that reply (a steer, another prompt of the turn). System
 * notices and assistant attachment-only carriers never do: a page or file the
 * agent published around its reply does not replace it.
 */
export const continuesTurnAfterReply = (message: TurnMessageCandidate): boolean =>
  message.role !== "system" && !(message.role === "assistant" && isAttachmentOnlyMessage(message));

/**
 * The reply each turn ended on, by turn: the turn's reply
 * (`selectTurnReplyMessage`) unless a later message of the turn continued it
 * (`continuesTurnAfterReply`). This is the one message a turn can be forked
 * from. One backwards pass; `messages` are in creation order.
 */
export const selectFinalTurnReplies = <M extends TurnMessageCandidate>(
  messages: ReadonlyArray<M>,
): ReadonlyMap<TurnId, M> => {
  const replies = new Map<TurnId, M>();
  // Turns whose reply (a non-carrier assistant message) was reached, final or not.
  const decided = new Set<TurnId>();
  // Turns with a continuing message after the current scan position.
  const continued = new Set<TurnId>();
  // Each turn's latest carrier, or null when the turn continued after it.
  const carriers = new Map<TurnId, M | null>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const turnId = message.turnId;
    if (!turnId || decided.has(turnId)) continue;
    if (message.role === "assistant" && !isAttachmentOnlyMessage(message)) {
      decided.add(turnId);
      if (!continued.has(turnId)) replies.set(turnId, message);
    } else if (message.role === "assistant") {
      if (!carriers.has(turnId)) carriers.set(turnId, continued.has(turnId) ? null : message);
    } else if (continuesTurnAfterReply(message)) {
      continued.add(turnId);
    }
  }
  // A turn that only published attachments ends on its latest carrier.
  for (const [turnId, carrier] of carriers) {
    if (carrier !== null && !decided.has(turnId)) replies.set(turnId, carrier);
  }
  return replies;
};
