import {
  MINUTE_MS,
  UNTIL_PRESETS,
  countRuns,
  detectUntilMode,
  durationWords,
  endFor,
  formatDate,
  formatDateTime,
  formatDay,
  formatTime,
  minutesOf,
  untilLimit,
  withMinutes,
} from "@ryco/shared/automationSchedule";
import { CalendarIcon } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useEvent } from "~/hooks/useEvent";
import { cn } from "~/lib/utils";

import { CalendarPanel } from "./CalendarPanel";
import { PickerHint } from "./PickerHint";
import { PickerRadioRow, type PickerRadioOption } from "./PickerRadioRow";

/** Which choice the end reads as. `clamped`: a preset that no longer fits ends at the limit. */
type UntilChoice =
  | { readonly kind: "dur"; readonly ms: number }
  | { readonly kind: "max" }
  | { readonly kind: "date" }
  | { readonly kind: "clamped"; readonly from: number };

const MAX = "max";
const DATE = "date";

/** How an end arrived: a duration chip, Max, a date from the calendar, or the fix. */
export type UntilVia = "preset" | "max" | "date" | "fix";

export interface UntilPickerProps {
  readonly startMs: number;
  readonly valueMs: number;
  readonly nowMs: number;
  /** With an interval, the read-back counts the runs. */
  readonly intervalMs?: number | null | undefined;
  readonly onChange: (ms: number) => void;
  /** A chip was clicked or a date picked (hosts close their popover on presets). */
  readonly onCommit?: ((ms: number, info: { readonly via: UntilVia }) => void) | undefined;
  readonly label?: string | undefined;
  /**
   * The read-back line: "full" — "Until Sat, Nov 7 · 09:00 · 31 runs";
   * "bound" — "Until Sat, Nov 7 · 09:00"; false — none (where a run preview
   * shares the surface; limit and validation notes still show).
   */
  readonly summary?: "full" | "bound" | false | undefined;
  readonly className?: string | undefined;
}

/**
 * The end of a recurring schedule, always inside 90 days: four durations,
 * Max and "On a date…" (a compact calendar, the range drawn from the start,
 * picking the end of that day), plus at most one read-back line. A duration
 * that would pass the limit is shown but unavailable and says why; Max names
 * the limit's date. Day-based durations keep the start's wall-clock time
 * across a clock change.
 */
