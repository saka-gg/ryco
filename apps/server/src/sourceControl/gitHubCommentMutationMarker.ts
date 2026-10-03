import { createHash } from "node:crypto";

/**
 * Idempotency markers for comments Ryco posts on GitHub.
 *
 * GitHub's comment APIs have no client-supplied idempotency key, so a retried
 * request would post the same comment twice. When the caller supplies a
 * `clientMutationId`, Ryco appends a hidden HTML comment carrying its SHA-256
 * and checks for that marker before posting again. Every read path strips the
 * marker so it never reaches the UI or agent context.
 */

const RYCO_COMMENT_MARKER_PATTERN = /\n{0,2}<!-- ryco-comment-id:[a-f0-9]{64} -->\s*$/u;

export function commentMutationMarker(clientMutationId: string): string {
  const hashed = createHash("sha256").update(clientMutationId).digest("hex");
  return `<!-- ryco-comment-id:${hashed} -->`;
}

export function appendCommentMutationMarker(
  body: string,
  clientMutationId: string | undefined,
): string {
  if (clientMutationId === undefined) return body;
  return `${body.trimEnd()}\n\n${commentMutationMarker(clientMutationId)}`;
}

export function stripCommentMutationMarker(body: string): string {
  return body.replace(RYCO_COMMENT_MARKER_PATTERN, "").trimEnd();
}

export function hasCommentMutationMarker(
  comments: ReadonlyArray<{ readonly body: string }>,
  clientMutationId: string | undefined,
): boolean {
  if (clientMutationId === undefined) return false;
  const marker = commentMutationMarker(clientMutationId);
  return comments.some((comment) => comment.body.includes(marker));
}
