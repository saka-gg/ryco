import { MessageSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../../lib/utils";
import {
  FILE_STATUS_LABEL,
  FILE_STATUS_LETTER,
  type FileViewedState,
  type PullRequestFileStatus,
} from "./pullRequestFiles.logic";

/**
 * Small marks the tree and the sticky file headers share, so a file's status,
 * conversations and viewed state read the same in both places.
 */

const STATUS_TONE: Record<PullRequestFileStatus, string> = {
  added: "text-success",
  deleted: "text-destructive",
  modified: "text-warning/90",
  renamed: "text-info",
};

/** `A` / `M` / `D` / `R` in the status tone. */
export const FileStatusLetter = memo(function FileStatusLetter(props: {
  readonly status: PullRequestFileStatus;
  readonly className?: string | undefined;
}) {
  return (
    <span
      role="img"
      aria-label={FILE_STATUS_LABEL[props.status]}
      title={FILE_STATUS_LABEL[props.status]}
      className={cn(
        "inline-flex w-3 shrink-0 justify-center font-mono text-[10px] font-semibold",
        STATUS_TONE[props.status],
        props.className,
      )}
    >
      {FILE_STATUS_LETTER[props.status]}
    </span>
  );
});

/** Conversation count; unresolved ones keep the foreground tone. */
export const FileThreadCount = memo(function FileThreadCount(props: {
  readonly total: number;
  readonly unresolved: number;
  readonly className?: string | undefined;
}) {
  if (props.total === 0) return null;
  const label =
    props.unresolved > 0
      ? `${props.total} ${props.total === 1 ? "conversation" : "conversations"}, ${props.unresolved} unresolved`
      : `${props.total} resolved ${props.total === 1 ? "conversation" : "conversations"}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums",
        props.unresolved > 0 ? "text-foreground/80" : "text-muted-foreground/70",
        props.className,
      )}
    >
      <MessageSquareIcon aria-hidden className="size-3" />
      {props.unresolved > 0 ? props.unresolved : props.total}
    </span>
  );
});

/** Amber dot: the file changed after you marked it viewed. */
export function StaleViewedDot(props: { readonly className?: string | undefined }) {
  return (
    <span
      role="img"
      aria-label="Changed since you viewed it"
      title="Changed since you viewed it"
      className={cn("size-1.5 shrink-0 rounded-full bg-warning", props.className)}
    />
  );
}

/**
 * The viewed checkbox. In the tree it is the bare box; in a file header it
 * carries the "Viewed" label. Checking draws the mark in; the box itself
 * never animates size.
 */
export const ViewedCheckbox = memo(function ViewedCheckbox(props: {
  readonly path: string;
  readonly state: FileViewedState | undefined;
  readonly disabled?: boolean | undefined;
  readonly withLabel?: boolean | undefined;
  readonly onToggle: (viewed: boolean) => void;
  readonly className?: string | undefined;
}) {
  const checked = props.state === "viewed";
  const box = (
    <span
      data-checked={checked ? "" : undefined}
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-[background-color,border-color,color] duration-(--app-motion-duration-chip)",
        checked
          ? "border-foreground bg-foreground text-background"
          : "border-muted-foreground/45 text-transparent group-hover/viewed:border-muted-foreground/80",
      )}
    >
      <svg viewBox="0 0 14 14" className="pr-viewed-check size-3" aria-hidden>
        <path
          d="M3.4 7.3l2.4 2.4 4.8-5"
          pathLength={1}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={props.withLabel ? undefined : `Viewed ${props.path}`}
      title={props.withLabel ? undefined : checked ? "Viewed" : "Mark as viewed"}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle(!checked);
      }}
      className={cn(
        "group/viewed inline-flex shrink-0 items-center outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        props.withLabel
          ? "h-7 gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          : "size-6 justify-center rounded-md hover:bg-accent",
        props.withLabel && checked && "text-foreground",
        props.className,
      )}
    >
      {box}
      {props.withLabel ? (
        <span>
          Viewed<span className="sr-only"> {props.path}</span>
        </span>
      ) : null}
    </button>
  );
});
