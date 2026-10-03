import { MessageId, TurnId } from "@ryco/contracts";
import type { ChatMessage } from "./types.ts";

export const CACHED_THREAD_MESSAGE_LIMIT = 150;
export const CACHED_THREAD_TEXT_LIMIT = 1_000_000;

/** Display data only. Never a replay baseline, session, or dispatch queue. */
export interface CachedThreadContent {
  readonly messages: ReadonlyArray<ChatMessage>;
}

/** An explicit allowlist also strips attachment URLs and in-progress authority. */
export function captureThreadReadContent(
  messages: ReadonlyArray<ChatMessage>,
): CachedThreadContent {
  let remaining = CACHED_THREAD_TEXT_LIMIT;
  const saved: ChatMessage[] = [];
  for (const message of messages.slice(-CACHED_THREAD_MESSAGE_LIMIT).toReversed()) {
    if (message.text.length > remaining) break;
    remaining -= message.text.length;
    saved.push({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      completedAt: message.completedAt,
      turnId: message.turnId ?? null,
      streaming: false,
    });
  }
  return { messages: saved.toReversed() };
}

export function decodeThreadReadContent(value: unknown): CachedThreadContent | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("messages" in value) ||
    !Array.isArray(value.messages) ||
    value.messages.length > CACHED_THREAD_MESSAGE_LIMIT
  )
    return null;
  const messages: ChatMessage[] = [];
  const ids = new Set<string>();
  let length = 0;
  for (const item of value.messages) {
    if (!item || typeof item !== "object") return null;
    const m = item as Record<string, unknown>;
    if (
      typeof m.id !== "string" ||
      !m.id ||
      ids.has(m.id) ||
      !["user", "assistant", "system"].includes(String(m.role)) ||
      typeof m.text !== "string" ||
      typeof m.createdAt !== "string" ||
      (m.completedAt !== undefined && typeof m.completedAt !== "string") ||
      (m.turnId !== undefined && m.turnId !== null && typeof m.turnId !== "string")
    )
      return null;
    length += m.text.length;
    if (length > CACHED_THREAD_TEXT_LIMIT) return null;
    ids.add(m.id);
    messages.push({
      id: MessageId.make(m.id),
      role: m.role as ChatMessage["role"],
      text: m.text,
      createdAt: m.createdAt,
      completedAt: m.completedAt as string | undefined,
      turnId: typeof m.turnId === "string" ? TurnId.make(m.turnId) : null,
      streaming: false,
    });
  }
  return { messages };
}
