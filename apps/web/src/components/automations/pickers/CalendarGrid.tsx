import { addDays, addMonths, dayStart } from "@ryco/shared/automationSchedule";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import {
  WEEK_COLUMNS,
  dayAriaLabel,
  monthGridDays,
  monthLastDay,
  monthStart,
  monthTitle,
  sameDateInMonth,
} from "./calendarDays";
import { onAnimationSettled, pickerEase, pickerMotionOn } from "./pickerMotion";

export interface CalendarGridProps {
  /** The chosen moment; its day is selected. */
  readonly value: number | null;
  /** Days before `min`'s day and after `max`'s day are unavailable. */
  readonly min: number | null;
  readonly max: number | null;
  readonly nowMs: number;
  /** Draws a band from this day to the selected (or hovered) day. */
  readonly rangeStart?: number | null | undefined;
  /** The smaller grid (the end picker's date). */
  readonly compact?: boolean | undefined;
  /** Read after "unavailable" for days past `max` (default "beyond the 90-day limit"). */
  readonly maxNote?: string | undefined;
  /** Focus the focused day on mount (the panel opening). */
  readonly autoFocus?: boolean | undefined;
  /** A day was chosen (click, Enter or Space on an available day). */
  readonly onPick: (dayMs: number) => void;
  /** The roving focus moved (keyboard, paging, a click). */
  readonly onFocusDayChange?: ((dayMs: number) => void) | undefined;
}

interface Slide {
  readonly id: number;
  readonly fromView: number;
  readonly dir: 1 | -1;
}

/**
 * The month grid (WAI-ARIA APG date grid): one Tab stop on the focused day;
 * ←/→ a day, ↑/↓ a week, Home/End the week's ends, PageUp/PageDown a month
 * (with Shift a year), Enter/Space choose. Days outside `min`…`max` stay
 * focusable and say why they are unavailable. Paging a month slides the weeks
 * sideways (not under reduced motion, nor on key repeat).
 */
