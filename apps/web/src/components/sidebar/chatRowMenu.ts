import type { ScopedProjectRef, ScopedThreadRef } from "@ryco/contracts";

import { canPromoteChatOn, openPromoteChatDialog } from "../chat/promoteChatDialogStore";

/**
 * The chat a sidebar "Chats" row stands for: its one thread, the chat project
 * behind it, and the chat folder on its node (null while unknown).
 */
export interface ChatRowMenuSubject {
  readonly threadRef: ScopedThreadRef;
  readonly projectRef: ScopedProjectRef;
  readonly title: string;
  readonly folderPath: string | null;
}

/**
 * EXTENSION POINT for "Chats" row menus (and any other chat surface that
 * renders the thread menu inventory). An extension adds one menu item, shown
 * after the folder actions and dispatched as `chat-extension:<id>`.
 *
 * "Turn into project…" plugs in here (see `useChatRowMenuExtensions` below);
 * no other wiring is needed.
 */
export interface ChatRowMenuExtension {
  /** Stable, unique id (menu action id is `chat-extension:<id>`). */
  readonly id: string;
  readonly label: string;
  /** Hide the item for a chat it cannot act on (e.g. a node without promotion). */
  readonly isAvailable?: (chat: ChatRowMenuSubject) => boolean;
  readonly run: (chat: ChatRowMenuSubject) => void | Promise<void>;
}

/** "Turn into project…": opens the promotion dialog, grown out of the row the menu was for. */
const PROMOTE_CHAT_EXTENSION: ChatRowMenuExtension = {
  id: "promote",
  label: "Turn into project…",
  isAvailable: (chat) => canPromoteChatOn(chat.projectRef.environmentId),
  run: (chat) => {
    openPromoteChatDialog({
      projectRef: chat.projectRef,
      threadRef: chat.threadRef,
      title: chat.title,
    });
  },
};

const CHAT_ROW_MENU_EXTENSIONS: ReadonlyArray<ChatRowMenuExtension> = Object.freeze([
  PROMOTE_CHAT_EXTENSION,
]);

/**
 * The chat row menu extensions in effect. Returns a stable array; an
 * implementation must memoize what it returns, because row menus read it on
 * every open.
 */
export function useChatRowMenuExtensions(): ReadonlyArray<ChatRowMenuExtension> {
  return CHAT_ROW_MENU_EXTENSIONS;
}

export const CHAT_EXTENSION_ACTION_PREFIX = "chat-extension:";
