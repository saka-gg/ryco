import type { ExecutionEnvironmentDescriptor } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

/**
 * The hosted plane's primary-environment descriptor.
 *
 * The runtime owns teardown/turn-up ordering and hands this store the
 * descriptor for the currently selected Hub node; the app only stores and
 * publishes it. `createPrimaryConnection` reads it to decide whether a primary
 * connection can be built at all — `null` is the normal state, including for a
 * direct-only build, and must keep the direct plane's behavior unchanged.
 */

type Listener = () => void;

let descriptor: ExecutionEnvironmentDescriptor | null = null;
const listeners = new Set<Listener>();

export function writePrimaryEnvironmentDescriptor(
  next: ExecutionEnvironmentDescriptor | null,
): void {
  if (descriptor === next) return;
  descriptor = next;
  // Snapshot first: a listener may subscribe or unsubscribe while being
  // notified, and mutating the live set mid-walk would skip or re-run one.
  for (const listener of [...listeners]) listener();
}

export function readPrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  return descriptor;
}

export function subscribePrimaryEnvironmentDescriptor(listener: Listener): () => void {
  listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
  };
}

export function usePrimaryEnvironmentDescriptor(): ExecutionEnvironmentDescriptor | null {
  return useSyncExternalStore(
    subscribePrimaryEnvironmentDescriptor,
    readPrimaryEnvironmentDescriptor,
    () => null,
  );
}

/** Test seam: drop the descriptor and every listener between cases. */
export function resetPrimaryEnvironmentForTests(): void {
  descriptor = null;
  listeners.clear();
}
