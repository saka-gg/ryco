import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SETTINGS_CONTROL_WIDTH } from "./settingsLayout";

export interface SettingsSelectOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  /** Plain text for the trigger when `label` is rich. */
  readonly triggerLabel?: ReactNode;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

/**
 * The one select settings rows use: trigger at a standard width, popup aligned
 * to the trigger's end so it never covers the row's label, and an empty value
 * that shows its placeholder instead of a blank box.
 */
export function SettingsSelect<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  placeholder = "Choose…",
  disabled,
  width = "md",
  size,
  className,
}: {
  value: T | "" | null | undefined;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SettingsSelectOption<T>>;
  ariaLabel: string;
  placeholder?: ReactNode;
  disabled?: boolean;
  width?: keyof typeof SETTINGS_CONTROL_WIDTH | "full";
  size?: "sm" | "default";
  className?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select<T>
      value={selected ? selected.value : null}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        size={size}
        className={cn(width === "full" ? "w-full" : SETTINGS_CONTROL_WIDTH[width], className)}
      >
        <SelectValue>
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              {selected.icon}
              <span className="truncate">{selected.triggerLabel ?? selected.label}</span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground/80">{placeholder}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            <span className="flex min-w-0 items-center gap-2">
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
