/**
 * Whether the client of one connection says it is in the background (a hidden tab, a minimized
 * window, a phone about to suspend), from `server.setConnectionVisibility`. One per connection;
 * a new connection starts in the foreground. Streams read it to send less while nobody looks:
 * scoped terminal output pauses, and the thread list may widen its coalescing window
 * (`isBackground` is the hook for that). On return the client's resume paths catch up.
 */
export interface ConnectionVisibility {
  readonly isBackground: () => boolean;
  readonly set: (visibility: "foreground" | "background") => void;
  /** `listener` runs synchronously on every change, with the new state. */
  readonly subscribe: (listener: (background: boolean) => void) => () => void;
}

export function makeConnectionVisibility(): ConnectionVisibility {
  let background = false;
  const listeners = new Set<(background: boolean) => void>();
  return {
    isBackground: () => background,
    set: (visibility) => {
      const next = visibility === "background";
      if (next === background) return;
      background = next;
      for (const listener of [...listeners]) listener(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
