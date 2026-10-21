import { forwardRef, memo, useEffect, useRef, type ComponentProps } from "react";

export const LabeledInput = memo(
  forwardRef<HTMLInputElement, ComponentProps<"input"> & { readonly label: string }>(
    function LabeledInput({ label, ...props }, ref) {
      return (
        <label>
          <span>{label}</span>
          <input ref={ref} {...props} />
        </label>
      );
    },
  ),
);

/** Opts out, so the compiler leaves it as is. */
export function OptedOut({ value }: { readonly value: number }) {
  "use no memo";
  const doubled = value * 2;
  return <span>{doubled}</span>;
}

export function useAutoFocus(enabled: boolean) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const focus = async () => {
      await Promise.resolve();
      ref.current?.focus();
    };
    void focus();
  }, [enabled]);
  return ref;
}
