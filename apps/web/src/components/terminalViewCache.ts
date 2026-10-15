import type { TerminalCursor, TerminalEvent } from "@ryco/contracts";
import { isTerminalReplayEvent } from "@ryco/client-runtime/state/terminal";
import { MAX_TERMINALS_PER_GROUP } from "@ryco/client-runtime/state/threads";

/**
 * Keeps recently closed terminal views (xterm instance, its DOM and parse
 * state) alive so closing the drawer, switching workspace tabs or moving focus
 * between panes does not throw away the screen. Remounting reattaches the
 * element and applies only the events it missed, instead of rebuilding xterm
 * and re-parsing the whole scrollback (up to 2 MiB).
 *
 * Each view retains up to 5,000 scrollback lines plus DOM, so only a few stay
 * cached; the least recently detached one is disposed first. The bound covers a
 * full split group, so closing and reopening a drawer showing one keeps every
 * view.
 */

export const MAX_CACHED_TERMINAL_VIEWS = MAX_TERMINALS_PER_GROUP;

export interface CachedTerminalView<Terminal extends { dispose(): void }, State> {
  readonly launchKey: string;
  readonly terminal: Terminal;
  readonly element: HTMLElement;
  /** Owner-specific parse state, restored as-is on reattach. */
  readonly state: State;
  /** Id of the last terminal store event the view applied. */
  readonly lastAppliedTerminalEventId: number;
  /** Cursor of the last output the view applied. */
  readonly appliedCursor: TerminalCursor | undefined;
}

export function terminalViewCacheKey(
  environmentId: string,
  threadId: string,
  terminalId: string,
): string {
  return JSON.stringify([environmentId, threadId, terminalId]);
}

export function createTerminalViewCache<Terminal extends { dispose(): void }, State>(
  maxEntries = MAX_CACHED_TERMINAL_VIEWS,
) {
  // Insertion-ordered: the first entry is the least recently detached view.
  const views = new Map<string, CachedTerminalView<Terminal, State>>();

  let trimScheduled = false;

  const dispose = (view: CachedTerminalView<Terminal, State>) => {
    view.element.remove();
    view.terminal.dispose();
  };

  const trim = () => {
    trimScheduled = false;
    while (views.size > maxEntries) {
      const oldestKey = views.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = views.get(oldestKey);
      views.delete(oldestKey);
      if (oldest) dispose(oldest);
    }
  };

  return {
    /**
     * Detaches and keeps a view. The oldest views beyond the bound are disposed
     * once the current task's synchronous work is done: React runs every
     * effect cleanup of a commit before its mounts, so views swapped out and
     * back in by one commit (a pane focus change, a split group remount) are
     * taken before the bound applies.
     */
    stash(key: string, view: CachedTerminalView<Terminal, State>): void {
      view.element.remove();
      const previous = views.get(key);
      if (previous && previous.terminal !== view.terminal) dispose(previous);
      views.delete(key);
      views.set(key, view);
      if (views.size > maxEntries && !trimScheduled) {
        trimScheduled = true;
        queueMicrotask(trim);
      }
    },
    /**
     * Removes and returns the view for `key` when it was launched the same way;
     * a view of a different launch is disposed, since the server restarts that
     * session anyway.
     */
    take(key: string, launchKey: string): CachedTerminalView<Terminal, State> | null {
      const view = views.get(key);
      if (!view) return null;
      views.delete(key);
      if (view.launchKey !== launchKey) {
        dispose(view);
        return null;
      }
      return view;
    },
    discard(key: string): void {
      const view = views.get(key);
      if (!view) return;
      views.delete(key);
      dispose(view);
    },
    size(): number {
      return views.size;
    },
    clear(): void {
      for (const view of views.values()) dispose(view);
      views.clear();
    },
  };
}

/**
 * Events a reattached view still has to apply, or `null` when it cannot catch
 * up from the client buffer and must hydrate from `terminal.open` instead:
 * the buffer may have dropped events it never saw, the session ended
 * meanwhile (an open restarts an ended session, which a replayed exit would
 * not show), or a reconnect replay stands for output that never reached the
 * buffer (the open then asks for the history after the view's cursor). The
 * open that follows still verifies the result against the server's cursor,
 * so an empty buffer only skips work that is not needed.
 */
export function resolveTerminalViewCatchUp<Entry extends { id: number; event: TerminalEvent }>(
  entries: ReadonlyArray<Entry>,
  lastAppliedTerminalEventId: number,
): ReadonlyArray<Entry> | null {
  const first = entries[0];
  if (first === undefined) return [];
  // Ids are global and the buffer drops its oldest entries, so only a buffer
  // still holding the last applied event proves nothing in between is missing.
  if (lastAppliedTerminalEventId <= 0 || first.id > lastAppliedTerminalEventId) return null;
  const pending = entries.filter((entry) => entry.id > lastAppliedTerminalEventId);
  if (
    pending.some(
      (entry) =>
        entry.event.type === "exited" ||
        entry.event.type === "error" ||
        isTerminalReplayEvent(entry.event),
    )
  ) {
    return null;
  }
  return pending;
}

/** Whether a view that applied output up to `appliedCursor` already shows `snapshotCursor`. */
export function isTerminalViewCurrent(
  snapshotCursor: TerminalCursor | undefined,
  appliedCursor: TerminalCursor | undefined,
): boolean {
  return (
    snapshotCursor !== undefined &&
    appliedCursor !== undefined &&
    snapshotCursor.generation === appliedCursor.generation &&
    snapshotCursor.sequence <= appliedCursor.sequence
  );
}

/**
 * Whether the terminal store's event id counter went backwards, which only a
 * reset of the store does (hosted account teardown). Views kept from before
 * belong to the dropped session and track ids from the old sequence.
 */
export function isTerminalEventIdSpaceReset(
  previousNextEventId: number,
  nextEventId: number,
): boolean {
  return nextEventId < previousNextEventId;
}
