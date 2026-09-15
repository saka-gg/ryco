import {
  MessageId,
  type TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@ryco/contracts";
import type { ProviderThreadHistory } from "../provider/Services/ProviderAdapter.ts";

/** Preserve local IDs/attachments and segmented messages when filling a provider gap. */
export function historyMessagesToRestore(
  thread: Pick<OrchestrationThread, "id" | "createdAt" | "messages">,
  history: ProviderThreadHistory,
  now: string,
  userMessageIdsByTurn: ReadonlyMap<TurnId, MessageId> = new Map(),
): OrchestrationMessage[] {
  const restored: OrchestrationMessage[] = [];
  const byId = new Map(thread.messages.map((message) => [message.id, message]));
  let precedingCreatedAt = Number.NEGATIVE_INFINITY;
  for (const [index, message] of history.messages.entries()) {
    const recoveredId = MessageId.make(`history:${thread.id}:${message.id}`);
    const existing = byId.get(message.id) ?? byId.get(recoveredId);
    const existingUser =
      message.role === "user"
        ? thread.messages.find(
            (entry) =>
              entry.role === "user" &&
              (entry.turnId === message.turnId ||
                entry.id === userMessageIdsByTurn.get(message.turnId)),
          )
        : undefined;
    if (
      message.role === "user" &&
      message.id.startsWith("user:") &&
      !byId.has(message.id) &&
      !byId.has(recoveredId) &&
      existingUser
    ) {
      precedingCreatedAt = Math.max(precedingCreatedAt, Date.parse(existingUser.createdAt));
      continue;
    }
    const segments =
      message.role === "assistant"
        ? thread.messages
            .filter(
              (existing) =>
                existing.turnId === message.turnId &&
                (existing.id === message.id || existing.id.startsWith(`${message.id}:segment:`)),
            )
            .toSorted(
              (a, b) =>
                a.createdAt.localeCompare(b.createdAt) ||
                a.id.localeCompare(b.id, undefined, { numeric: true }),
            )
        : [];
    if (segments.length > 1) {
      precedingCreatedAt = Math.max(
        precedingCreatedAt,
        ...segments.map((segment) => Date.parse(segment.createdAt)),
      );
      const prefix = segments
        .slice(0, -1)
        .map((segment) => segment.text)
        .join("");
      // Do not duplicate earlier text across a pause-for-user segment boundary.
      if (!message.text.startsWith(prefix)) continue;
      for (const [segmentIndex, segment] of segments.entries()) {
        const text =
          segmentIndex === segments.length - 1 ? message.text.slice(prefix.length) : segment.text;
        if (segment.text !== text || segment.streaming)
          restored.push({ ...segment, text, streaming: false, updatedAt: now });
      }
      continue;
    }
    // Codex records turn timestamps with second precision. Preserve provider
    // item order and existing local anchors when multiple messages share it.
    const createdAt =
      existing?.createdAt ??
      new Date(
        Math.max(
          message.createdAt === "1970-01-01T00:00:00.000Z"
            ? Date.parse(thread.createdAt) + index
            : Date.parse(message.createdAt),
          precedingCreatedAt + 1,
        ),
      ).toISOString();
    precedingCreatedAt = Math.max(precedingCreatedAt, Date.parse(createdAt));
    if (existing && existing.text === message.text && !existing.streaming) continue;
    restored.push({
      ...message,
      id: existing?.id ?? recoveredId,
      streaming: false,
      createdAt,
      updatedAt: now,
    });
  }
  return restored;
}

export function missingHistoryActivities(
  existing: readonly OrchestrationThreadActivity[],
  recovered: readonly OrchestrationThreadActivity[],
): OrchestrationThreadActivity[] {
  const key = (activity: OrchestrationThreadActivity) => {
    const payload = activity.payload as { providerItemId?: unknown } | null;
    return payload && typeof payload.providerItemId === "string"
      ? `${activity.turnId}:${activity.kind}:${payload.providerItemId}`
      : activity.id;
  };
  const known = new Set(existing.map(key));
  return recovered.filter((activity) => {
    // Transcript items cannot restore process-local callbacks or settle a live
    // callback that happens to reuse the same provider request ID. Lifecycle
    // cleanup is generated separately from the authoritative pending projection.
    if (
      activity.kind.startsWith("user-input.") ||
      activity.kind.startsWith("approval.") ||
      activity.kind === "provider.user-input.respond.failed" ||
      activity.kind === "provider.approval.respond.failed"
    )
      return false;
    const id = key(activity);
    if (known.has(id)) return false;
    known.add(id);
    return true;
  });
}
