import {
  AUTOMATION_LIMITS,
  DAY_MS,
  HOUR_MS,
  INTERVAL_PRESETS,
  MINUTE_MS,
  durationWords,
  intervalLabel,
} from "@ryco/shared/automationSchedule";
import { MinusIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { PickerHint } from "./PickerHint";
import { PickerRadioRow, type PickerRadioOption } from "./PickerRadioRow";

const MIN_INTERVAL = AUTOMATION_LIMITS.minIntervalMs;
const MAX_INTERVAL = AUTOMATION_LIMITS.horizonMs;

type Unit = "min" | "h" | "d";
const UNIT_MS: Readonly<Record<Unit, number>> = { min: MINUTE_MS, h: HOUR_MS, d: DAY_MS };
const UNIT_OPTIONS: ReadonlyArray<PickerRadioOption<Unit>> = [
  { value: "min", label: "min" },
  { value: "h", label: "hours" },
  { value: "d", label: "days" },
];
const CUSTOM = "custom";

const unitWord = (unit: Unit, n: number) =>
  unit === "min" ? "min" : unit === "h" ? (n === 1 ? "hour" : "hours") : n === 1 ? "day" : "days";
/** The amount as typed back: at most two decimals, no trailing zeros. */
const formatAmount = (n: number) => String(Math.round(n * 100) / 100);
const clampInterval = (ms: number) =>
  Math.min(Math.max(Math.round(ms), MIN_INTERVAL), MAX_INTERVAL);
const bestUnit = (ms: number): Unit => (ms % DAY_MS === 0 ? "d" : ms % HOUR_MS === 0 ? "h" : "min");
const isPreset = (ms: number) => INTERVAL_PRESETS.some((preset) => preset.ms === ms);

interface IntervalState {
  /** The interval this state was built for (an outside change rebuilds it). */
  readonly value: number;
  readonly customOpen: boolean;
  readonly unit: Unit;
  readonly amount: number;
  /** What the amount field shows while it is being typed in (or can't be used). */
  readonly text: string;
  /** A quiet note that stays until the next change ("Rounded to 2 hours"). */
  readonly note: string | null;
  /** Why the typed amount can't be used, and the nearest one that can. */
  readonly bad: { readonly text: string; readonly fixMs: number } | null;
}

function stateFor(value: number): IntervalState {
  const unit = bestUnit(value);
  const amount = value / UNIT_MS[unit];
  return {
    value,
    customOpen: !isPreset(value),
    unit,
    amount,
    text: formatAmount(amount),
    note: null,
    bad: null,
  };
}

export interface IntervalPickerProps {
  readonly valueMs: number;
  readonly onChange: (ms: number) => void;
  /** A preset chip was clicked (hosts close their popover on it). */
  readonly onCommit?: ((ms: number) => void) | undefined;
  /** Why the typed amount can't be used, or null once it can. */
  readonly onInvalid?: ((reason: string | null) => void) | undefined;
  readonly label?: string | undefined;
  /** Say that day-based intervals are elapsed time (hosts without a run preview). */
  readonly dstHint?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * How often a schedule repeats: seven preset chips and Custom, at least
 * 15 minutes and at most 90 days. Custom reveals a stepper (↑/↓, Shift for
 * 3×) and a unit row; switching units converts what is set (1 day → 24 hours),
 * rounding only when it must and saying so. A typed amount outside the limits
 * says why, with a one-click fix, and never pretends it applied; leaving the
 * field settles on the nearest valid amount.
 */
export function IntervalPicker(props: IntervalPickerProps) {
  const incoming = clampInterval(Number.isFinite(props.valueMs) ? props.valueMs : HOUR_MS);
  const [state, setState] = useState<IntervalState>(() => stateFor(incoming));
  if (state.value !== incoming) setState(stateFor(incoming));
  const { customOpen, unit, amount, note, bad } = state;
  const value = incoming;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusInputRef = useRef(false);
  const [inputFocused, setInputFocused] = useState(false);

  useLayoutEffect(() => {
    if (!focusInputRef.current || !customOpen) return;
    focusInputRef.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [customOpen]);

  /** Applies the next state and reports a changed interval (and validity). */
  const apply = (next: Omit<IntervalState, "value"> & { readonly value?: number }) => {
    const nextValue = next.value ?? value;
    if ((next.bad?.text ?? null) !== (bad?.text ?? null)) props.onInvalid?.(next.bad?.text ?? null);
    setState({ ...next, value: nextValue });
    if (nextValue !== value) props.onChange(nextValue);
  };

  /** setValue: clamp, and with `keepUnit` false re-derive amount (and the unit unless custom). */
  const withValue = (
    base: Omit<IntervalState, "value">,
    ms: number,
    keepUnit: boolean,
  ): Omit<IntervalState, "value"> & { readonly value: number } => {
    const v = clampInterval(ms);
    if (keepUnit) return { ...base, value: v };
    if (base.customOpen) {
      const nextAmount = v / UNIT_MS[base.unit];
      return { ...base, value: v, amount: nextAmount, text: formatAmount(nextAmount) };
    }
    const nextUnit = bestUnit(v);
    const nextAmount = v / UNIT_MS[nextUnit];
    return {
      ...base,
      value: v,
      unit: nextUnit,
      amount: nextAmount,
      text: formatAmount(nextAmount),
    };
  };

  const onPreset = (choice: string, how: "click" | "key") => {
    if (choice === CUSTOM) {
      if (!customOpen) {
        const nextUnit = bestUnit(value);
        const nextAmount = value / UNIT_MS[nextUnit];
        apply({
          ...state,
          customOpen: true,
          unit: nextUnit,
          amount: nextAmount,
          text: formatAmount(nextAmount),
          note: null,
        });
      } else apply({ ...state, note: null });
      if (how !== "click") return;
      // A click goes on to the amount; the field is inert until the row opens.
      if (customOpen) {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else focusInputRef.current = true;
      return;
    }
    const ms = Number(choice);
    apply(withValue({ ...state, customOpen: false, note: null, bad: null }, ms, false));
    if (how === "click") props.onCommit?.(clampInterval(ms));
  };

  const onUnit = (next: Unit) => {
    if (next === unit) return;
    // Convert what is set (1 day → 24 hours → 1,440 min), never reinterpret the number.
    const exact = value / UNIT_MS[next];
    const two = Math.round(exact * 100) / 100;
    if (Math.abs(two - exact) < 1e-9) {
      apply({ ...state, unit: next, amount: two, text: formatAmount(two), note: null, bad: null });
      return;
    }
    const rounded = Math.max(1, Math.round(exact));
    apply(
      withValue(
        {
          ...state,
          unit: next,
          amount: rounded,
          text: formatAmount(rounded),
          note: `Rounded to ${formatAmount(rounded)} ${unitWord(next, rounded)}`,
          bad: null,
        },
        rounded * UNIT_MS[next],
        true,
      ),
    );
  };

  const stepBy = (direction: number) => {
    const size = unit === "min" ? 5 : 1;
    let n = Math.round(amount * 100) / 100 + direction * size;
    let nextNote: string | null = null;
    if (n * UNIT_MS[unit] < MIN_INTERVAL) {
      n = MIN_INTERVAL / UNIT_MS[unit];
      if (direction < 0) nextNote = "15 min is the shortest interval";
    } else if (n * UNIT_MS[unit] > MAX_INTERVAL) {
      n = MAX_INTERVAL / UNIT_MS[unit];
      if (direction > 0) nextNote = "90 days is the longest interval";
    }
    apply(
      withValue(
        { ...state, amount: n, text: formatAmount(n), note: nextNote, bad: null },
        n * UNIT_MS[unit],
        true,
      ),
    );
  };

  const readAmount = (text: string) => {
    const n = Number.parseFloat(text.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  /* While typing: a usable amount applies live; an unusable one says why (and
     offers the nearest valid one) without pretending it applied. */
  const onAmountInput = (text: string) => {
    const n = readAmount(text);
    if (n == null) {
      apply({ ...state, text, note: null, bad: null });
      return;
    }
    const ms = n * UNIT_MS[unit];
    const typed = `${formatAmount(n)} ${unitWord(unit, n)}`;
    if (ms < MIN_INTERVAL) {
      apply({
        ...state,
        text,
        note: null,
        bad: { text: `${typed} is under the 15-minute minimum`, fixMs: MIN_INTERVAL },
      });
      return;
    }
    if (ms > MAX_INTERVAL) {
      apply({
        ...state,
        text,
        note: null,
        bad: { text: `${typed} is over the 90-day limit`, fixMs: MAX_INTERVAL },
      });
      return;
    }
    apply(withValue({ ...state, text, amount: n, note: null, bad: null }, ms, true));
  };

  /* Leaving the field: an unusable amount becomes the nearest valid one, and says so. */
  const settleAmount = (text: string) => {
    const n = readAmount(text);
    if (n == null) {
      apply({ ...state, text: formatAmount(amount), bad: null });
      return;
    }
    const ms = n * UNIT_MS[unit];
    if (ms < MIN_INTERVAL || ms > MAX_INTERVAL) {
      const to = ms < MIN_INTERVAL ? MIN_INTERVAL : MAX_INTERVAL;
      const nextAmount = to / UNIT_MS[unit];
      apply(
        withValue(
          {
            ...state,
            amount: nextAmount,
            text: formatAmount(nextAmount),
            bad: null,
            note: `Set to ${durationWords(to)} — ${to === MIN_INTERVAL ? "the shortest" : "the longest"} interval`,
          },
          to,
          true,
        ),
      );
      return;
    }
    apply({ ...state, text: formatAmount(n) });
  };

  const onAmountKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      stepBy((event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 3 : 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      settleAmount(event.currentTarget.value);
    }
  };

  const applyFix = () => {
    if (!bad) return;
    const fixAmount = bad.fixMs / UNIT_MS[unit];
    apply(
      withValue(
        { ...state, amount: fixAmount, text: formatAmount(fixAmount), note: null, bad: null },
        bad.fixMs,
        true,
      ),
    );
    inputRef.current?.focus();
  };
  const hint: { readonly text: string; readonly tone: "warn" | "muted" } | null = bad
    ? { text: bad.text, tone: "warn" }
    : note
      ? { text: note, tone: "muted" }
      : props.dstHint && value % DAY_MS === 0
        ? { text: "Elapsed time — shifts an hour when clocks change", tone: "muted" }
        : null;

  const presetOptions: ReadonlyArray<PickerRadioOption<string>> = [
    ...INTERVAL_PRESETS.map((preset) => ({
      value: String(preset.ms),
      label: preset.label,
      ariaLabel: intervalLabel(preset.ms),
    })),
    { value: CUSTOM, label: "Custom", ariaLabel: "Custom interval" },
  ];
  const checked = customOpen ? CUSTOM : String(value);
  const hintRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className={cn("pk flex min-w-0 flex-col items-start", props.className)}>
      <PickerRadioRow
        label={props.label ?? "Repeat every"}
        options={presetOptions}
        value={checked}
        onSelect={onPreset}
      />
      <div
        className="pk-reveal"
        role="group"
        aria-label="Custom interval"
        data-open={customOpen ? "" : undefined}
        inert={!customOpen}
      >
        <div className="pk-reveal-in">
          <div className="pk-stepper">
            <button
              type="button"
              className="pk-icon-btn"
              aria-label="Less"
              onClick={() => stepBy(-1)}
            >
              <MinusIcon className="pk-ic" aria-hidden />
            </button>
            <input
              ref={inputRef}
              className="pk-step-input"
              type="text"
              inputMode="decimal"
              aria-label="Interval amount"
              autoComplete="off"
              value={inputFocused || bad ? state.text : formatAmount(amount)}
              onChange={(event) => onAmountInput(event.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={(event) => {
                setInputFocused(false);
                // Heading for the hint's own fix: let that click decide.
                const to = event.relatedTarget;
                if (to instanceof Node && hintRef.current?.contains(to)) return;
                settleAmount(event.currentTarget.value);
              }}
              onKeyDown={onAmountKeyDown}
            />
            <button
              type="button"
              className="pk-icon-btn"
              aria-label="More"
              onClick={() => stepBy(1)}
            >
              <PlusIcon className="pk-ic" aria-hidden />
            </button>
          </div>
          <PickerRadioRow
            label="Unit"
            options={UNIT_OPTIONS}
            value={unit}
            onSelect={(next) => onUnit(next)}
          />
        </div>
      </div>
      <div ref={hintRef} className="self-stretch">
        <PickerHint
          text={hint?.text ?? null}
          tone={hint?.tone}
          fixLabel={bad ? `Use ${durationWords(bad.fixMs)}` : null}
          onFix={applyFix}
        />
      </div>
    </div>
  );
}
