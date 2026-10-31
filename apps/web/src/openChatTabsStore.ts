import type { ScopedThreadRef } from "@ryco/contracts";
import {
  addOpenChatTab,
  decodeOpenChatTabs,
  encodeOpenChatTabs,
  moveOpenChatTab,
  OPEN_CHAT_TABS_STORAGE_KEY,
  pruneOpenChatTabs,
  removeOpenChatTab,
  removeOpenChatTabs,
} from "@ryco/client-runtime/state/threads/openChatTabs";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

/*
 * Which chats are open as tabs in the chat header, in tab order. The active tab is never stored:
 * it is always the chat on screen. Desktop and direct browsers keep the list across reloads in the
 * local UI storage; hosted mode, through the same adapter, keeps it in memory only.
 */

interface OpenChatTabsState {
  refs: readonly ScopedThreadRef[];
  open: (ref: ScopedThreadRef) => void;
  close: (ref: ScopedThreadRef) => void;
  closeMany: (refs: readonly ScopedThreadRef[]) => void;
  move: (ref: ScopedThreadRef, overRef: ScopedThreadRef) => void;
  prune: (isKept: (ref: ScopedThreadRef) => boolean) => void;
}

function restore(): readonly ScopedThreadRef[] {
  try {
    return decodeOpenChatTabs(getLocalStorageItem(OPEN_CHAT_TABS_STORAGE_KEY, Schema.String));
  } catch {
    return [];
  }
}

function persist(refs: readonly ScopedThreadRef[]): void {
  try {
    setLocalStorageItem(OPEN_CHAT_TABS_STORAGE_KEY, encodeOpenChatTabs(refs), Schema.String);
  } catch {
    /* storage unavailable: the tabs still work for this window */
  }
}

export const useOpenChatTabsStore = create<OpenChatTabsState>((set, get) => {
  // Every transition returns its input when nothing changes; skip those writes entirely, which
  // matters on the layout-effect path that records the chat on screen on every navigation.
  const apply = (next: readonly ScopedThreadRef[]) => {
    if (next === get().refs) return;
    set({ refs: next });
    persist(next);
  };
  return {
    refs: restore(),
    open: (ref) => apply(addOpenChatTab(get().refs, ref)),
    close: (ref) => apply(removeOpenChatTab(get().refs, ref)),
    closeMany: (refs) => apply(removeOpenChatTabs(get().refs, refs)),
    move: (ref, overRef) => apply(moveOpenChatTab(get().refs, ref, overRef)),
    prune: (isKept) => apply(pruneOpenChatTabs(get().refs, isKept)),
  };
});
