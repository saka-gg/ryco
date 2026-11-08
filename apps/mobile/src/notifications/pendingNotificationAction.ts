import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import {
  NOTIFICATION_ACTION_TTL_MS,
  type NotificationThreadAction,
  type PendingThreadAction,
} from "./notificationActionsModel";

/**
 * The actions people tapped on a notification, per thread, until that thread's screen carries
 * them out (`decideNotificationThreadAction`). In memory only: an action is meant now, and a
 * relaunch must not repeat it. Only a notification response sets one, never a link.
 */
const pending = new Map<string, PendingThreadAction>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Remembers `action` for the thread; a newer tap on the same thread replaces an older one. */
export function setPendingNotificationAction(
  ref: ScopedThreadRef,
  action: NotificationThreadAction,
  at: number,
): void {
  pending.set(scopedThreadKey(ref), { action, at });
  emit();
}

/** The thread's pending action, unless it is past its time. */
export function readPendingNotificationAction(
  ref: ScopedThreadRef,
  nowMs: number,
): PendingThreadAction | null {
  const key = scopedThreadKey(ref);
  const entry = pending.get(key);
  if (entry === undefined) return null;
  // Twice the action's own limit: the screen still gets to say why it gave up.
  if (nowMs - entry.at > 2 * NOTIFICATION_ACTION_TTL_MS) {
    pending.delete(key);
    return null;
  }
  return entry;
}

/** Drops the thread's action once it ran or was refused, unless a newer tap replaced it. */
export function clearPendingNotificationAction(
  ref: ScopedThreadRef,
  entry: PendingThreadAction,
): void {
  const key = scopedThreadKey(ref);
  if (pending.get(key) !== entry) return;
  pending.delete(key);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes whenever an action is set or cleared. */
export function usePendingNotificationActionVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/**
 * Drops every pending action: thread alerts stop when the workspace locks or its account signs
 * out, and a tap meant for that session must not run in the next one.
 */
export function clearPendingNotificationActions(): void {
  if (pending.size === 0) return;
  pending.clear();
  emit();
}

/** Test seam. */
export function resetPendingNotificationActionsForTests(): void {
  pending.clear();
  version = 0;
}
