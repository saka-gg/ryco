export interface StartupTimingEntry {
  readonly phase: string;
  readonly elapsedMs: number;
  readonly deltaMs: number;
  readonly detail: string | undefined;
}

export interface StartupTiming {
  readonly mark: (phase: string, detail?: string) => StartupTimingEntry;
  /**
   * Record a phase that happened at `atMs` (same clock as `now`), e.g. before
   * this timing existed. Its elapsed time is negative when it precedes the
   * origin.
   */
  readonly markAt: (phase: string, atMs: number, detail?: string) => StartupTimingEntry;
  readonly entries: () => ReadonlyArray<StartupTimingEntry>;
  /** The clock reading this timing measures from. */
  readonly origin: number;
}

export function createStartupTiming(options: { readonly now?: () => number } = {}): StartupTiming {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let previousAt = startedAt;
  const entries: StartupTimingEntry[] = [];

  const record = (phase: string, markedAt: number, detail: string | undefined) => {
    const entry: StartupTimingEntry = {
      phase,
      elapsedMs: markedAt - startedAt,
      deltaMs: markedAt - previousAt,
      detail,
    };
    previousAt = Math.max(previousAt, markedAt);
    entries.push(entry);
    return entry;
  };

  return {
    mark: (phase, detail) => record(phase, now(), detail),
    markAt: (phase, atMs, detail) => record(phase, atMs, detail),
    entries: () => [...entries],
    origin: startedAt,
  };
}

export function formatStartupTimingEntry(entry: StartupTimingEntry): string {
  const base = `startup timing phase=${entry.phase} elapsedMs=${Math.round(entry.elapsedMs)} deltaMs=${Math.round(entry.deltaMs)}`;
  return entry.detail ? `${base} ${entry.detail}` : base;
}
