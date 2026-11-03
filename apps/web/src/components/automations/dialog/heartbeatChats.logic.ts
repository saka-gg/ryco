/**
 * A heartbeat's chat (`execution.target`): which chats a schedule can run
 * into, and what the chosen one reads as, in the editor and the detail.
 */
import { sortThreads, type SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import type { ThreadId } from "@ryco/contracts";

/** A chat a schedule can run into (a heartbeat). */
export interface HeartbeatChat {
  readonly threadId: ThreadId;
  readonly title: string;
}

/**
 * The chats a schedule can run into: the project's open chats on the schedule's device, the
 * most recently active first. The server takes only these (an open chat of the automation's
 * project) and checks the chosen one again when the change is approved and on every run.
 */
export function heartbeatChatChoices(
  threads: readonly SidebarThreadOrStub[],
): readonly HeartbeatChat[] {
  return sortThreads(
    threads.filter((thread) => thread.archivedAt === null),
    "updated_at",
  ).map((thread) => ({ threadId: thread.id, title: thread.title.trim() || "Untitled chat" }));
}

/**
 * What a heartbeat's chat reads as: its title, "(archived)" after an archived one's, and
 * "an unavailable chat" for one this device doesn't list (deleted, or not loaded here).
 */
export function heartbeatChatWords(
  threads: readonly SidebarThreadOrStub[],
  threadId: ThreadId,
): string {
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (!thread) return "an unavailable chat";
  const title = thread.title.trim() || "Untitled chat";
  return thread.archivedAt === null ? title : `${title} (archived)`;
}

/** Whether a chat's title holds what was typed (any case, any order of words). */
export function heartbeatChatMatches(chat: HeartbeatChat, query: string): boolean {
  const title = chat.title.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => title.includes(word));
}
