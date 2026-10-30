import type { FollowUpQueueBadge } from "@ryco/client-runtime/state/message-queue/queueBadge";

import { cn } from "../../lib/utils";

/**
 * A thread row's mark for follow-ups its node queue holds: "2 queued", or "2 held" in amber when
 * nothing goes out without the person. The words carry the state, not the color alone; screen
 * readers read the queue's sentence ("1 queued follow-up: Paused after an error") as row text.
 */
export function FollowUpQueueMark(props: {
  readonly badge: FollowUpQueueBadge;
  readonly className?: string | undefined;
}) {
  return (
    <span
      data-follow-up-queue-badge={props.badge.held ? "held" : "queued"}
      title={props.badge.title}
      className={cn(
        "inline-flex h-4 items-center rounded-full border px-1.5 text-[10px] font-medium",
        props.badge.held
          ? "border-warning/40 text-warning"
          : "border-border/80 text-muted-foreground",
        props.className,
      )}
    >
      <span aria-hidden="true">{props.badge.label}</span>
      <span className="sr-only">{props.badge.title}</span>
    </span>
  );
}
