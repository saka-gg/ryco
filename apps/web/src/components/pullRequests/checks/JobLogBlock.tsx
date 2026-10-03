import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import {
  JOB_LOG_TAIL_LINES,
  jobLogTail,
  linkifyJobLogLine,
  type JobLogLine,
  type JobLogSegment,
  type JobLogTone,
} from "./jobLog";

/**
 * A step's log: a bordered, monospace block that scrolls on its own (both
 * ways — long lines never widen the page) and opens at its tail, where
 * failures are. `path:line` references to changed files are links into Files.
 */

const TONE_CLASS: Record<JobLogTone, string> = {
  plain: "text-foreground/80",
  error: "bg-destructive/[0.06] text-destructive-foreground",
  warning: "text-warning-foreground",
  command: "text-foreground",
  muted: "text-muted-foreground",
};

const LINE_NUMBER_FORMAT = new Intl.NumberFormat();

export interface JobLogBlockProps {
  /** The step's own lines. */
  readonly lines: ReadonlyArray<JobLogLine>;
  /** Every line of the job, for "Show full log". */
  readonly allLines: ReadonlyArray<JobLogLine>;
  /** The host cut the log short (size cap). */
  readonly truncated: boolean;
  readonly resolvePath: (raw: string) => string | null;
  readonly onRevealFile: (path: string, line: number) => void;
}

export const JobLogBlock = memo(function JobLogBlock(props: JobLogBlockProps) {
  const [full, setFull] = useState(false);
  const source = full ? props.allLines : props.lines;
  const tail = useMemo(() => {
    const { lines, firstLineNumber } = jobLogTail(source);
    return {
      firstLineNumber,
      rows: lines.map((line, index) => ({ number: firstLineNumber + index, line })),
    };
  }, [source]);
  const hiddenLines = tail.firstLineNumber - 1;
  const canShowFull = props.allLines.length > props.lines.length;

  // Open at the tail: on first paint and whenever the shown range changes.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && tail.rows.length > 0) element.scrollTop = element.scrollHeight;
  }, [tail]);

  return (
    <div className="min-w-0">
      <div
        ref={scrollRef}
        role="log"
        aria-label={full ? "Job log" : "Step log"}
        tabIndex={0}
        className="max-h-[min(24rem,55vh)] overflow-auto rounded-md border border-border/70 bg-muted/25 py-2 font-mono text-[11.5px] leading-[18px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted/15"
      >
        <div className="w-max min-w-full">
          {tail.rows.length === 0 ? (
            <p className="px-3 font-sans text-xs text-muted-foreground">No output.</p>
          ) : (
            tail.rows.map((row) => (
              <LogLine
                // Lines never reorder within one range; the number is their identity.
                key={row.number}
                number={row.number}
                line={row.line}
                resolvePath={props.resolvePath}
                onRevealFile={props.onRevealFile}
              />
            ))
          )}
        </div>
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-x-1.5 pt-1 text-xs text-muted-foreground">
        {hiddenLines > 0 ? (
          <span className="tabular-nums">
            Last {LINE_NUMBER_FORMAT.format(JOB_LOG_TAIL_LINES)} of{" "}
            {LINE_NUMBER_FORMAT.format(source.length)} lines
          </span>
        ) : null}
        {hiddenLines > 0 && (canShowFull || full) ? <span aria-hidden>·</span> : null}
        {canShowFull || full ? (
          <button
            type="button"
            onClick={() => setFull((value) => !value)}
            className="rounded-[4px] font-medium text-foreground/80 underline-offset-2 outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {full ? "Show this step only" : "Show full log"}
          </button>
        ) : null}
        {props.truncated ? <span className="ml-auto">The host cut this log short.</span> : null}
      </div>
    </div>
  );
});

/** Each segment with where it starts in the line (its key). */
function withStarts(
  segments: ReadonlyArray<JobLogSegment>,
): ReadonlyArray<{ readonly segment: JobLogSegment; readonly start: number }> {
  const out: Array<{ segment: JobLogSegment; start: number }> = [];
  let start = 0;
  for (const segment of segments) {
    out.push({ segment, start });
    start += segment.text.length;
  }
  return out;
}

const LogLine = memo(function LogLine(props: {
  readonly number: number;
  readonly line: JobLogLine;
  readonly resolvePath: (raw: string) => string | null;
  readonly onRevealFile: (path: string, line: number) => void;
}) {
  const segments = useMemo(
    () => withStarts(linkifyJobLogLine(props.line.text, props.resolvePath)),
    [props.line.text, props.resolvePath],
  );
  return (
    <div className={cn("flex pr-4 whitespace-pre", TONE_CLASS[props.line.tone])}>
      <span
        aria-hidden
        className="w-11 shrink-0 pr-3 text-right text-[10.5px] text-muted-foreground/55 tabular-nums select-none"
      >
        {props.number}
      </span>
      <span>
        {segments.map(({ segment, start }) =>
          segment.kind === "text" ? (
            segment.text || (start === 0 ? " " : "")
          ) : (
            <button
              key={start}
              type="button"
              title={`Open ${segment.path}:${segment.line} in Files`}
              onClick={() => props.onRevealFile(segment.path, segment.line)}
              className="cursor-pointer rounded-[3px] text-info-foreground underline decoration-info-foreground/40 underline-offset-2 outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring"
            >
              {segment.text}
            </button>
          ),
        )}
      </span>
    </div>
  );
});
