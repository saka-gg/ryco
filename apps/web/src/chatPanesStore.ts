import { create } from "zustand";
import * as Schema from "effect/Schema";
import type { ScopedThreadRef } from "@ryco/contracts";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import {
  decodePaneLayout,
  movePane,
  paneContains,
  splitPane,
  type PaneNode,
  type PaneSide,
} from "./chatPanes.logic";

export const CHAT_PANES_STORAGE_KEY = "ryco:chat-panes:v1";
function restore(): PaneNode | null {
  try {
    return decodePaneLayout(getLocalStorageItem(CHAT_PANES_STORAGE_KEY, Schema.String));
  } catch {
    return null;
  }
}
interface ChatPanesState {
  root: PaneNode | null;
  activeRef: ScopedThreadRef | null;
  setRoot: (root: PaneNode | null) => void;
  setActiveRef: (ref: ScopedThreadRef | null) => void;
  open: (ref: ScopedThreadRef, side?: PaneSide, target?: ScopedThreadRef) => boolean;
}
export function availablePaneSplit(
  root: PaneNode | null,
  anchor: ScopedThreadRef | null,
  ref: ScopedThreadRef,
): PaneSide | null {
  if (!anchor || anchor.environmentId !== ref.environmentId) return null;
  const base: PaneNode =
    root && paneContains(root, anchor) ? root : { kind: "thread", ref: anchor };
  for (const side of ["right", "bottom"] as const)
    if (splitPane(base, anchor, ref, side) !== base) return side;
  return null;
}
export const useChatPanesStore = create<ChatPanesState>((set, get) => ({
  root: restore(),
  activeRef: null,
  setRoot: (root) => {
    if (get().root === root) return;
    set({ root });
    // Existing storage adapter keeps hosted UI state memory-only. Writes happen on
    // completed operations, never on pointermove; failures must not interrupt chat.
    try {
      setLocalStorageItem(
        CHAT_PANES_STORAGE_KEY,
        JSON.stringify({ version: 1, root }),
        Schema.String,
      );
    } catch {
      /* storage unavailable */
    }
  },
  setActiveRef: (activeRef) => set({ activeRef }),
  open: (ref, side, target) => {
    const state = get(),
      anchor = target ?? state.activeRef;
    if (!anchor) return false;
    const base: PaneNode =
      state.root && paneContains(state.root, anchor) ? state.root : { kind: "thread", ref: anchor };
    const direction = side ?? availablePaneSplit(state.root, anchor, ref);
    if (!direction) return false;
    const next = movePane(base, anchor, ref, direction);
    if (next === base) return false;
    state.setRoot(next);
    return true;
  },
}));
