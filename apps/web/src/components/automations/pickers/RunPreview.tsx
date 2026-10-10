import {
  type ScheduleInput,
  formatDateTime,
  formatDay,
  formatShortDateTime,
  formatTime,
  rel,
  runPreviewNote,
  runPreviewWindow,
  sameDay,
  scheduleToMs,
} from "@ryco/shared/automationSchedule";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { Crossfade } from "./Crossfade";
import { onAnimationSettled, pickerEase, pickerMotionOn } from "./pickerMotion";

const ROW_HEIGHT = 29;
/** Changes closer together than this (stepping, typing) repaint without motion. */
const BURST_MS = 140;
const ANNOUNCE_DELAY_MS = 500;
const COUNT_TWEEN_MS = 320;

interface PreviewRow {
  readonly ms: number;
  readonly day: string;
  readonly time: string;
  readonly rel: string;
}

interface LeavingRow extends PreviewRow {
  readonly id: number;
}

interface ListState {
  readonly key: string;
  readonly rows: ReadonlyArray<PreviewRow>;
  readonly leaving: ReadonlyArray<LeavingRow>;
  readonly seq: number;
}

export interface RunPreviewProps {
  readonly schedule: ScheduleInput | null;
  readonly nowMs: number;
  readonly title?: string | undefined;
  /**
   * The quiet note about approvals: "auto" mentions the approval load only
   * when runs come often; true always says runs wait; false never does. A
   * day-based interval crossing a clock change says that instead.
   */
  readonly approvals?: "auto" | boolean | undefined;
  /** How many upcoming runs show (the list's height); default 5. */
  readonly visibleRows?: number | undefined;
  readonly className?: string | undefined;
}

/**
 * The next runs: up to five (the day and how far off only on a day's first
 * row), the total with the last run, a strip of ticks from the first run to
 * the last with the next five marked (it steps aside when ticks would crowd
 * under 3 px), and one quiet note — a clock change for day-based intervals,
 * else the approval load. Rows that stay glide to their new place, new ones
 * rise in, gone ones fade; the total counts to its new value. Screen readers
 * get one settled read-back, never the per-minute repaints.
 */
