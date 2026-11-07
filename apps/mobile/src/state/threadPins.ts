import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  applyThreadPin,
  pinnedThreadKeyList,
  sanitizePinnedThreadKeys,
  setThreadKeyPinned,
  type PinnedThreadKeys,
  type ThreadPinStore,
} from "@ryco/client-runtime/state/threads/threadPins";
import * as Haptics from "expo-haptics";
import { useSyncExternalStore } from "react";

import { mobileKV } from "../platform/kv";
import { sidebarUndo } from "./sidebarUndo";

/**
 * Pinned threads on this device, by scoped thread key. Pins are UI state, not
 * node state: web keeps its own, the phone keeps these. Pinned threads lead
 * the Inbox in their own section and never auto-settle.
 */
const STORAGE_KEY = "ryco.pinnedThreadKeys";
const EMPTY: PinnedThreadKeys = {};

let state: PinnedThreadKeys = EMPTY;
let hydration: "idle" | "loading" | "done" = "idle";
/** Pins changed while the saved ones load; they win over the saved ones. */
let pendingChanges: Map<string, boolean> | null = null;
const listeners = new Set<() => void>();

function setState(next: PinnedThreadKeys): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function persist(): void {
  // Writing before the saved pins are read would drop them; hydration saves the merge.
  if (hydration !== "done") return;
  void mobileKV.setItem(STORAGE_KEY, JSON.stringify(pinnedThreadKeyList(state))).catch(() => {
    // Best effort: an unsaved pin is lost on restart, nothing else.
  });
}

/** Reads the saved pins once; pins changed meanwhile win over the saved ones. */
export function hydrateThreadPins(): void {
  if (hydration !== "idle") return;
  hydration = "loading";
  const changedBeforeHydration = new Map<string, boolean>();
  pendingChanges = changedBeforeHydration;
  void mobileKV
    .getItem(STORAGE_KEY)
    .then((raw) => {
      let saved: PinnedThreadKeys = EMPTY;
      try {
        saved = raw === null ? EMPTY : sanitizePinnedThreadKeys(JSON.parse(raw));
      } catch {
        saved = EMPTY;
      }
      let merged = saved;
      for (const [threadKey, pinned] of changedBeforeHydration) {
        merged = setThreadKeyPinned(merged, threadKey, pinned);
      }
      hydration = "done";
      pendingChanges = null;
      setState(merged);
      if (changedBeforeHydration.size > 0) persist();
    })
    .catch(() => {
      // Unreadable: keep what changed meanwhile and save it over the unreadable copy.
      hydration = "done";
      pendingChanges = null;
      if (changedBeforeHydration.size > 0) persist();
    });
}
export function isThreadPinned(threadKey: string): boolean {
  return state[threadKey] === true;
}

export function setThreadPinned(threadKey: string, pinned: boolean): void {
  hydrateThreadPins();
  pendingChanges?.set(threadKey, pinned);
  setState(setThreadKeyPinned(state, threadKey, pinned));
  persist();
}

export function getThreadPins(): PinnedThreadKeys {
  return state;
}

function subscribe(listener: () => void): () => void {
  hydrateThreadPins();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const deviceThreadPinStore: ThreadPinStore = {
  isPinned: isThreadPinned,
  setPinned: setThreadPinned,
  subscribe,
};

export function useThreadPins(): PinnedThreadKeys {
  return useSyncExternalStore(subscribe, getThreadPins, getThreadPins);
}

/**
 * Pins or unpins a thread from a swipe or a menu. Unpinning offers Undo; pinning
 * supersedes the thread's older notices, like web.
 */
export function changeThreadPin(threadKey: string, pinned: boolean): void {
  const target = parseScopedThreadKey(threadKey);
  if (!target || isThreadPinned(threadKey) === pinned) return;
  void Haptics.selectionAsync();
  applyThreadPin({ target, threadKey, pinned }, deviceThreadPinStore, sidebarUndo);
}

export function resetThreadPinsForTests(): void {
  state = EMPTY;
  hydration = "idle";
  pendingChanges = null;
  listeners.clear();
}
