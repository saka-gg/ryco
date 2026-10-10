import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

interface ShownHint {
  readonly text: string;
  readonly tone: "warn" | "muted";
  readonly fixLabel: string | null;
}

/**
 * The one line under a picker part: a reason (with a one-click fix) or a
 * quiet note. It opens and collapses in place, keeping the last words while it
 * folds away, and is never a red wall. Polite live region: the change is read
 * once when it appears.
 */
export function PickerHint(props: {
  readonly text: string | null;
  readonly tone?: "warn" | "muted" | undefined;
  /** A one-click fix after the reason ("Use 15 min"). */
  readonly fixLabel?: string | null | undefined;
  readonly onFix?: (() => void) | undefined;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
}) {
  const tone = props.tone ?? "warn";
  const fixLabel = props.fixLabel ?? null;
  const [shown, setShown] = useState<ShownHint | null>(() =>
    props.text ? { text: props.text, tone, fixLabel } : null,
  );
  if (
    props.text &&
    (shown?.text !== props.text || shown.tone !== tone || shown.fixLabel !== fixLabel)
  ) {
    setShown({ text: props.text, tone, fixLabel });
  }
  const on = props.text != null && props.text !== "";
  return (
    <div
      className={cn("pk-hint", props.className)}
      data-on={on ? "" : undefined}
      data-tone={shown?.tone}
      aria-live="polite"
      id={props.id}
    >
      <div className="pk-hint-in" inert={!on}>
        {shown ? (
          <>
            {shown.tone === "warn" ? <CircleAlertIcon className="pk-ic" aria-hidden /> : null}
            <span>{shown.text}</span>
            {shown.fixLabel ? (
              <button type="button" className="pk-fix" onClick={on ? props.onFix : undefined}>
                {shown.fixLabel}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
