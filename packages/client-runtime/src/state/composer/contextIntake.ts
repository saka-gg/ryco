import type { ScopedThreadRef } from "@ryco/contracts";

import { scopedThreadKey } from "../../scoped.ts";
import type { FileReference } from "./fileReference.ts";

/** Context another surface (a diff, the Files panel) hands to a thread's composer. */
export type ComposerContextItem = {
  readonly kind: "file-reference";
  readonly reference: FileReference;
};

/**
 * What became of an item handed to a composer: `added` (a repeat that
 * replaced an earlier one included), `full` when the draft holds as many as a
 * message carries (retrying cannot help until one is removed), or
 * `unavailable` when no composer could take it now (none listens, read-only,
 * a question waits). The caller tells the user which.
 */
export type ComposerContextDelivery = "added" | "full" | "unavailable";

/** A mounted composer taking an item. */
export type ComposerContextReceiver = (item: ComposerContextItem) => ComposerContextDelivery;

export interface ComposerContextIntake {
  /**
   * Makes `thread`'s composer the receiver of items for that thread until the
   * returned function runs. A later registration for the same thread takes
   * over and hands back on release.
   *
   * Register once for as long as the composer is mounted, and refuse in the
   * receiver while it cannot take items (read-only, mid-send, full). Panels
   * offer "Add to chat" while a receiver is registered, so registering and
   * releasing around every send would make their gutters and open notes
   * flicker.
   */
  register(thread: ScopedThreadRef, receiver: ComposerContextReceiver): () => void;
  /** Whether a composer is listening for `thread`, so offering "Add to chat" can work. */
  canDeliver(thread: ScopedThreadRef): boolean;
  /** Hands `item` to `thread`'s composer; `unavailable` when none listens. */
  deliver(thread: ScopedThreadRef, item: ComposerContextItem): ComposerContextDelivery;
  /** Runs `listener` whenever a composer registers or releases. */
  subscribe(listener: () => void): () => void;
}

/**
 * Ephemeral handoff from panels to the composer of the thread they show. It
 * holds receivers only, never items: an item nobody takes is dropped, so
 * nothing is replayed after a reload or reconnect.
 */
export function createComposerContextIntake(): ComposerContextIntake {
  const receivers = new Map<string, ComposerContextReceiver[]>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const current = (thread: ScopedThreadRef) => receivers.get(scopedThreadKey(thread))?.at(-1);

  return {
    register(thread, receiver) {
      const key = scopedThreadKey(thread);
      // A wrapper gives each registration its own identity, so registering
      // the same function twice releases exactly one of them.
      const entry: ComposerContextReceiver = (item) => receiver(item);
      receivers.set(key, [...(receivers.get(key) ?? []), entry]);
      notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (receivers.get(key) ?? []).filter((candidate) => candidate !== entry);
        if (remaining.length > 0) receivers.set(key, remaining);
        else receivers.delete(key);
        notify();
      };
    },
    canDeliver: (thread) => current(thread) !== undefined,
    deliver(thread, item) {
      const receiver = current(thread);
      return receiver ? receiver(item) : "unavailable";
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
