import type { Action } from "expo-quick-actions";

/** One thread the person opened on this phone, newest first in the list. */
export interface RecentThreadShortcut {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export const MAX_RECENT_THREAD_SHORTCUTS = 3;

const NEW_TASK_SHORTCUT_ID = "new-task";
/** App paths, as the navigation linking config names them (`mvpRouteConfig.ts`). */
const NEW_TASK_PATH = "tasks/new";
const THREAD_PATH_PATTERN = /^threads\/[^/?#]+\/[^/?#]+$/;

function threadPath(thread: RecentThreadShortcut): string {
  return `threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;
}

function threadShortcutLabel(thread: RecentThreadShortcut): string {
  const title = thread.title.trim();
  return title.length > 0 ? title : "Task";
}

/**
 * The app path a quick action opens, or null. Shortcuts outlive app updates, so
 * only today's destinations are allowed: a stale or malformed one opens nothing.
 */
export function shortcutPath(action: Pick<Action, "params"> | null | undefined): string | null {
  const path = action?.params?.path;
  if (typeof path !== "string") return null;
  return path === NEW_TASK_PATH || THREAD_PATH_PATTERN.test(path) ? path : null;
}

/** `current` with `opened` first; the same list when nothing changes. */
export function withRecentThreadShortcut(
  current: ReadonlyArray<RecentThreadShortcut>,
  opened: RecentThreadShortcut,
): ReadonlyArray<RecentThreadShortcut> {
  const existing = current.find(
    (thread) =>
      thread.environmentId === opened.environmentId && thread.threadId === opened.threadId,
  );
  const title = opened.title.trim().length > 0 ? opened.title : (existing?.title ?? opened.title);
  if (current[0] === existing && existing !== undefined && existing.title === title) return current;
  return [
    { environmentId: opened.environmentId, threadId: opened.threadId, title },
    ...current.filter((thread) => thread !== existing),
  ].slice(0, MAX_RECENT_THREAD_SHORTCUTS);
}

/** A persisted list as recents: well-formed entries only, at most three. */
export function sanitizeRecentThreadShortcuts(value: unknown): ReadonlyArray<RecentThreadShortcut> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is RecentThreadShortcut =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.environmentId === "string" &&
        entry.environmentId.length > 0 &&
        typeof entry.threadId === "string" &&
        entry.threadId.length > 0 &&
        typeof entry.title === "string",
    )
    .slice(0, MAX_RECENT_THREAD_SHORTCUTS)
    .map(({ environmentId, threadId, title }) => ({ environmentId, threadId, title }));
}

/** The home-screen quick actions: New task, then the recent threads. */
export function buildShortcutActions(recents: ReadonlyArray<RecentThreadShortcut>): Action[] {
  return [
    {
      id: NEW_TASK_SHORTCUT_ID,
      title: "New task",
      icon: "symbol:square.and.pencil",
      params: { path: NEW_TASK_PATH },
    },
    ...recents.slice(0, MAX_RECENT_THREAD_SHORTCUTS).map((thread): Action => ({
      // Encoded paths keep machine and thread ids from colliding.
      id: `thread:${threadPath(thread)}`,
      title: threadShortcutLabel(thread),
      icon: "symbol:bubble.left.and.text.bubble.right",
      params: { path: threadPath(thread) },
    })),
  ];
}
