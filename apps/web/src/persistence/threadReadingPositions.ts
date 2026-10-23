import type { TurnId } from "@ryco/contracts";
import {
  createThreadReadingPositionMemory,
  type RememberedThreadReadingAnchor,
  type ThreadReadingAnchor,
} from "@ryco/client-runtime/state/threads";

/**
 * Where each thread was left, for every connection mode, in memory for the
 * session. Hosted Web's remembered-browser cache is the only persistence: it
 * restores saved anchors here and is told when one changes. Importing the
 * timeline must not initialize hosted auth, so the cache registers itself.
 */
export const threadReadingPositions = createThreadReadingPositionMemory();
let persistChange: (() => void) | null = null;

/** Registers the hosted read cache's save, or `null` when it lets go. */
export function configureThreadReadingPositionPersistence(onChange: (() => void) | null): void {
  persistChange = onChange;
}

export function readThreadReadingAnchor(threadKey: string): RememberedThreadReadingAnchor | null {
  return threadReadingPositions.read(threadKey);
}

export function rememberThreadReadingAnchor(
  threadKey: string,
  anchor: ThreadReadingAnchor,
  watchedTurnIds?: ReadonlySet<TurnId>,
): void {
  if (threadReadingPositions.rememberAnchor(threadKey, anchor, watchedTurnIds)) {
    persistChange?.();
  }
}

export function rememberThreadReadingAtEnd(threadKey: string): void {
  if (threadReadingPositions.rememberAtEnd(threadKey)) persistChange?.();
}
