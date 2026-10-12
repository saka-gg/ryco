/**
 * Renderer startup marks and measures (`ryco:startup:*`), reported to the main
 * process so every launch logs its time-to-usable and time-to-painted shell in
 * desktop-main.log next to the backend's startup phases, not only the runs with
 * startup timing output enabled. Used by the preload (observer) and main
 * (validation and formatting); no Electron or DOM imports.
 */
export const DESKTOP_STARTUP_MARKS_CHANNEL = "desktop:startup-marks";

const STARTUP_MARK_PREFIX = "ryco:startup:";
export const SHELL_USABLE_STARTUP_MARK = `${STARTUP_MARK_PREFIX}primary-shell-usable`;
/** Marked once the frame holding the bootstrapped sidebar was presented. */
export const SHELL_PAINTED_STARTUP_MARK = `${STARTUP_MARK_PREFIX}primary-shell-painted`;
/**
 * How long after the shell became usable the painted report waits. Routes
 * without the sidebar never paint it; the report then carries what exists.
 */
export const SHELL_PAINTED_REPORT_TIMEOUT_MS = 5_000;
const MAX_REPORTED_MARKS = 64;
const MARK_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface RendererStartupMark {
  /** Without the `ryco:startup:` prefix. */
  readonly name: string;
  /** Milliseconds since the page's navigation start. */
  readonly startMs: number;
  readonly durationMs: number;
}

interface PerformanceEntryLike {
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
}

interface PerformanceLike {
  getEntries(): ReadonlyArray<PerformanceEntryLike>;
}

interface PerformanceObserverLike {
  observe(options: { readonly type: string; readonly buffered?: boolean }): void;
  disconnect(): void;
}

type PerformanceObserverConstructorLike = new (
  callback: (list: { getEntries(): ReadonlyArray<PerformanceEntryLike> }) => void,
) => PerformanceObserverLike;

function readRendererStartupEntries(performance: PerformanceLike): RendererStartupMark[] {
  return performance
    .getEntries()
    .filter((entry) => entry.name.startsWith(STARTUP_MARK_PREFIX))
    .map((entry) => ({
      name: entry.name.slice(STARTUP_MARK_PREFIX.length),
      startMs: Math.round(entry.startTime),
      durationMs: Math.round(entry.duration),
    }));
}

export function collectRendererStartupMarks(performance: PerformanceLike): RendererStartupMark[] {
  return readRendererStartupEntries(performance).slice(0, MAX_REPORTED_MARKS);
}

export type RendererStartupReportPhase = "shell-usable" | "shell-painted";

export interface RendererStartupReport {
  /**
   * `shell-usable`: the primary shell became usable (all entries so far).
   * `shell-painted`: the sidebar frame was presented, or the wait for it ended
   * (only entries not reported before).
   */
  readonly phase: RendererStartupReportPhase;
  readonly marks: ReadonlyArray<RendererStartupMark>;
}

const markKey = (mark: RendererStartupMark) => `${mark.name}@${mark.startMs}+${mark.durationMs}`;

/**
 * Report the page's startup entries twice: when the shell-usable mark appears,
 * and again when the shell-painted mark appears (bounded by `paintedTimeoutMs`)
 * with the entries recorded since, such as the paint measures. Returns a
 * disposer. Never throws: instrumentation must not affect startup.
 */
export function observeRendererStartupMarks(input: {
  readonly performance: PerformanceLike;
  readonly PerformanceObserver: PerformanceObserverConstructorLike | undefined;
  readonly report: (report: RendererStartupReport) => void;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly paintedTimeoutMs?: number;
}): () => void {
  const schedule = input.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const cancel =
    input.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const reported = new Set<string>();
  let usableReported = false;
  let done = false;
  let observer: PerformanceObserverLike | null = null;
  let paintedTimer: unknown = null;

  const hasEntry = (name: string) =>
    input.performance.getEntries().some((entry) => entry.name === name);
  const stop = () => {
    done = true;
    observer?.disconnect();
    if (paintedTimer !== null) cancel(paintedTimer);
    paintedTimer = null;
  };
  const send = (phase: RendererStartupReportPhase) => {
    const marks = readRendererStartupEntries(input.performance)
      .filter((mark) => !reported.has(markKey(mark)))
      .slice(0, MAX_REPORTED_MARKS);
    for (const mark of marks) reported.add(markKey(mark));
    if (phase === "shell-painted" && marks.length === 0) return;
    try {
      input.report({ phase, marks });
    } catch {
      // Reporting is best effort.
    }
  };
  const reportPainted = () => {
    if (done) return;
    stop();
    send("shell-painted");
  };
  const check = () => {
    if (done) return;
    if (!usableReported && hasEntry(SHELL_USABLE_STARTUP_MARK)) {
      usableReported = true;
      send("shell-usable");
      paintedTimer = schedule(
        reportPainted,
        input.paintedTimeoutMs ?? SHELL_PAINTED_REPORT_TIMEOUT_MS,
      );
    }
    if (usableReported && hasEntry(SHELL_PAINTED_STARTUP_MARK)) reportPainted();
  };

  try {
    check();
    if (done) return () => undefined;
    if (!input.PerformanceObserver) {
      // No observer: what was already marked is all this page reports.
      if (usableReported) reportPainted();
      return () => undefined;
    }
    observer = new input.PerformanceObserver(check);
    observer.observe({ type: "mark", buffered: true });
  } catch {
    stop();
    return () => undefined;
  }
  return stop;
}

/** Validate marks received over IPC from a renderer. */
export function parseRendererStartupMarks(value: unknown): RendererStartupMark[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_MARKS) return null;
  const marks: RendererStartupMark[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { name, startMs, durationMs } = entry as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      !MARK_NAME_PATTERN.test(name) ||
      typeof startMs !== "number" ||
      !Number.isFinite(startMs) ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs)
    ) {
      return null;
    }
    marks.push({ name, startMs: Math.round(startMs), durationMs: Math.round(durationMs) });
  }
  return marks;
}

/** Validate a startup report received over IPC from a renderer. */
export function parseRendererStartupReport(value: unknown): RendererStartupReport | null {
  if (typeof value !== "object" || value === null) return null;
  const { phase, marks } = value as Record<string, unknown>;
  if (phase !== "shell-usable" && phase !== "shell-painted") return null;
  const parsed = parseRendererStartupMarks(marks);
  return parsed === null ? null : { phase, marks: parsed };
}

/** One log detail string: `name=startMs` for marks, `name=startMs+durationMs` for measures. */
export function formatRendererStartupMarks(marks: ReadonlyArray<RendererStartupMark>): string {
  return marks
    .map((mark) =>
      mark.durationMs > 0
        ? `${mark.name}=${mark.startMs}+${mark.durationMs}`
        : `${mark.name}=${mark.startMs}`,
    )
    .join(" ");
}
