import type { ScopedThreadRef } from "@ryco/contracts";

import type { SidebarUndoHistory } from "./sidebarUndo.ts";

/**
 * Thread pins are this client's own UI state, keyed by scoped thread key
 * (`environmentId:threadId`): web keeps them in its UI-state store, the phone
 * on the device. Pinned threads lead the Active list and never auto-settle
 * (`buildThreadInbox`'s `pinnedThreadKeys`).
 */
export type PinnedThreadKeys = Readonly<Record<string, boolean>>;

/** `pins` with `threadKey` pinned or not; the same object when nothing changes. */
export function setThreadKeyPinned(
  pins: PinnedThreadKeys,
  threadKey: string,
  pinned: boolean,
): PinnedThreadKeys {
  if ((pins[threadKey] === true) === pinned) return pins;
  if (pinned) return { ...pins, [threadKey]: true };
  const next = { ...pins };
  delete next[threadKey];
  return next;
}

/** A persisted pin list as pins: unique, trimmed, non-empty string keys only. */
export function sanitizePinnedThreadKeys(value: unknown): Record<string, boolean> {
  if (!Array.isArray(value)) return {};
  const pins: Record<string, boolean> = {};
  for (const entry of value) {
    const threadKey = typeof entry === "string" ? entry.trim() : "";
    if (threadKey.length > 0) pins[threadKey] = true;
  }
  return pins;
}

/** The keys to persist, in insertion order. */
export function pinnedThreadKeyList(pins: PinnedThreadKeys): string[] {
  return Object.entries(pins).flatMap(([threadKey, pinned]) => (pinned ? [threadKey] : []));
}

/** One client's pin storage. */
export interface ThreadPinStore {
  readonly isPinned: (threadKey: string) => boolean;
  readonly setPinned: (threadKey: string, pinned: boolean) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Pins or unpins one thread through the shared Undo history: a pin supersedes
 * the thread's older notices, an unpin offers Undo while the thread's local
 * ordering state stays the same.
 */
export function applyThreadPin(
  input: {
    readonly target: ScopedThreadRef;
    readonly threadKey: string;
    readonly pinned: boolean;
  },
  store: ThreadPinStore,
  undo: Pick<SidebarUndoHistory, "supersede" | "unpin">,
): void {
  if (input.pinned) {
    undo.supersede(input.target);
    store.setPinned(input.threadKey, true);
    return;
  }
  undo.unpin(input.target, {
    read: () => store.isPinned(input.threadKey),
    write: (next) => store.setPinned(input.threadKey, next),
    subscribe: store.subscribe,
  });
}

export type ThreadPinChangeResult = "changed" | "unchanged" | "cancelled";

export interface ThreadPinChangeDependencies {
  readonly isPinned: (threadKey: string) => boolean;
  readonly setPinned: (threadKey: string, pinned: boolean) => void;
  readonly confirm: (message: string) => Promise<boolean>;
  /** Reports a pin write that threw; the pin is left as it was. */
  readonly failed?: (error: unknown) => void;
}

export async function requestThreadPinChange(
  input: {
    readonly threadKey: string;
    readonly threadTitle: string;
    readonly pinned: boolean;
    readonly confirmUnpin: boolean;
  },
  dependencies: ThreadPinChangeDependencies,
): Promise<ThreadPinChangeResult> {
  if (dependencies.isPinned(input.threadKey) === input.pinned) return "unchanged";
  if (
    !input.pinned &&
    input.confirmUnpin &&
    !(await dependencies.confirm(
      `Unpin "${input.threadTitle}"?\nIt will return to its normal position in the thread list.`,
    ))
  ) {
    return "cancelled";
  }
  try {
    dependencies.setPinned(input.threadKey, input.pinned);
  } catch (error) {
    dependencies.failed?.(error);
    return "unchanged";
  }
  return "changed";
}

export function toggleThreadPin(
  input: {
    readonly threadKey: string;
    readonly threadTitle: string;
    readonly confirmUnpin: boolean;
  },
  dependencies: ThreadPinChangeDependencies,
): Promise<ThreadPinChangeResult> {
  return requestThreadPinChange(
    { ...input, pinned: !dependencies.isPinned(input.threadKey) },
    dependencies,
  );
}
