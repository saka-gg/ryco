import { minutesOf, sameDay, withMinutes } from "@ryco/shared/automationSchedule";
import { parseTimeOfDay } from "@ryco/shared/automationWhenParser";
import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { pickerMotionOn } from "./pickerMotion";

const SLOT_HEIGHT = 28;
const TIME_HINT = "Try 9:30, 21:05 or 9pm";

const pad2 = (n: number) => String(n).padStart(2, "0");
/** "09:30" for minutes after midnight. */
export const formatMinutes = (minutes: number) =>
  `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

/** The row sits fourth from the top: whole rows above and below it. */
function scrollRowIntoPlace(list: HTMLElement | null, row: HTMLElement | null, smooth: boolean) {
  if (!row || !list) return;
  const top = Math.max(0, row.offsetTop - 3 * SLOT_HEIGHT);
  list.scrollTo({ top, behavior: smooth && pickerMotionOn() ? "smooth" : "auto" });
}

const QUARTERS: ReadonlyArray<number> = Array.from({ length: 96 }, (_, i) => i * 15);

export type TimeColumnSay = (text: string | null, tone?: "info" | "warn") => void;

export interface TimeColumnProps {
  /** Local midnight of the day the times are for. */
  readonly day: number;
  readonly value: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly nowMs: number;
  /** A usable time was chosen (minutes after midnight). */
  readonly onPick: (minutes: number) => void;
  /** An unusable time was chosen; the panel explains it. */
  readonly onReject: (ms: number) => void;
  /** Messages go to the panel's footer, never into this narrow column. */
  readonly say: TimeColumnSay;
  /**
   * Changes when the selected time should come into view. With `scrollForce`
   * the list scrolls even while the user is browsing it.
   */
  readonly scrollKey: string;
  readonly scrollForce?: boolean | undefined;
}

/**
 * The calendar's time column: a typed field heading 15-minute rows (plus the
 * chosen time when it is off the quarter). Exactly eight whole rows show and
 * snap; the selected row sits fourth from the top. Once the user scrolls,
 * hovers or arrows through the list, only their own picks move it. ↑/↓,
 * PageUp/PageDown and Home/End move between available times, Enter/Space
 * choose, a digit types into the field.
 */
export function TimeColumn(props: TimeColumnProps) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const browsedRef = useRef(false);
  const hoveringRef = useRef(false);
  const scrolledKeyRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);

  const selected =
    props.value != null && sameDay(props.value, props.day) ? minutesOf(props.value) : null;
  const enabledAt = (minutes: number) => {
    const ms = withMinutes(props.day, minutes);
    return !(
      (props.min != null && (ms < props.min || ms <= props.nowMs)) ||
      (props.max != null && ms > props.max)
    );
  };
  const rows: Array<{ readonly minutes: number; readonly custom: boolean }> = [];
  for (const minutes of QUARTERS) {
    rows.push({ minutes, custom: false });
    if (selected != null && selected % 15 !== 0 && Math.floor(selected / 15) * 15 === minutes) {
      rows.push({ minutes: selected, custom: true });
    }
  }
  const tabStop =
    focused ??
    (selected != null && enabledAt(selected)
      ? selected
      : (rows.find((row) => enabledAt(row.minutes))?.minutes ?? null));

  const optionId = (minutes: number, custom: boolean) => `${listId}-${custom ? "c" : ""}${minutes}`;
  const optionAt = (minutes: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-min="${minutes}"]`) ?? null;

  const scrollToRow = (row: HTMLElement | null, smooth: boolean) =>
    scrollRowIntoPlace(listRef.current, row, smooth);

  const scrollKey = props.scrollKey;
  const scrollForce = props.scrollForce === true;
  useLayoutEffect(() => {
    if (scrolledKeyRef.current === scrollKey) return;
    const first = scrolledKeyRef.current == null;
    scrolledKeyRef.current = scrollKey;
    // Opening always lands on the selection; later changes respect browsing.
    if (!first && !scrollForce && (browsedRef.current || hoveringRef.current)) return;
    const list = listRef.current;
    const row =
      list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      list?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ??
      null;
    scrollRowIntoPlace(list, row, !first);
  }, [scrollKey, scrollForce, browsedRef, hoveringRef, scrolledKeyRef, listRef]);

  const keepVisible = (row: HTMLElement) => {
    const list = listRef.current;
    if (!list) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  };

  const focusRow = (minutes: number) => {
    setFocused(minutes);
    const row = optionAt(minutes);
    if (!row) return;
    row.focus({ preventScroll: true });
    keepVisible(row);
  };

  const pickAt = (minutes: number) => {
    if (!enabledAt(minutes)) {
      props.onReject(withMinutes(props.day, minutes));
      return;
    }
    props.say(null);
    props.onPick(minutes);
  };

  const readTyped = (text: string) => {
    setPreview(null);
    const raw = text.trim();
    if (!raw) {
      props.say(null);
      return;
    }
    const minutes = parseTimeOfDay(raw);
    if (minutes == null) {
      props.say(TIME_HINT, "info");
      return;
    }
    props.say(null);
    const near = rows.some((row) => row.minutes === minutes)
      ? minutes
      : (QUARTERS[Math.min(95, Math.round(minutes / 15))] ?? 0);
    setPreview(near);
    scrollToRow(optionAt(near), true);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      inputRef.current?.focus();
      setDraft(event.key);
      readTyped(event.key);
      return;
    }
    const enabled = rows.filter((row) => enabledAt(row.minutes));
    const current =
      event.target instanceof HTMLElement ? Number(event.target.dataset.min ?? Number.NaN) : NaN;
    const index = enabled.findIndex((row) => row.minutes === current);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = index + 1;
        break;
      case "ArrowUp":
        next = index - 1;
        break;
      case "PageDown":
        next = index + 4;
        break;
      case "PageUp":
        next = index - 4;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = enabled.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (Number.isFinite(current)) pickAt(current);
        return;
      default:
        return;
    }
    event.preventDefault();
    browsedRef.current = true;
    const row = enabled[Math.min(Math.max(next, 0), enabled.length - 1)];
    if (row) focusRow(row.minutes);
  };

  const onListBlur = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget;
    if (to instanceof Node && event.currentTarget.contains(to)) return;
    setFocused(null);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const minutes = parseTimeOfDay(event.currentTarget.value);
      if (minutes == null) {
        props.say(TIME_HINT, "warn");
        return;
      }
      pickAt(minutes);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (tabStop != null) focusRow(tabStop);
    }
  };

  return (
    <div className="relative flex min-w-24 flex-[1_0_96px] flex-col px-2 pt-2.5 pb-2">
      <input
        ref={inputRef}
        className="pk-time-input"
        type="text"
        aria-label="Time, 24-hour"
        placeholder="09:00"
        spellCheck={false}
        autoComplete="off"
        maxLength={8}
        value={draft ?? (selected != null ? formatMinutes(selected) : "")}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          setDraft(event.target.value);
          readTyped(event.target.value);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => {
          setPreview(null);
          setDraft(null);
        }}
        onKeyDown={onInputKeyDown}
      />
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Times"
        className="pk-slots"
        onKeyDown={onListKeyDown}
        onBlur={onListBlur}
        onWheel={() => {
          browsedRef.current = true;
        }}
        onTouchMove={() => {
          browsedRef.current = true;
        }}
        onPointerEnter={() => {
          hoveringRef.current = true;
        }}
        onPointerLeave={() => {
          hoveringRef.current = false;
        }}
      >
        {rows.map((row) => (
          <div
            key={row.custom ? `c${row.minutes}` : row.minutes}
            id={optionId(row.minutes, row.custom)}
            role="option"
            className="pk-slot"
            data-min={row.minutes}
            data-hour={row.minutes % 60 === 0 ? "" : undefined}
            data-preview={preview === row.minutes && !row.custom ? "" : undefined}
            aria-selected={row.minutes === selected ? true : undefined}
            aria-disabled={!enabledAt(row.minutes)}
            tabIndex={row.minutes === tabStop ? 0 : -1}
            onFocus={() => setFocused(row.minutes)}
            onClick={() => pickAt(row.minutes)}
          >
            {formatMinutes(row.minutes)}
          </div>
        ))}
      </div>
    </div>
  );
}