export function RunPreview(props: RunPreviewProps) {
  const { schedule, nowMs } = props;
  const title = props.title ?? "Next runs";
  const scheduleMs = schedule ? scheduleToMs(schedule) : null;
  const preview = runPreviewWindow(scheduleMs, nowMs);
  const note = runPreviewNote(scheduleMs, nowMs, props.approvals ?? "auto");
  const sig = !scheduleMs
    ? ""
    : scheduleMs.kind === "once"
      ? `once|${scheduleMs.runAt}`
      : `interval|${scheduleMs.startsAt}|${scheduleMs.intervalMs}|${scheduleMs.endsAt}`;

  const rows: PreviewRow[] = (preview?.next ?? []).map((ms, index, next) => {
    const previous = index > 0 ? next[index - 1] : undefined;
    const sameDayAsPrevious = previous != null && sameDay(previous, ms);
    return {
      ms,
      day: sameDayAsPrevious ? "" : formatDay(ms, nowMs),
      time: formatTime(ms),
      rel: sameDayAsPrevious ? "" : rel(ms, nowMs),
    };
  });
  const rowsKey = rows.map((row) => row.ms).join(",");

  // Rows that left the list fade out where they were.
  const [list, setList] = useState<ListState>(() => ({ key: rowsKey, rows, leaving: [], seq: 0 }));
  if (list.key !== rowsKey) {
    const kept = new Set(rows.map((row) => row.ms));
    const gone: LeavingRow[] = list.rows
      .filter((row) => !kept.has(row.ms))
      .map((row, index) => ({
        id: list.seq + index + 1,
        ms: row.ms,
        day: row.day,
        time: row.time,
        rel: row.rel,
      }));
    setList({
      key: rowsKey,
      rows,
      leaving: [...list.leaving, ...gone],
      seq: list.seq + gone.length,
    });
  }

  // The total counts from its old value to the new one.
  const count = preview?.count ?? 0;
  const [counted, setCounted] = useState<{ readonly count: number; readonly from: number | null }>(
    () => ({ count, from: null }),
  );
  if (counted.count !== count) setCounted({ count, from: counted.count });

  const rootRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const ticksRef = useRef<HTMLDivElement | null>(null);
  const topsRef = useRef(new Map<number, number>());
  const lastPaintRef = useRef<{ sig: string; now: number; at: number } | null>(null);
  const animateRef = useRef(false);
  const fadingRef = useRef(new Set<number>());
  const [width, setWidth] = useState(0);
  const [announced, setAnnounced] = useState("");

  // Whether this repaint may move: the schedule changed (and not in a burst
  // of changes), or time passed a run. A first paint or a resize never moves.
  useLayoutEffect(() => {
    const last = lastPaintRef.current;
    const at = performance.now();
    lastPaintRef.current = { sig, now: nowMs, at };
    animateRef.current =
      last != null &&
      pickerMotionOn() &&
      (last.sig !== sig ? at - last.at >= BURST_MS : last.now !== nowMs);
  }, [sig, nowMs]);

  // FLIP the rows: kept rows glide, new rows rise in, gone rows fade where they were.
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const listTop = element.getBoundingClientRect().top;
    const before = topsRef.current;
    const animate = animateRef.current;
    for (const leaving of list.leaving) {
      if (fadingRef.current.has(leaving.id)) continue;
      const row = element.querySelector<HTMLElement>(`[data-leaving-id="${leaving.id}"]`);
      if (!row) continue;
      fadingRef.current.add(leaving.id);
      row.style.top = `${before.get(leaving.ms) ?? 0}px`;
      const fade = row.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: animate ? 160 : 0,
        fill: "forwards",
      });
      onAnimationSettled(fade, () => {
        fadingRef.current.delete(leaving.id);
        setList((current) => ({
          ...current,
          leaving: current.leaving.filter((candidate) => candidate.id !== leaving.id),
        }));
      });
    }
    const after = new Map<number, number>();
    const easing = animate ? pickerEase() : "";
    list.rows.forEach((kept, index) => {
      const row = element.querySelector<HTMLElement>(`[data-row-ms="${kept.ms}"]`);
      if (!row) return;
      const top = row.getBoundingClientRect().top - listTop;
      after.set(kept.ms, top);
      const was = before.get(kept.ms);
      if (animate && was == null) {
        row.animate(
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 260, delay: index * 24, easing, fill: "backwards" },
        );
      } else if (animate && was != null && Math.abs(was - top) > 0.5) {
        row.animate([{ transform: `translateY(${was - top}px)` }, { transform: "none" }], {
          duration: 300,
          easing,
        });
      }
    });
    topsRef.current = after;
  }, [list]);

  // The strip's width decides where ticks fall and whether they would crowd.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setWidth(root.clientWidth));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const first = preview?.first ?? null;
  const last = preview?.last ?? null;
  const intervalMs = scheduleMs?.kind === "fixed-interval" ? scheduleMs.intervalMs : 0;
  const span =
    preview && preview.kind !== "once" && count > 1 && first != null && last != null
      ? last - first
      : 0;
  const period = span > 0 ? (intervalMs / span) * (width - 1) : 0;
  const stripShown = span > 0 && width > 0 && period >= 3;
  const marks =
    stripShown && first != null
      ? (preview?.next ?? []).map((ms, index) => ({
          ms,
          x: ((ms - first) / span) * (width - 1),
          next: index === 0,
        }))
      : [];

  // Ticks re-space smoothly when the schedule changes, instantly otherwise.
  useLayoutEffect(() => {
    const ticks = ticksRef.current;
    if (!ticks || !stripShown) return;
    const size = `${period}px 100%`;
    if (ticks.style.backgroundSize === size) return;
    if (animateRef.current) {
      ticks.style.backgroundSize = size;
      return;
    }
    ticks.style.transition = "none";
    ticks.style.backgroundSize = size;
    void ticks.offsetWidth;
    ticks.style.transition = "";
  }, [period, stripShown]);

  // One settled read-back for screen readers.
  const at = (ms: number | null) => (ms != null ? formatDateTime(ms, nowMs) : "");
  const readBack = !preview
    ? "No schedule"
    : !count
      ? "No runs left"
      : preview.kind === "once" || count === 1
        ? `Runs once, ${at(first)}`
        : `${count.toLocaleString("en-US")} runs, first ${at(first)}, last ${at(last)}`;
  const spoken = note ? `${readBack}. ${note}` : `${readBack}.`;
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(spoken), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [spoken]);

  const tail =
    preview && count > 1 && last != null ? ` · last ${formatShortDateTime(last, nowMs)}` : "";
  const totalKey = !preview ? "none" : `${count}|${tail}`;
  const total = !preview ? (
    "No schedule"
  ) : count === 0 ? (
    "No runs left"
  ) : preview.kind === "once" || count === 1 ? (
    "Runs once"
  ) : (
    <>
      <CountUp value={count} from={counted.from} motionRef={animateRef} /> runs{tail}
    </>
  );
  const empty = preview != null && count === 0;

  return (
    <section
      ref={rootRef}
      aria-label={title}
      className={cn("pk flex min-w-0 flex-col", props.className)}
      data-empty={empty ? "" : undefined}
    >
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span data-total="">
          <Crossfade layerKey={totalKey} className="pk-pv-total inline-grid justify-items-end tnum">
            {total}
          </Crossfade>
        </span>
      </div>
      <ol
        ref={listRef}
        className="pk-pv-list relative m-0 list-none overflow-hidden p-0"
        style={{ height: (props.visibleRows ?? 5) * ROW_HEIGHT }}
        data-empty={empty ? "Nothing left to run in this window" : undefined}
      >
        {list.leaving.map((row) => (
          <li
            key={`leaving-${row.id}`}
            className="pk-pv-row is-leaving"
            data-leaving-id={row.id}
            data-ms={row.ms}
            aria-hidden
          >
            <PreviewCells row={row} />
          </li>
        ))}
        {rows.map((row) => (
          <li key={row.ms} className="pk-pv-row" data-row-ms={row.ms}>
            <PreviewCells row={row} />
          </li>
        ))}
      </ol>
      {stripShown ? (
        <div className="relative mt-3 h-5" aria-hidden>
          <div ref={ticksRef} className="pk-pv-ticks" />
          {marks.map((mark) => (
            <i
              key={mark.ms}
              className="pk-pv-mark"
              data-next={mark.next ? "" : undefined}
              style={{ left: mark.x }}
            />
          ))}
        </div>
      ) : null}
      {note ? (
        <p className="mt-2 mb-0 text-xs leading-[1.45] text-muted-foreground">{note}</p>
      ) : null}
      <span className="sr-only" role="status">
        {announced}
      </span>
    </section>
  );
}

