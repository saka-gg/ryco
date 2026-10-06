import {
  Fragment,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { rovingRadioTargetIndex } from "~/components/ui/roving-radio-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { pickerMotionOn } from "./pickerMotion";

export interface PickerRadioOption<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  readonly ariaLabel?: string | undefined;
  /** Shown, focusable and explained by its tip, but never chosen. */
  readonly disabled?: boolean | undefined;
  readonly tip?: string | undefined;
  /** Wraps the radio, e.g. in a popover trigger; must render the given element. */
  readonly wrap?: ((radio: ReactElement) => ReactElement) | undefined;
}

export type PickerRadioHow = "click" | "key";

/**
 * A row of radio chips with one plate that slides to the checked chip (the
 * lab's segmented row). One Tab stop; ←/→/↑/↓ move and check (wrapping),
 * Home/End jump, disabled chips are stepped over. Disabled chips stay
 * hoverable (`aria-disabled`) so their tip can say why. No chip checked: the
 * plate fades out and the first enabled chip holds the Tab stop.
 */
export function PickerRadioRow<Value extends string>(props: {
  readonly options: ReadonlyArray<PickerRadioOption<Value>>;
  readonly value: Value | null;
  readonly onSelect: (value: Value, how: PickerRadioHow) => void;
  readonly label: string;
  readonly className?: string | undefined;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const plateRef = useRef<HTMLSpanElement | null>(null);
  // The plate's last placement: which chip it sat behind, and where.
  const placedRef = useRef<{ readonly value: Value | null; readonly at: string } | null>(null);

  const checked = props.options.find((option) => option.value === props.value) ?? null;
  const tabStop =
    checked && checked.disabled !== true
      ? checked.value
      : (props.options.find((option) => option.disabled !== true)?.value ?? null);

  // After every commit the plate sits behind the checked chip; it slides only
  // when the checked chip changed (never on first placement or a resize).
  const value = props.value;
  useLayoutEffect(() => {
    const previous = placedRef.current;
    const at = placePlate(rowRef.current, plateRef.current, {
      value,
      animate: previous != null && previous.value !== value && pickerMotionOn(),
      unless: previous?.value === value ? previous.at : null,
    });
    placedRef.current = { value, at };
  });

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const placed = placedRef.current;
        if (!placed) return;
        const at = placePlate(rowRef.current, plateRef.current, {
          value: placed.value,
          animate: false,
          unless: placed.at,
        });
        placedRef.current = { value: placed.value, at };
      });
    });
    observer.observe(row);
    for (const radio of row.querySelectorAll('[role="radio"]')) observer.observe(radio);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const focused =
      event.target instanceof Element
        ? event.target.closest('[role="radio"]')?.getAttribute("data-radio-value")
        : null;
    const index = props.options.findIndex((option) => option.value === focused);
    if (index < 0) return;
    const target = rovingRadioTargetIndex(
      event.key,
      index,
      props.options.map((option) => option.disabled === true),
    );
    const next = target === null ? undefined : props.options[target];
    if (!next) return;
    event.preventDefault();
    rowRef.current
      ?.querySelector<HTMLElement>(`[data-radio-value="${CSS.escape(next.value)}"]`)
      ?.focus();
    props.onSelect(next.value, "key");
  };

  return (
    <div
      ref={rowRef}
      role="radiogroup"
      aria-label={props.label}
      className={cn("pk-segrow", props.className)}
      onKeyDown={onKeyDown}
    >
      <span ref={plateRef} className="pk-plate" aria-hidden />
      {props.options.map((option) => {
        const isChecked = option.value === props.value;
        const disabled = option.disabled === true;
        const radio = (
          <button
            type="button"
            role="radio"
            aria-checked={isChecked}
            aria-disabled={disabled}
            aria-label={option.ariaLabel}
            tabIndex={option.value === tabStop ? 0 : -1}
            data-radio-value={option.value}
            onClick={() => {
              if (!disabled) props.onSelect(option.value, "click");
            }}
          >
            {option.label}
          </button>
        );
        const wrapped = option.wrap ? option.wrap(radio) : radio;
        if (!option.tip) return <Fragment key={option.value}>{wrapped}</Fragment>;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger render={wrapped} />
            <TooltipPopup>{option.tip}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Puts the plate behind the chip for `value` (hidden when none is checked).
 * Returns where it went; does nothing when that is `unless`.
 */
function placePlate(
  row: HTMLElement | null,
  plate: HTMLElement | null,
  options: {
    readonly value: string | null;
    readonly animate: boolean;
    readonly unless: string | null;
  },
): string {
  if (!row || !plate) return "";
  const current =
    options.value == null
      ? null
      : row.querySelector<HTMLElement>(`[data-radio-value="${CSS.escape(options.value)}"]`);
  const at =
    current && current.offsetWidth
      ? `${current.offsetLeft},${current.offsetTop},${current.offsetWidth},${current.offsetHeight}`
      : "none";
  if (at === options.unless) return at;
  if (!current || at === "none") {
    plate.style.opacity = "0";
    return at;
  }
  const apply = () => {
    plate.style.opacity = "1";
    plate.style.transform = `translate(${current.offsetLeft}px, ${current.offsetTop}px)`;
    plate.style.width = `${current.offsetWidth}px`;
    plate.style.height = `${current.offsetHeight}px`;
  };
  if (options.animate) {
    apply();
    return at;
  }
  plate.setAttribute("data-instant", "");
  apply();
  void plate.offsetWidth;
  plate.removeAttribute("data-instant");
  return at;
}
