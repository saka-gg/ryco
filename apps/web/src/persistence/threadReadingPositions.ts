import type { TurnId } from "@ryco/contracts";
import {
  createThreadReadingPositionMemory,
  type RememberedThreadReadingAnchor,
  type ThreadReadingAnchor,
} from "@ryco/client-runtime/state/threads";

/**
 * Where each thread was left, for every connection mode, in memory for the
 * session. Two caches persist them: Hosted Web's remembered-browser cache and
 * the primary (local) environment's shell cache. Each restores its saved
 * anchors here and is told when one changes. Importing the timeline must not
 * initialize either cache, so they register themselves.
 */
export const threadReadingPositions = createThreadReadingPositionMemory();
let persistChange: (() => void) | null = null;
const changeListeners = new Set<() => void>();

/** Registers the hosted read cache's save, or `null` when it lets go. */
export function configureThreadReadingPositionPersistence(onChange: (() => void) | null): void {
  persistChange = onChange;
}

/** Tells `listener` whenever a remembered anchor changes. Returns an unsubscribe function. */
export function subscribeThreadReadingPositionChanges(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function notifyChange(): void {
  persistChange?.();
  for (const listener of changeListeners) listener();
}

export function readThreadReadingAnchor(threadKey: string): RememberedThreadReadingAnchor | null {
  return threadReadingPositions.read(threadKey);
}

export function rememberThreadReadingAnchor(
  threadKey: string,
  anchor: ThreadReadingAnchor,
  watchedTurnIds?: ReadonlySet<TurnId>,
): void {
  if (threadReadingPositions.rememberAnchor(threadKey, anchor, watchedTurnIds)) notifyChange();
}

export function rememberThreadReadingAtEnd(threadKey: string): void {
  if (threadReadingPositions.rememberAtEnd(threadKey)) notifyChange();
}
