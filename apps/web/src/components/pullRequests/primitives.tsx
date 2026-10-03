import type { ChangeRequestChecksOverall } from "@ryco/client-runtime/state/pull-request-review";
import { DateTime, Option } from "effect";
import { memo, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { useInboxEnterAnimation } from "../inboxSidebar/useInboxListMotion";
import { CommentAvatar } from "../projectExplorer/CommentThread";
import { resolveChangeRequestStateBadgeVariant } from "../sourceControl/stateBadgeVariants";

/**
 * Small, shared vocabulary for the pull requests page: state and check glyphs,
 * avatars, diff stats, and times. Every area composes these so a fact looks
 * the same wherever it appears.
 */

// ── Change request state ─────────────────────────────────────────────

export type ChangeRequestStateLike = {
  readonly state: "open" | "closed" | "merged";
  readonly isDraft?: boolean | undefined;
};

export function changeRequestStateLabel(entry: ChangeRequestStateLike): string {
  return resolveChangeRequestStateBadgeVariant(entry.state, entry.isDraft).label ?? "Unknown";
}

/** State glyph (open / draft / merged / closed) in its house tone. */
export const ChangeRequestStateGlyph = memo(function ChangeRequestStateGlyph(props: {
  readonly state: ChangeRequestStateLike["state"];
  readonly isDraft?: boolean | undefined;
  readonly className?: string | undefined;
  /** Accessible label; omit when adjacent text already names the state. */
  readonly label?: string | undefined;
}) {
  const variant = resolveChangeRequestStateBadgeVariant(props.state, props.isDraft);
  const Icon = variant.Icon;
  return (
    <Icon
      data-pr-state={variant.kind}
      className={cn("size-3.5 shrink-0", variant.textClassName, props.className)}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
    />
  );
});

// ── Checks ───────────────────────────────────────────────────────────

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

function PassingMark() {
  const ref = useInboxEnterAnimation<SVGPathElement>(CHECK_DRAW, CHECK_DRAW_OPTIONS);
  return (
    <svg viewBox="0 0 14 14" className="size-full" aria-hidden>
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

function CheckMark({ overall }: { readonly overall: ChangeRequestChecksOverall }) {
  switch (overall) {
    case "passing":
      return <PassingMark />;
    case "failing":
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
    case "pending":
      return (
        <span className="inbox-glyph-spin block size-[85%] rounded-full border-[1.5px] border-warning/25 border-t-warning" />
      );
    case "none":
      return <span className="block size-[5px] rounded-full bg-muted-foreground/35" />;
  }
}

export const CHECKS_OVERALL_LABEL: Record<ChangeRequestChecksOverall, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
  none: "No checks",
};

/**
 * Overall checks glyph. Key it by `overall` at the call site so a state
 * change remounts it and the new mark pops (and a pass draws its check).
 */
export function CheckStateGlyph(props: {
  readonly overall: ChangeRequestChecksOverall;
  readonly className?: string | undefined;
  readonly label?: string | undefined;
}) {
  const ref = useInboxEnterAnimation<HTMLSpanElement>(GLYPH_IN, GLYPH_IN_OPTIONS);
  return (
    <span
      ref={ref}
      data-pr-checks={props.overall}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}
      className={cn(
        "relative inline-flex size-3.5 shrink-0 items-center justify-center",
        props.className,
      )}
    >
      <CheckMark overall={props.overall} />
    </span>
  );
}

// ── People ───────────────────────────────────────────────────────────

/** Avatar for a host login; prefers the host-provided URL, falls back to initials. */
export const ActorAvatar = memo(function ActorAvatar(props: {
  readonly login: string;
  readonly avatarUrl?: string | undefined;
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}) {
  const size = props.size ?? 20;
  if (props.avatarUrl) {
    return (
      <img
        src={props.avatarUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={cn(
          "inline-flex shrink-0 rounded-full bg-muted/40 object-cover",
          props.className,
        )}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    <span className={cn("inline-flex shrink-0", props.className)}>
      <CommentAvatar author={props.login} size={size} />
    </span>
  );
});

// ── Numbers and time ─────────────────────────────────────────────────

export const DiffStat = memo(function DiffStat(props: {
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly className?: string | undefined;
}) {
  if (props.additions === undefined && props.deletions === undefined) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums",
        props.className,
      )}
      aria-label={`${props.additions ?? 0} additions, ${props.deletions ?? 0} deletions`}
    >
      <span className="text-success">+{props.additions ?? 0}</span>
      <span className="text-destructive">−{props.deletions ?? 0}</span>
    </span>
  );
});

export type TimeLike = DateTime.Utc | Option.Option<DateTime.Utc> | string | null | undefined;

export function toIsoString(value: TimeLike): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Option.isOption(value)) {
    return Option.match(value, {
      onNone: () => null,
      onSome: (inner) => DateTime.formatIso(inner),
    });
  }
  return DateTime.formatIso(value);
}

const ABSOLUTE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** "18m", "2h", "3d" with the full date on hover. */
export const RelativeTime = memo(function RelativeTime(props: {
  readonly value: TimeLike;
  readonly className?: string | undefined;
  /** Append "ago" (for sentences); rows use the bare value. */
  readonly withSuffix?: boolean | undefined;
}) {
  const iso = toIsoString(props.value);
  if (iso === null) return null;
  const relative = formatRelativeTime(iso);
  const text =
    props.withSuffix && relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  return (
    <time
      dateTime={iso}
      title={ABSOLUTE_TIME_FORMAT.format(new Date(iso))}
      className={cn("shrink-0 tabular-nums", props.className)}
    >
      {text}
    </time>
  );
});

// ── Layout vocabulary ────────────────────────────────────────────────

/** Muted 11px section label (sentence case, never an uppercase eyebrow). */
export function SectionLabel(props: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly trailing?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground",
        props.className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      {props.trailing}
    </div>
  );
}

/** Keyboard hint chip used in tooltips and empty states. */
export function KeyHint(props: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] border border-border/70 px-1 font-sans text-[10px] text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </kbd>
  );
}
