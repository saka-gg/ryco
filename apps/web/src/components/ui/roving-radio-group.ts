import type { KeyboardEvent } from "react";

import { rovingTargetIndex } from "./sliding-tabs";

/**
 * Keyboard model for hand-rolled radio groups (segmented controls, picker
 * rows) that keep their own visuals: the group is one Tab stop, and
 * ←/↑ · →/↓ · Home/End move focus and select (automatic activation, as in
 * the ARIA radio group pattern). Disabled options are skipped and never take
 * the Tab stop.
 */

const RADIO_VALUE_ATTRIBUTE = "data-radio-value";

export interface RovingRadioOption<Value extends string> {
  readonly value: Value;
  readonly disabled?: boolean | undefined;
}

/** Props for one radio; spread onto its `<button>`. */
export interface RovingRadioProps {
  readonly type: "button";
  readonly role: "radio";
  readonly "aria-checked": boolean;
  readonly tabIndex: 0 | -1;
  readonly disabled: boolean;
  readonly "data-radio-value": string;
  readonly "data-checked": "" | undefined;
  readonly "data-disabled": "" | undefined;
  readonly onClick: () => void;
}

export interface RovingRadioGroup<Value extends string> {
  /** Spread onto the `role="radiogroup"` element. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly radio: (value: Value) => RovingRadioProps;
}

/**
 * Where a key moves within a radio group: ↑ is ←, ↓ is →, both wrap; Home and
 * End jump to the ends. Disabled options are stepped over in the direction of
 * travel. From no current option (`index` -1) the arrows enter at the near
 * end. Null when the key does not move or no option is enabled.
 */
export function rovingRadioTargetIndex(
  key: string,
  index: number,
  disabled: ReadonlyArray<boolean>,
): number | null {
  const count = disabled.length;
  const move = key === "ArrowDown" ? "ArrowRight" : key === "ArrowUp" ? "ArrowLeft" : key;
  const entry =
    index < 0 && move === "ArrowRight" ? "Home" : index < 0 && move === "ArrowLeft" ? "End" : move;
  let target = rovingTargetIndex(entry, Math.max(0, index), count);
  if (target === null) return null;
  const step = entry === "ArrowLeft" || entry === "End" ? "ArrowLeft" : "ArrowRight";
  for (let tried = 0; tried < count; tried += 1) {
    if (disabled[target] !== true) return target;
    target = rovingTargetIndex(step, target, count) ?? target;
  }
  return null;
}

/** The option holding the group's Tab stop: the checked one, else the first enabled. */
export function rovingRadioTabStop<Value extends string>(
  options: ReadonlyArray<RovingRadioOption<Value>>,
  value: Value | null,
): Value | null {
  const checked = options.find((option) => option.value === value && option.disabled !== true);
  return (checked ?? options.find((option) => option.disabled !== true))?.value ?? null;
}

export function rovingRadioGroup<Value extends string>(input: {
  readonly options: ReadonlyArray<RovingRadioOption<Value>>;
  readonly value: Value | null;
  readonly onChange: (value: Value) => void;
}): RovingRadioGroup<Value> {
  const { options, value, onChange } = input;
  const tabStop = rovingRadioTabStop(options, value);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const group = event.currentTarget;
    // Move from the radio that has focus; fall back to the checked one.
    const focused =
      event.target instanceof Element
        ? event.target.closest(`[${RADIO_VALUE_ATTRIBUTE}]`)?.getAttribute(RADIO_VALUE_ATTRIBUTE)
        : null;
    const focusedIndex = options.findIndex((option) => option.value === focused);
    const index =
      focusedIndex === -1 ? options.findIndex((option) => option.value === value) : focusedIndex;
    const target = rovingRadioTargetIndex(
      event.key,
      index,
      options.map((option) => option.disabled === true),
    );
    const next = target === null ? undefined : options[target];
    if (!next) return;
    event.preventDefault();
    if (next.value !== value) onChange(next.value);
    group
      .querySelector<HTMLElement>(`[${RADIO_VALUE_ATTRIBUTE}="${CSS.escape(next.value)}"]`)
      ?.focus();
  };

  const radio = (optionValue: Value): RovingRadioProps => {
    const disabled = options.find((option) => option.value === optionValue)?.disabled === true;
    const checked = optionValue === value;
    return {
      type: "button",
      role: "radio",
      "aria-checked": checked,
      tabIndex: optionValue === tabStop ? 0 : -1,
      disabled,
      [RADIO_VALUE_ATTRIBUTE]: optionValue,
      "data-checked": checked ? "" : undefined,
      "data-disabled": disabled ? "" : undefined,
      onClick: () => onChange(optionValue),
    };
  };

  return { onKeyDown, radio };
}