/**
 * The total's number. A new total eases up (or down) from the old one when
 * the repaint may move; it renders from its own state, so only this `<b>`
 * repaints per frame. The number is right from the first paint: the tween
 * starts after RunPreview has decided whether this repaint may move, while
 * the Crossfade layer it sits in is still fading in.
 */
function CountUp(props: {
  readonly value: number;
  readonly from: number | null;
  readonly motionRef: { readonly current: boolean };
}) {
  const { value, from, motionRef } = props;
  const [tween, setTween] = useState<{
    readonly from: number;
    readonly to: number;
    readonly shown: number;
  } | null>(null);
  useEffect(() => {
    if (from == null || from === value || from <= 1 || value <= 1 || !motionRef.current) return;
    const started = performance.now();
    let frame = 0;
    const step = (time: number) => {
      const progress = Math.min(1, Math.max(0, (time - started) / COUNT_TWEEN_MS));
      setTween({ from, to: value, shown: from + (value - from) * (1 - (1 - progress) ** 3) });
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [from, value, motionRef]);
  const shown = tween != null && tween.from === from && tween.to === value ? tween.shown : value;
  return <b>{Math.round(shown).toLocaleString("en-US")}</b>;
}

function PreviewCells(props: { readonly row: PreviewRow }) {
  return (
    <>
      <span className="truncate text-muted-foreground">{props.row.day}</span>
      <span className="font-medium tnum">{props.row.time}</span>
      <span className="text-right text-xs text-muted-foreground tnum">{props.row.rel}</span>
    </>
  );
}