export function UntilPicker(props: UntilPickerProps) {
  const { startMs: start, nowMs: now } = props;
  const interval = props.intervalMs ?? null;
  const max = untilLimit(now);
  const plus = (presetMs: number) => endFor(start, presetMs);

  // An outside change of the end re-reads which choice it is.
  const [tracked, setTracked] = useState<{ readonly value: number; readonly choice: UntilChoice }>(
    () => ({ value: props.valueMs, choice: detectUntilMode(start, props.valueMs, now) }),
  );
  if (tracked.value !== props.valueMs) {
    setTracked({ value: props.valueMs, choice: detectUntilMode(start, props.valueMs, now) });
  }
  const choice = tracked.choice;
  const value = props.valueMs;
  const [calOpen, setCalOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const emit = (next: number, nextChoice: UntilChoice) => {
    setTracked({ value: next, choice: nextChoice });
    if (next !== value) props.onChange(next);
  };

  /* A preset that would pass the limit ends at the limit and selects nothing. */
  const applyDuration = (presetMs: number) => {
    const end = plus(presetMs);
    if (end > max) emit(max, { kind: "clamped", from: presetMs });
    else emit(end, { kind: "dur", ms: presetMs });
    return end > max ? max : end;
  };

  // A duration's end is wall-clock from the start (an elapsed one is read as
  // that duration): report the normalized end once, after the host's setup.
  const normalizeOnMount = useEvent(() => {
    if (choice.kind !== "dur") return;
    const end = plus(choice.ms);
    if (value !== end && end <= max) props.onChange(end);
  });
  useEffect(() => {
    normalizeOnMount();
  }, [normalizeOnMount]);

  // A new start moves an end that was chosen as a duration (or Max) with it.
  const seenStartRef = useRef(start);
  const followStart = useEvent(() => {
    if (choice.kind === "dur") applyDuration(choice.ms);
    else if (choice.kind === "clamped") applyDuration(choice.from);
    else if (choice.kind === "max") emit(max, choice);
  });
  useEffect(() => {
    if (seenStartRef.current === start) return;
    seenStartRef.current = start;
    followStart();
  }, [start, followStart]);

  const onSelect = (picked: string, how: "click" | "key") => {
    if (picked === DATE) {
      // Arrowing onto it makes the current end an explicit date (APG: arrows
      // check); a click or Enter/Space opens the calendar and only a pick changes it.
      if (how === "key") setTracked({ value, choice: { kind: "date" } });
      return;
    }
    if (picked === MAX) {
      emit(max, { kind: "max" });
      if (how === "click") props.onCommit?.(max, { via: "max" });
      return;
    }
    const end = applyDuration(Number(picked));
    if (how === "click") props.onCommit?.(end, { via: "preset" });
  };

  const options: ReadonlyArray<PickerRadioOption<string>> = [
    ...UNTIL_PRESETS.map((preset) => {
      const over = plus(preset.ms) > max;
      return {
        value: String(preset.ms),
        label: preset.label,
        disabled: over,
        tip: over ? `Past the 90-day limit (${formatDate(max, now)})` : undefined,
      };
    }),
    {
      value: MAX,
      label: "Max",
      ariaLabel: "Until the 90-day limit",
      tip: `Until ${formatDate(max, now)}, the 90-day limit`,
    },
    {
      value: DATE,
      label: (
        <>
          <CalendarIcon className="pk-ic" aria-hidden />
          <span>{choice.kind === "date" ? formatDate(value, now) : "On a date…"}</span>
        </>
      ),
      ariaLabel:
        choice.kind === "date"
          ? `On ${formatDate(value, now)}. Opens a calendar`
          : "On a date. Opens a calendar",
      wrap: (radio: ReactElement) => <PopoverTrigger render={radio} />,
    },
  ];
  const checked =
    choice.kind === "dur"
      ? String(choice.ms)
      : choice.kind === "max"
        ? MAX
        : choice.kind === "date"
          ? DATE
          : null;

  // The read-back: what the end is, and (full) how long and how many runs.
  const summary = props.summary ?? "full";
  const atLimit = choice.kind === "max" || choice.kind === "clamped";
  const endOfDay = minutesOf(value) === 1439;
  const runs =
    interval != null && interval > 0 && value >= start
      ? countRuns({ kind: "fixed-interval", startsAt: start, intervalMs: interval, endsAt: value })
      : null;
  const head = atLimit
    ? `Ends ${formatDate(value, now)} · ${formatTime(value)}`
    : endOfDay
      ? `Through ${formatDay(value, now)}`
      : `Until ${formatDateTime(value, now)}`;
  const tail: string[] = [];
  if (atLimit) tail.push("the 90-day limit");
  // The duration only adds something when a date (not a duration) was picked.
  if (summary === "full" && choice.kind === "date" && value >= start)
    tail.push(durationWords(value - start));
  if (summary === "full" && runs != null)
    tail.push(`${runs.toLocaleString("en-US")} ${runs === 1 ? "run" : "runs"}`);

  const overLimit = value >= start && value > max + MINUTE_MS;
  const hint: { readonly text: string; readonly tone: "warn" | "muted" } | null =
    value < start
      ? { text: "Ends before it starts — pick a later end", tone: "warn" }
      : overLimit
        ? { text: `Past the 90-day limit — the latest is ${formatDate(max, now)}`, tone: "warn" }
        : choice.kind === "clamped" && summary === false
          ? {
              // Without a read-back line, say why no preset is selected (once).
              text: `${UNTIL_PRESETS.find((preset) => preset.ms === choice.from)?.label ?? "That"} would pass the 90-day limit, so it ends at the limit`,
              tone: "muted",
            }
          : null;
  const endAtLimit = () => {
    emit(max, { kind: "max" });
    props.onCommit?.(max, { via: "fix" });
  };

  return (
    <div className={cn("pk flex min-w-0 flex-col", props.className)}>
      <Popover open={calOpen} onOpenChange={setCalOpen}>
        <PickerRadioRow
          label={props.label ?? "Ends"}
          options={options}
          value={checked}
          onSelect={onSelect}
          className="self-start"
        />
        <PopoverPopup
          side="bottom"
          align="end"
          sideOffset={6}
          className="rounded-[12px] before:rounded-[11px]"
          viewportClassName="p-0"
          aria-label="End date"
          morph="auto"
          initialFocus={() =>
            panelRef.current?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]') ?? true
          }
        >
          <CalendarPanel
            ref={panelRef}
            value={value}
            min={start}
            max={max}
            nowMs={now}
            compact
            rangeStart={start}
            maxNote="beyond the 90-day limit"
            legend={`From ${formatDate(start, now)}`}
            pickDay={(day) => Math.min(withMinutes(day, 1439), max)}
            commit={(ms) => {
              if (ms < start || ms > max) return false;
              emit(ms, { kind: "date" });
              props.onCommit?.(ms, { via: "date" });
              return true;
            }}
            onDone={() => setCalOpen(false)}
          />
        </PopoverPopup>
      </Popover>
      {summary === false ? null : (
        <div className="mt-2 text-[12.5px] text-muted-foreground pk-until-sum">
          <b>{head}</b>
          {tail.map((part) => (
            <span key={part}>
              {" "}
              <span className="pk-sep">·</span> <span className="tnum">{part}</span>
            </span>
          ))}
        </div>
      )}
      <PickerHint
        text={hint?.text ?? null}
        tone={hint?.tone}
        fixLabel={overLimit ? `Use ${formatDate(max, now)}` : null}
        onFix={endAtLimit}
      />
    </div>
  );
}
