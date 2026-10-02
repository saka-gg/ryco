import { cn } from "../../lib/utils";

import type { InboxGlyphKind } from "./inboxRowPresentation";
import { useInboxEnterAnimation } from "./useInboxListMotion";

const GLYPH_IN: Keyframe[] = [
  { opacity: 0, transform: "scale(0.3) rotate(-90deg)" },
  { opacity: 1, transform: "none" },
];
const GLYPH_IN_OPTIONS: KeyframeAnimationOptions = {
  duration: 460,
  easing: "cubic-bezier(0.3, 1.36, 0.44, 1)",
};
const CHECK_DRAW: Keyframe[] = [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }];
const CHECK_DRAW_OPTIONS: KeyframeAnimationOptions = {
  duration: 380,
  delay: 60,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  fill: "backwards",
};

/** The completed check draws its stroke only when it appears after mount. */
function CompletedMark() {
  const ref = useInboxEnterAnimation<SVGPathElement>(CHECK_DRAW, CHECK_DRAW_OPTIONS);
  return (
    <svg viewBox="0 0 14 14" className="size-[13px]" aria-hidden>
      <circle cx="7" cy="7" r="6.2" className="fill-success" />
      <path
        ref={ref}
        d="M4.3 7.3l1.8 1.8 3.7-3.9"
        pathLength={1}
        strokeDasharray={1}
        className="fill-none stroke-white dark:stroke-black/85"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 14px status mark for an inbox row. Keyed by kind at the call site, so a
 * state change remounts it and the new mark morphs in.
 */
export function InboxStatusGlyph(props: {
  readonly kind: InboxGlyphKind;
  /** Omit when adjacent text already names the state. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}) {
  const ref = useInboxEnterAnimation<HTMLSpanElement>(GLYPH_IN, GLYPH_IN_OPTIONS);
  return (
    <span
      ref={ref}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      data-inbox-glyph={props.kind}
      className={cn(
        "relative inline-flex size-3.5 shrink-0 items-center justify-center",
        props.className,
      )}
    >
      <GlyphMark kind={props.kind} />
    </span>
  );
}

function GlyphMark({ kind }: { readonly kind: InboxGlyphKind }) {
  switch (kind) {
    case "needs-input":
      return (
        <span className="status-activity-signal size-2 text-warning">
          <span className="size-full rounded-full bg-warning" />
        </span>
      );
    case "working":
      return (
        <span className="inbox-glyph-spin size-[11px] rounded-full border-[1.5px] border-foreground/15 border-t-foreground/85" />
      );
    case "connecting":
      return (
        <span className="inbox-glyph-spin-slow size-[11px] rounded-full border-[1.5px] border-dashed border-muted-foreground/60" />
      );
    case "completed":
      return <CompletedMark />;
    case "error":
      return (
        <svg viewBox="0 0 14 14" className="size-[13px]" aria-hidden>
          <circle cx="7" cy="7" r="6.2" className="fill-destructive" />
          <path d="M7 3.9v3.6" className="stroke-white" strokeWidth={1.7} strokeLinecap="round" />
          <circle cx="7" cy="10" r="1" className="fill-white" />
        </svg>
      );
    case "offline":
      return <span className="size-[9px] rounded-full border-[1.5px] border-muted-foreground/45" />;
    case "idle":
      return <span className="size-[5px] rounded-full bg-muted-foreground/35" />;
  }
}
