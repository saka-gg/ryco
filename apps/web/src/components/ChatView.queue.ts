/** What ChatView shows for its thread's held sends and waiting queue. */
import type { HostedRpcCapability } from "@ryco/client-runtime/authorization/capabilities";
import { MessageId } from "@ryco/contracts";

import type { HeldSendView } from "../heldSends";
import { formatOutgoingPrompt } from "../hooks/chatSendShared";
import { buildOutgoingMessageText } from "../hooks/executeChatSendTurn";
import { hostedRoleRefusesSendCopy, hostedSendsWhenReadyCopy } from "../hostedHub/switchTarget";
import type { ChatMessage } from "../types";
import type { QueuedMessagesWait } from "./chat/ComposerQueuedMessages";

/** The held sends shown as sent: user messages until their turn starts. */
export function buildHeldTimelineMessages(
  heldSends: ReadonlyMap<string, HeldSendView>,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const held of heldSends.values()) {
    if (held.hold.sentAs !== "send") continue;
    const { entry } = held;
    messages.push({
      id: MessageId.make(entry.id),
      role: "user",
      text: buildOutgoingMessageText({ composer: entry.composer, formatOutgoingPrompt }),
      ...(entry.composer.images.length > 0
        ? {
            attachments: entry.composer.images.map((image) => ({
              type: image.type,
              id: image.id,
              name: image.name,
              mimeType: image.mimeType,
              sizeBytes: image.sizeBytes,
              previewUrl: image.previewUrl,
            })),
          }
        : {}),
      createdAt: entry.createdAt ?? new Date(0).toISOString(),
      streaming: false,
    });
  }
  return messages;
}

/** Why queued messages wait on a hosted connection that does not take commands now; null when they need not. */
export function resolveQueuedMessagesWait(
  dispatchCapability: HostedRpcCapability,
  dispatchEstablishing: boolean,
  hostedSwitchTargetLabel: string | null,
): QueuedMessagesWait | null {
  if (!dispatchCapability.hosted || dispatchCapability.allowed) return null;
  if (dispatchEstablishing) {
    return {
      kind: "connecting",
      copy: hostedSendsWhenReadyCopy(hostedSwitchTargetLabel),
      failure: dispatchCapability.reason,
    };
  }
  if (dispatchCapability.kind === "role") {
    return { kind: "role", copy: hostedRoleRefusesSendCopy(hostedSwitchTargetLabel) };
  }
  return {
    kind: "unavailable",
    copy: dispatchCapability.reason ?? "Commands are unavailable on this connection.",
  };
}
