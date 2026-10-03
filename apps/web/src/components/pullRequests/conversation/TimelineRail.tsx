import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { ActorAvatar } from "../primitives";

/**
 * The timeline's vertical rail. Each entry owns the segment that runs from
 * its node down to the next entry's node, so the line ends exactly at the
 * last node and breaks briefly around every node instead of running under it.
 */

export const TIMELINE_NODE_SIZE = 22;

export function TimelineList(props: {
  readonly children: ReactNode;
  readonly label: string;
  readonly className?: string | undefined;
}) {
  return (
    <ol aria-label={props.label} className={cn("relative text-[14px]", props.className)}>
      {props.children}
    </ol>
  );
}

/**
 * `post` entries (comments, reviews, the composer) breathe; `event` entries
 * are one muted line and sit close together.
 */
export function TimelineItem(props: {
  readonly node: ReactNode;
  readonly size: "post" | "event";
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
}) {
  return (
    <li
      id={props.id}
      data-entry={props.size}
      className={cn(
        "group/entry relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-3",
        // The segment from this node to the next one.
        "after:absolute after:top-[26px] after:bottom-1 after:left-[10.5px] after:w-px after:bg-border/80 last:after:hidden",
        props.size === "post" ? "pb-6" : "pb-2 [&:has(+[data-entry=post])]:pb-5",
        props.className,
      )}
    >
      <div className="relative flex size-[22px] items-center justify-center">{props.node}</div>
      <div className="min-w-0">{props.children}</div>
    </li>
  );
}

export type TimelineNodeTone = "muted" | "success" | "danger" | "merged" | "open" | "warning";

const NODE_TONE_CLASS: Record<TimelineNodeTone, string> = {
  muted: "text-muted-foreground/80",
  success: "text-success-foreground",
  danger: "text-destructive-foreground",
  merged: "text-violet-600 dark:text-violet-400",
  open: "text-emerald-600 dark:text-emerald-400",
  warning: "text-warning-foreground",
};

/** A 14px glyph on the rail (events, commits, force-pushes). */
export function IconNode(props: {
  readonly icon: LucideIcon;
  readonly tone?: TimelineNodeTone | undefined;
}) {
  const Icon = props.icon;
  return <Icon aria-hidden className={cn("size-3.5", NODE_TONE_CLASS[props.tone ?? "muted"])} />;
}

/** A review verdict: the glyph inside a hairline disc, so verdicts read as stops on the rail. */
export function VerdictNode(props: {
  readonly icon: LucideIcon;
  readonly tone: TimelineNodeTone;
  readonly label: string;
}) {
  const Icon = props.icon;
  return (
    <span
      role="img"
      aria-label={props.label}
      className="inline-flex size-[22px] items-center justify-center rounded-full bg-background ring-1 ring-border ring-inset"
    >
      <Icon aria-hidden className={cn("size-3.5", NODE_TONE_CLASS[props.tone])} />
    </span>
  );
}

export function AvatarNode(props: {
  readonly login: string;
  readonly avatarUrl?: string | undefined;
}) {
  return <ActorAvatar login={props.login} avatarUrl={props.avatarUrl} size={TIMELINE_NODE_SIZE} />;
}

/** The right-hand time column shared by event lines and post headers. */
export function TimeSlot(props: { readonly children: ReactNode }) {
  return (
    <span className="shrink-0 text-xs leading-4 whitespace-nowrap text-muted-foreground/75 tabular-nums">
      {props.children}
    </span>
  );
}

/** One muted 12px event line: actor and what happened, the time at the right edge. */
export function EventLine(props: {
  readonly children: ReactNode;
  readonly time?: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[22px] items-start gap-3 py-[3px] text-xs leading-4 text-muted-foreground",
        props.className,
      )}
    >
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{props.children}</div>
      {props.time ? <TimeSlot>{props.time}</TimeSlot> : null}
    </div>
  );
}

/** The actor's login inside an event line or post header. */
export function Actor(props: { readonly login: string | null | undefined }) {
  return <span className="font-medium text-foreground/90">{props.login ?? "Someone"}</span>;
}
