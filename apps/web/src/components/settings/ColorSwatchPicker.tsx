import { CheckIcon, PipetteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { ColorPicker } from "../ui/color-picker";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SWATCH_CLASS =
  "relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-card transition-[transform,box-shadow] duration-(--app-motion-duration-chip) ease-(--app-motion-ease) hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/**
 * Preset swatches plus a custom color, in one control. Replaces the browser's
 * native color input everywhere settings picks a color, so the picker matches
 * the rest of the app instead of the operating system.
 *
 * `defaultOption` adds a leading "no color" swatch that reports `null`, for
 * settings where unset means "use the built-in look". Custom-color drags are
 * coalesced so a slow write (IPC, server) isn't issued once per frame.
 */
export function ColorSwatchPicker({
  value,
  onChange,
  swatches,
  ariaLabel,
  defaultOption,
  disabled,
  commitDelayMs = 160,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  swatches: ReadonlyArray<string>;
  ariaLabel: string;
  defaultOption?: { readonly label: string } | undefined;
  disabled?: boolean | undefined;
  commitDelayMs?: number;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    if (timer.current === null) setDraft(value);
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const commitNow = (next: string | null) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setDraft(next);
    onChangeRef.current(next);
  };
  const commitSoon = (next: string) => {
    setDraft(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onChangeRef.current(next);
    }, commitDelayMs);
  };
  const custom = draft !== null && !swatches.some((swatch) => sameColor(swatch, draft));

  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap items-center gap-2">
      {defaultOption ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={draft === null}
                aria-label={defaultOption.label}
                disabled={disabled}
                onClick={() => commitNow(null)}
                className={cn(
                  SWATCH_CLASS,
                  "border border-border bg-background",
                  draft === null && "ring-2 ring-foreground/80",
                )}
              >
                <span
                  aria-hidden
                  className="absolute h-px w-4 rotate-45 rounded-full bg-muted-foreground/70"
                />
              </button>
            }
          />
          <TooltipPopup side="top">{defaultOption.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {swatches.map((swatch) => {
        const selected = sameColor(swatch, draft);
        return (
          <button
            key={swatch}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`Use ${swatch}`}
            disabled={disabled}
            onClick={() => commitNow(swatch)}
            className={cn(
              SWATCH_CLASS,
              "shadow-[inset_0_0_0_1px_--theme(--color-black/12%)] dark:shadow-[inset_0_0_0_1px_--theme(--color-white/14%)]",
              selected && "ring-2 ring-foreground/80",
            )}
            style={{ backgroundColor: swatch }}
          >
            {selected ? (
              <CheckIcon aria-hidden className="size-3.5 text-white drop-shadow-sm" />
            ) : null}
          </button>
        );
      })}
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <ColorPicker
        value={draft ?? swatches[0] ?? "#888888"}
        onChange={commitSoon}
        align="end"
        ariaLabel={`${ariaLabel}: custom`}
        triggerClassName={cn(
          SWATCH_CLASS,
          "overflow-visible rounded-full border-0",
          custom && "ring-2 ring-foreground/80",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{
            background: custom
              ? (draft ?? undefined)
              : "conic-gradient(from 180deg, #f43f5e, #f59e0b, #84cc16, #06b6d4, #6366f1, #d946ef, #f43f5e)",
          }}
        />
        <PipetteIcon
          aria-hidden
          className={cn("relative size-3 drop-shadow-sm", custom ? "text-white" : "text-white/90")}
        />
      </ColorPicker>
      {draft ? (
        <span className="ml-1 font-mono text-[11px] uppercase text-muted-foreground tabular-nums">
          {draft}
        </span>
      ) : null}
    </div>
  );
}
