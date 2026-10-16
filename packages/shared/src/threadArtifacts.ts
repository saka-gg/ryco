/**
 * A thread's artifacts, shared by server and clients: the stored pages and
 * files the agent published into the thread (`ryco_html_render`,
 * `ryco_attach_file`), and the ones handed over to it from another thread (a
 * delegating parent's, or a delegated child's returned result). The user's own
 * uploads are not artifacts.
 *
 * An artifact is named by its message and attachment, `messageId:attachmentId`:
 * what an agent passes to hand one over, and what a client's page tab names.
 */

/** The longest artifact id accepted: a message id and an attachment id. */
export const THREAD_ARTIFACT_ID_MAX_CHARS = 512;

// Attachment ids never contain a colon (`[a-z0-9_-]`); message ids may.
const ATTACHMENT_ID = /^[a-z0-9_-]{1,128}$/i;

export interface ThreadArtifactRef {
  readonly messageId: string;
  readonly attachmentId: string;
}

export function formatThreadArtifactId(ref: ThreadArtifactRef): string {
  return `${ref.messageId}:${ref.attachmentId}`;
}

/** The message and attachment an artifact id names, or null when it names none. */
export function parseThreadArtifactId(id: string): ThreadArtifactRef | null {
  if (id.length > THREAD_ARTIFACT_ID_MAX_CHARS) return null;
  const separator = id.lastIndexOf(":");
  if (separator <= 0) return null;
  const messageId = id.slice(0, separator).trim();
  const attachmentId = id.slice(separator + 1);
  if (messageId.length === 0 || !ATTACHMENT_ID.test(attachmentId)) return null;
  return { messageId, attachmentId };
}

/** Where a handed-over artifact came from (`ChatAttachmentHandoff`). */
export interface ThreadArtifactHandoff {
  readonly threadId: string;
  readonly messageId: string;
}

/**
 * Whether an attachment of a message with this role is one of the thread's
 * artifacts: a stored image or file the agent published, or one handed over.
 */
export function isThreadArtifactAttachment(
  role: string,
  attachment: {
    readonly type: string;
    readonly id?: string | undefined;
    readonly handoff?: ThreadArtifactHandoff | undefined;
  },
): boolean {
  if ((attachment.type !== "image" && attachment.type !== "file") || !attachment.id) return false;
  return role === "assistant" || attachment.handoff !== undefined;
}
