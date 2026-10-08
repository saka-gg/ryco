export interface SingleFlightReader {
  /** Reads now, or once more after the read in flight when one is running. */
  readonly refresh: () => Promise<void>;
  /** Discards the read in flight and any trailing one (e.g. a fresher value arrived another way). */
  readonly invalidate: () => void;
  /** Nothing is published after this. */
  readonly stop: () => void;
}

/**
 * Single-flight refresh with a trailing read: concurrent refreshes coalesce
 * into at most one more read, and nothing is published after disposal or for
 * a read started before the last {@link SingleFlightReader.invalidate}.
 */
export function createSingleFlightReader<T>(input: {
  readonly read: () => Promise<T>;
  readonly onValue: (value: T) => void;
  readonly onError: (cause: unknown) => void;
}): SingleFlightReader {
  let stopped = false;
  let generation = 0;
  let running = false;
  let pending = false;
  const refresh = async () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    do {
      pending = false;
      const epoch = generation;
      try {
        const value = await input.read();
        if (!stopped && epoch === generation) input.onValue(value);
      } catch (cause) {
        if (!stopped && epoch === generation) input.onError(cause);
      }
      if (stopped) break;
    } while (pending);
    running = false;
  };
  return {
    refresh,
    invalidate: () => {
      generation++;
      pending = false;
    },
    stop: () => {
      stopped = true;
    },
  };
}
