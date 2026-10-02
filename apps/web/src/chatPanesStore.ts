import { create } from "zustand";
import * as Schema from "effect/Schema";
import type { ScopedThreadRef } from "@ryco/contracts";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import {
  decodePaneLayout,
  movePane,
  paneContains,
  PANE_DRAG_TYPE,
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
/** Keyboard entry points into the mounted split; each reports whether it acted. */
export interface ChatPanesController {
  focusSibling: (offset: 1 | -1) => boolean;
  closeFocused: () => boolean;
}
interface ChatPanesState {
  root: PaneNode | null;
  activeRef: ScopedThreadRef | null;
  controller: ChatPanesController | null;
  setRoot: (root: PaneNode | null) => void;
  setActiveRef: (ref: ScopedThreadRef | null) => void;
  /** Installs the mounted split's controller; the returned cleanup removes only that one. */
  registerController: (controller: ChatPanesController) => () => void;
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
// Browsers hide drag data until the drop, so the preview could not tell a
// refused drop from an accepted one. In-app sources record what they carry.
let draggedPaneRef: ScopedThreadRef | null = null;

/** Starts a thread drag that a split pane can receive. */
export function startPaneDrag(
  transfer: DataTransfer,
  ref: ScopedThreadRef,
  effectAllowed: DataTransfer["effectAllowed"],
) {
  transfer.setData(
    PANE_DRAG_TYPE,
    JSON.stringify({ environmentId: ref.environmentId, threadId: ref.threadId }),
  );
  transfer.effectAllowed = effectAllowed;
  draggedPaneRef = ref;
}
export function endPaneDrag() {
  draggedPaneRef = null;
}
/** The in-app thread being dragged; null for drags from another window. */
export function readPaneDragSource(): ScopedThreadRef | null {
  return draggedPaneRef;
}

export const useChatPanesStore = create<ChatPanesState>((set, get) => ({
  root: restore(),
  activeRef: null,
  controller: null,
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
  registerController: (controller) => {
    set({ controller });
    return () => {
      if (get().controller === controller) set({ controller: null });
    };
  },
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
