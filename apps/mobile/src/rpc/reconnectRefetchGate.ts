// When a mounted screen reads its node data again after a reconnect.
//
// A reconnect registers a NEW connection object for the environment. Whatever
// the replaced client still owed a screen is dead and the node may have moved
// on, so every mounted screen's entry is fenced at once: a fetch in flight may
// have been issued by the replaced client, and only the fence keeps its late
// result out (staleTime alone would keep answering with what the dead client
// returned). Only the screen the person looks at reads again right away; a
// screen further down the navigation stack reads once when it comes back into
// focus, however many reconnects happened meanwhile.

/** The two cache operations the gate drives (a `MobileQuery`). */
export interface ReconnectRefetchTarget {
  readonly fence: (compositeKey: string | null) => void;
  readonly refresh: (compositeKey: string | null) => void;
}

export interface ReconnectRefetchGate<TConnection> {
  /**
   * The screen saw the environment's connection (on mount and on every change).
   * `focused`: the screen is the one on view now.
   */
  readonly onConnection: (
    connection: TConnection | null,
    focused: boolean,
    target: ReconnectRefetchTarget,
    compositeKey: string | null,
  ) => void;
  /** The screen came into focus. */
  readonly onFocus: (
    connected: boolean,
    target: ReconnectRefetchTarget,
    compositeKey: string | null,
  ) => void;
}

export function createReconnectRefetchGate<TConnection>(): ReconnectRefetchGate<TConnection> {
  // `undefined` until the first look: "not looked yet" is not "was offline".
  let last: TConnection | null | undefined;
  let owed = false;
  return {
    onConnection: (connection, focused, target, compositeKey) => {
      const previous = last;
      last = connection;
      // A new client after an old one, or the first client after the screen saw
      // the node offline (whatever it read then was an error or a saved copy).
      if (previous === undefined || previous === connection || connection === null) return;
      target.fence(compositeKey);
      owed = !focused;
      if (focused) target.refresh(compositeKey);
    },
    onFocus: (connected, target, compositeKey) => {
      // Offline at focus: the next connection is a reconnect of its own.
      if (!owed || !connected) return;
      owed = false;
      target.refresh(compositeKey);
    },
  };
}