export function CalendarGrid(props: CalendarGridProps) {
  const titleId = useId();
  const lo = props.min != null ? dayStart(props.min) : Number.NEGATIVE_INFINITY;
  const hi = props.max != null ? dayStart(props.max) : Number.POSITIVE_INFINITY;
  const today = dayStart(props.nowMs);

  const [focusDay, setFocusDay] = useState(() => {
    const start = props.value != null ? dayStart(props.value) : today;
    return Math.min(Math.max(start, lo), hi);
  });
  const [view, setViewState] = useState(() => monthStart(focusDay));
  const [hover, setHover] = useState<number | null>(null);
  const [slide, setSlide] = useState<Slide | null>(null);

  const weeksRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const ghostTitleRef = useRef<HTMLSpanElement>(null);
  const focusPendingRef = useRef(props.autoFocus === true);

  const pickable = (day: number) => day >= lo && day <= hi;
  const selected = props.value != null ? dayStart(props.value) : null;
  const rangeFrom = props.rangeStart != null ? dayStart(props.rangeStart) : null;
  const rangeTo = rangeFrom != null ? (hover ?? selected) : null;
  const range =
    rangeFrom != null && rangeTo != null
      ? { from: Math.min(rangeFrom, rangeTo), to: Math.max(rangeFrom, rangeTo) }
      : null;
  const lateNote = props.maxNote ?? "beyond the 90-day limit";

  const moveFocusTo = (day: number) => {
    setFocusDay(day);
    props.onFocusDayChange?.(day);
  };

  const changeView = (next: number, dir: 1 | -1, animate: boolean) => {
    if (next === view) return;
    if (animate && pickerMotionOn()) {
      setSlide({ id: (slide?.id ?? 0) + 1, fromView: view, dir });
    }
    setViewState(next);
  };

  const moveFocus = (target: number, animate: boolean) => {
    const loMonth = lo === Number.NEGATIVE_INFINITY ? lo : monthStart(lo);
    const hiMonth = hi === Number.POSITIVE_INFINITY ? hi : monthLastDay(hi);
    const day = Math.min(Math.max(dayStart(target), loMonth), hiMonth);
    moveFocusTo(day);
    if (rangeFrom != null) setHover(day);
    const month = monthStart(day);
    if (month !== view) changeView(month, month > view ? 1 : -1, animate);
    focusPendingRef.current = true;
  };

  const pick = (day: number) => {
    if (!pickable(day)) return;
    moveFocusTo(day);
    props.onPick(day);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const weekday = (new Date(focusDay).getDay() + 6) % 7;
    let target = focusDay;
    let animate = false;
    switch (event.key) {
      case "ArrowLeft":
        target = addDays(focusDay, -1);
        break;
      case "ArrowRight":
        target = addDays(focusDay, 1);
        break;
      case "ArrowUp":
        target = addDays(focusDay, -7);
        break;
      case "ArrowDown":
        target = addDays(focusDay, 7);
        break;
      case "Home":
        target = addDays(focusDay, -weekday);
        break;
      case "End":
        target = addDays(focusDay, 6 - weekday);
        break;
      case "PageUp":
        target = addMonths(focusDay, event.shiftKey ? -12 : -1);
        animate = !event.repeat;
        break;
      case "PageDown":
        target = addMonths(focusDay, event.shiftKey ? 12 : 1);
        animate = !event.repeat;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        pick(focusDay);
        return;
      default:
        return;
    }
    event.preventDefault();
    moveFocus(target, animate);
  };

  const onDayClick = (day: number) => {
    // A month change re-renders the days: keep focus on the clicked one.
    focusPendingRef.current = true;
    if (!pickable(day)) {
      moveFocusTo(day);
      return;
    }
    moveFocusTo(day);
    const month = monthStart(day);
    if (month !== view && !props.compact) changeView(month, month > view ? 1 : -1, true);
    pick(day);
  };

  const onDayHover = (day: number) => {
    if (rangeFrom == null || !pickable(day) || hover === day) return;
    setHover(day);
  };

  const page = (dir: 1 | -1) => {
    const next = addMonths(view, dir);
    moveFocusTo(sameDateInMonth(focusDay, next));
    changeView(monthStart(next), dir, true);
  };
  const prevDisabled = lo !== Number.NEGATIVE_INFINITY && view <= monthStart(lo);
  const nextDisabled = addMonths(view, 1) > hi;

  // Keyboard moves (and opening) put DOM focus on the focused day.
  useLayoutEffect(() => {
    if (!focusPendingRef.current) return;
    focusPendingRef.current = false;
    const weeks = weeksRef.current;
    const cell =
      weeks?.querySelector<HTMLElement>(`[data-ms="${focusDay}"]`) ??
      weeks?.querySelector<HTMLElement>('[role="gridcell"]');
    cell?.focus({ preventScroll: true });
  });

  const slideId = slide?.id ?? 0;
  const slideDir = slide?.dir ?? 1;
  useLayoutEffect(() => {
    if (slideId === 0) return;
    const ghost = ghostRef.current;
    const weeks = weeksRef.current;
    if (!ghost || !weeks) return;
    ghost.style.top = `${weeks.offsetTop}px`;
    const dx = 22 * slideDir;
    const out: Keyframe[] = [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: `translateX(${-dx}px)` },
    ];
    const into: Keyframe[] = [
      { opacity: 0, transform: `translateX(${dx}px)` },
      { opacity: 1, transform: "none" },
    ];
    const leaving = ghost.animate(out, { duration: 150, easing: "ease-out", fill: "forwards" });
    ghostTitleRef.current?.animate(out, { duration: 150, easing: "ease-out", fill: "forwards" });
    const easing = pickerEase();
    weeks.animate(into, { duration: 240, easing });
    titleRef.current?.animate(into, { duration: 240, easing });
    onAnimationSettled(leaving, () =>
      setSlide((current) => (current?.id === slideId ? null : current)),
    );
  }, [slideId, slideDir]);

  const renderWeeks = (viewMs: number, interactive: boolean) => {
    const days = monthGridDays(viewMs);
    const month = new Date(viewMs).getMonth();
    return [0, 1, 2, 3, 4, 5].map((row) => (
      <div
        key={row}
        role={interactive ? "row" : undefined}
        className={cn(
          "pk-row grid",
          props.compact ? "grid-cols-[repeat(7,32px)]" : "grid-cols-[repeat(7,36px)]",
        )}
      >
        {days.slice(row * 7, row * 7 + 7).map((day) => {
          const unavailable = day < lo ? "past" : day > hi ? "late" : null;
          const isToday = day === today;
          const inRange = range != null && day >= range.from && day <= range.to;
          return (
            <div
              key={day}
              role={interactive ? "gridcell" : undefined}
              className="pk-day"
              data-ms={interactive ? day : undefined}
              tabIndex={interactive ? (day === focusDay ? 0 : -1) : undefined}
              aria-disabled={unavailable != null}
              aria-selected={day === selected ? true : undefined}
              aria-current={isToday ? "date" : undefined}
              aria-label={
                interactive
                  ? dayAriaLabel(day, { today: isToday, unavailable, lateNote })
                  : undefined
              }
              data-out={new Date(day).getMonth() !== month ? "" : undefined}
              data-win-end={day === hi ? "" : undefined}
              data-range={inRange ? "" : undefined}
              data-range-start={inRange && day === range.from ? "" : undefined}
              data-range-end={inRange && day === range.to ? "" : undefined}
              onClick={interactive ? () => onDayClick(day) : undefined}
              onPointerOver={interactive ? () => onDayHover(day) : undefined}
            >
              <span className="pk-n">{new Date(day).getDate()}</span>
            </div>
          );
        })}
      </div>
    ));
  };

  return (
    <div
      className={cn("pk-cal", props.compact ? "px-2 pt-2 pb-1" : "px-3 pt-2.5 pb-2")}
      data-compact={props.compact ? "" : undefined}
    >
      <div className="mb-1 flex h-7 items-center gap-0.5 pl-1.5">
        <div
          id={titleId}
          aria-live="polite"
          className="pk-cal-title relative h-5 flex-1 overflow-hidden text-[13px] font-semibold tracking-[-0.005em]"
        >
          <span ref={titleRef}>{monthTitle(view)}</span>
          {slide ? (
            <span key={slide.id} ref={ghostTitleRef} aria-hidden>
              {monthTitle(slide.fromView)}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="pk-icon-btn"
          aria-label="Previous month"
          aria-disabled={prevDisabled}
          onClick={() => {
            if (!prevDisabled) page(-1);
          }}
        >
          <ChevronLeftIcon className="pk-ic" aria-hidden />
        </button>
        <button
          type="button"
          className="pk-icon-btn"
          aria-label="Next month"
          aria-disabled={nextDisabled}
          onClick={() => {
            if (!nextDisabled) page(1);
          }}
        >
          <ChevronRightIcon className="pk-ic" aria-hidden />
        </button>
      </div>
      <div className="relative" role="grid" aria-labelledby={titleId}>
        <div
          role="row"
          className={cn(
            "grid h-6 items-center text-center text-[11px] text-muted-foreground",
            props.compact ? "grid-cols-[repeat(7,32px)]" : "grid-cols-[repeat(7,36px)]",
          )}
        >
          {WEEK_COLUMNS.map((column) => (
            <span key={column.long} role="columnheader" aria-label={column.long}>
              <abbr title={column.long} className="no-underline">
                {column.short}
              </abbr>
            </span>
          ))}
        </div>
        <div
          ref={weeksRef}
          role="rowgroup"
          className="relative"
          onKeyDown={onKeyDown}
          onPointerLeave={rangeFrom != null ? () => setHover(null) : undefined}
        >
          {renderWeeks(view, true)}
        </div>
        {slide ? (
          <div key={slide.id} ref={ghostRef} className="pk-weeks-ghost" aria-hidden inert>
            {renderWeeks(slide.fromView, false)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
