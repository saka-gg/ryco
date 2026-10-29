import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REDACTED_TEXT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }

  const nextChar = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return REDACTED_TEXT_ALPHABET[Math.abs(state) % REDACTED_TEXT_ALPHABET.length] ?? "x";
  };

  return Array.from(value, (char) => {
    if (char === "@" || char === "." || char === "-" || char === "_") return char;
    return nextChar();
  }).join("");
}

export function RedactedSensitiveText(props: {
  readonly value: string | null | undefined;
  readonly ariaLabel: string;
  readonly revealTooltip: string;
  readonly hideTooltip: string;
  readonly className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const value = props.value?.trim();
  const redacted = useMemo(() => (value ? redactedPlaceholder(value) : ""), [value]);

  if (!value) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "min-w-0 cursor-pointer rounded-sm font-mono text-[11px] leading-none transition hover:text-foreground",
              revealed ? "text-muted-foreground" : "select-none text-muted-foreground blur-[2px]",
              props.className,
            )}
            onClick={() => setRevealed((current) => !current)}
            aria-label={props.ariaLabel}
          >
            {revealed ? value : redacted}
          </button>
        }
      />
      <TooltipPopup side="top">{revealed ? props.hideTooltip : props.revealTooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * An account email, blurred until clicked. `AccountEmail` lays it out for usage and provider
 * rows; a surface that only needs the email (provider sign-in) imports it from here, so it does
 * not split the usage components into a chunk of their own.
 */
export function RedactedEmail(props: {
  readonly email: string | null | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <RedactedSensitiveText
      value={props.email}
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
      // A long email wraps inside narrow containers instead of running past them.
      className={cn("wrap-anywhere", props.className)}
    />
  );
}
