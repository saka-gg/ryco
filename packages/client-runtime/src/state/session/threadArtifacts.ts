import type { ChatAttachmentHandoff, MessageId, TurnId } from "@ryco/contracts";
import type { HtmlRenderMetadata } from "@ryco/shared/htmlRender";
import { formatThreadArtifactId, isThreadArtifactAttachment } from "@ryco/shared/threadArtifacts";

import {
  isChatFileAttachment,
  isChatImageAttachment,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type ChatMessage,
} from "../threads/types.ts";
import { readHtmlRenderAttachment } from "./htmlRenderTimeline.ts";

/**
 * A thread's artifacts, shared by every client (`@ryco/shared/threadArtifacts`):
 * the pages the agent rendered (`ryco_html_render`), the files it attached
 * (`ryco_attach_file`), and the ones handed over from another thread (from the
 * thread that delegated this one, or returned by a thread it delegated). The
 * user's own uploads are not artifacts.
 */

interface ThreadArtifactBase {
  /** `messageId:attachmentId`: unique within the thread. */
  readonly key: string;
  readonly messageId: MessageId;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
  /** Handed over from another thread: the thread and message it was copied from. */
  readonly handoff: ChatAttachmentHandoff | null;
}

export interface ThreadPageArtifact extends ThreadArtifactBase {
  readonly kind: "page";
  readonly attachment: ChatFileAttachment;
  /** Validated and clamped. */
  readonly htmlRender: HtmlRenderMetadata;
}

export interface ThreadFileArtifact extends ThreadArtifactBase {
  readonly kind: "file";
  readonly attachment: ChatImageAttachment | ChatFileAttachment;
}

export type ThreadArtifact = ThreadPageArtifact | ThreadFileArtifact;

/** A thread message as artifacts are read from it: as loaded, or as a history page sends it. */
export interface ThreadArtifactSource {
  readonly id: MessageId;
  readonly role: ChatMessage["role"];
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly turnId?: TurnId | null | undefined;
  readonly createdAt: string;
}

const NO_ARTIFACTS: ReadonlyArray<ThreadArtifact> = [];

// Message objects are replaced, never changed in place: each is read once.
const artifactsByMessage = new WeakMap<ThreadArtifactSource, ReadonlyArray<ThreadArtifact>>();

/** The artifacts one message carries, in the order it published them. */
export function readMessageArtifacts(message: ThreadArtifactSource): ReadonlyArray<ThreadArtifact> {
  const cached = artifactsByMessage.get(message);
  if (cached !== undefined) return cached;
  let artifacts = NO_ARTIFACTS;
  if (message.attachments && message.attachments.length > 0) {
    const read = message.attachments.flatMap((attachment): ThreadArtifact[] => {
      if (
        !(isChatImageAttachment(attachment) || isChatFileAttachment(attachment)) ||
        !isThreadArtifactAttachment(message.role, attachment)
      )
        return [];
      const base = {
        key: formatThreadArtifactId({ messageId: message.id, attachmentId: attachment.id }),
        messageId: message.id,
        turnId: message.turnId ?? null,
        createdAt: message.createdAt,
        handoff: attachment.handoff ?? null,
      };
      const render = readHtmlRenderAttachment(attachment);
      return render !== undefined
        ? [{ ...base, kind: "page", ...render }]
        : [{ ...base, kind: "file", attachment }];
    });
    if (read.length > 0) artifacts = read;
  }
  artifactsByMessage.set(message, artifacts);
  return artifacts;
}

function compareNewestFirst(left: ThreadArtifactSource, right: ThreadArtifactSource): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

/**
 * The thread's artifacts, newest message first: those of the messages as
 * loaded, then those of `earlier` messages read further back. A message in
 * both is read as loaded, which is the live copy.
 */
export function deriveThreadArtifacts(
  messages: ReadonlyArray<ThreadArtifactSource>,
  earlier: ReadonlyArray<ThreadArtifactSource> = [],
): ReadonlyArray<ThreadArtifact> {
  const loadedIds = new Set<MessageId>();
  const sources: ThreadArtifactSource[] = [];
  for (const message of messages) {
    loadedIds.add(message.id);
    if (readMessageArtifacts(message).length > 0) sources.push(message);
  }
  for (const message of earlier) {
    if (!loadedIds.has(message.id) && readMessageArtifacts(message).length > 0) {
      sources.push(message);
    }
  }
  if (sources.length === 0) return NO_ARTIFACTS;
  return sources.toSorted(compareNewestFirst).flatMap(readMessageArtifacts);
}
