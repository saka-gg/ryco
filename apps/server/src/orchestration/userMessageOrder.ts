import type { OrchestrationMessage } from "@ryco/contracts";

/**
 * The thread's latest user message: the greatest `createdAt`, ties going to the later array
 * position. In-memory twin of `latestUserMessageIdQuery` (`created_at DESC, rowid DESC`):
 * message upserts keep their rowid and hydrated anchors precede appended messages, so array
 * order equals rowid order. The delegated-return fence compares the two; never use
 * `findLast(user)` for it.
 */
export function latestUserMessage<M extends Pick<OrchestrationMessage, "role" | "createdAt">>(
  messages: ReadonlyArray<M>,
): M | undefined {
  let latest: M | undefined;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (latest === undefined || message.createdAt >= latest.createdAt) latest = message;
  }
  return latest;
}
