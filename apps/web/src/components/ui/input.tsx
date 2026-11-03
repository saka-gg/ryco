"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "~/lib/utils";

/**
 * The 44px touch floor for a phone-reachable text field.
 *
 * `className` lands on the wrapper `span` (`data-slot="input-control"`), while
 * the height that a hit test actually measures lives on the inner control
 * (`data-slot="input"`) — `h-8.5`/`sm:h-7.5` by default, `h-9.5`/`sm:h-8.5` at
 * `size="lg"`, none of which reach 44px. A bare `phone:h-11` therefore raises
 * the wrapper and silently leaves the control at 34px, which is why this exists
 * as one exported string rather than as a note in a comment somewhere.
 */
const TOUCH_INPUT_CLASS_NAME =
  "phone:h-11 phone:[&_[data-slot=input]]:h-11 phone:[&_[data-slot=input]]:leading-11";

type SharedInputProps = {
  className?: string | undefined;
  size?: "sm" | "default" | "lg" | number | undefined;
  unstyled?: boolean | undefined;
  nativeInput?: boolean | undefined;
};

type InputProps = Omit<
  InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
  "className" | "size"
> &
  SharedInputProps;

function Input({
  className,
  size = "default",
  unstyled = false,
  nativeInput = false,
  style,
  ...props
}: InputProps) {
  const inputClassName = cn(
    "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-muted-foreground/72 sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );

  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {/* A caller's `data-slot` (autocomplete-input, combobox-input) must win over "input":
          those wrappers pad the inner control for their start addon by that slot. */}
      {nativeInput ? (
        <input
          data-slot="input"
          {...(props as React.ComponentPropsWithRef<"input">)}
          className={inputClassName}
          size={typeof size === "number" ? size : undefined}
          style={typeof style === "function" ? undefined : style}
        />
      ) : (
        <InputPrimitive
          data-slot="input"
          {...props}
          className={inputClassName}
          size={typeof size === "number" ? size : undefined}
          style={style}
        />
      )}
    </span>
  );
}

export { Input, TOUCH_INPUT_CLASS_NAME, type InputProps };
