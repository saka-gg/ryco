import { useContext, useState } from "react";

import { cn } from "../../../lib/utils";
import { InboxMotionContext } from "../../inboxSidebar/useInboxListMotion";
import type { FactTone } from "./mergeFacts.logic";

/** Text colour per tone, shared by every fact on the rail. */
export const FACT_TONE_TEXT: Record<FactTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  progress: "text-warning",
  neutral: "text-muted-foreground",
  merged: "text-violet-600 dark:text-violet-400",
};

function Mark({ tone }: { readonly tone: FactTone }) {
  switch (tone) {
    case "success":
      return (
        <svg viewBox="0 0 14 14" className="size-full" aria-hidden>
          <circle cx="7" cy="7" r="6.2" className="fill-success" />
          <path
            d="M4.3 7.3l1.8 1.8 3.7-3.9"
            pathLength={1}
            className="pr-fact-check fill-none stroke-white dark:stroke-black/85"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "merged":
      return (
        <svg viewBox="0 0 14 14" className="size-full" aria-hidden>
          <circle cx="7" cy="7" r="6.2" className="fill-violet-600 dark:fill-violet-400" />
          <path
            d="M4.3 7.3l1.8 1.8 3.7-3.9"
            pathLength={1}
            className="pr-fact-check fill-none stroke-white dark:stroke-black/85"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "danger":
      return (
        <svg viewBox="0 0 14 14" className="size-full" aria-hidden>
          <circle cx="7" cy="7" r="6.2" className="fill-destructive" />
          <path
            d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2"
            className="stroke-white"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </svg>
      );
    case "warning":
      return (
        <svg viewBox="0 0 14 14" className="size-full" aria-hidden>
          <circle cx="7" cy="7" r="6.2" className="fill-warning" />
          <path d="M7 3.9v3.6" className="stroke-white" strokeWidth={1.7} strokeLinecap="round" />
          <circle cx="7" cy="9.9" r="0.95" className="fill-white" />
        </svg>
      );
    case "progress":
      return (
        <span className="inbox-glyph-spin block size-[85%] rounded-full border-[1.5px] border-warning/25 border-t-warning" />
      );
    case "neutral":
      return (
        <span className="block size-[9px] rounded-full border-[1.5px] border-muted-foreground/55" />
      );
  }
}

/**
 * The rail's status mark. Key it by tone at the call site: a tone change
 * remounts it and, once the surrounding list has painted (never on first
 * view), the new mark pops in and a check draws its stroke. CSS only, read
 * from the motion tokens, so reduced motion shows the mark at rest.
 */
export function FactGlyph(props: {
  readonly tone: FactTone;
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}) {
  const gate = useContext(InboxMotionContext);
  // Decided once at mount: only marks that appear after the first paint pop.
  const [pops] = useState(() => gate?.current.ready === true && gate.current.enabled);
  return (
    <span
      data-fact-tone={props.tone}
      data-pop={pops ? "" : undefined}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      className={cn(
        "pr-fact-glyph relative inline-flex size-3.5 shrink-0 items-center justify-center",
        props.className,
      )}
    >
      <Mark tone={props.tone} />
    </span>
  );
}
