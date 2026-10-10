import { ChevronRightIcon } from "lucide-react";
import { Fragment, memo, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import {
  shouldShowWorktreeBreadcrumbSegment,
  type WorktreeOriginLike,
} from "./ChatHeaderBreadcrumb.logic";

export interface ChatHeaderBreadcrumbProps {
  projectName: string | null | undefined;
  worktreeBranch: string | null | undefined;
  worktreeTitle: string | null | undefined;
  worktreeOrigin: WorktreeOriginLike;
  sessionTitle: string;
  onSelectProject?: (() => void) | undefined;
  onSelectWorktree?: (() => void) | undefined;
}

export const ChatHeaderBreadcrumb = memo(function ChatHeaderBreadcrumb(
  props: ChatHeaderBreadcrumbProps,
) {
  const showWorktree = shouldShowWorktreeBreadcrumbSegment({
    origin: props.worktreeOrigin,
    branch: props.worktreeBranch,
  });
  const worktreeLabel = (props.worktreeTitle?.trim() || props.worktreeBranch?.trim()) ?? null;
  const projectName = props.projectName?.trim() || null;

  // A chevron only ever separates two segments: never one in front of the
  // first, so a missing project or worktree leaves no empty step behind.
  const segments: Array<{ readonly key: string; readonly node: ReactNode }> = [];
  if (projectName) {
    segments.push({
      key: "project",
      node: <Segment label={projectName} onSelect={props.onSelectProject} prominent />,
    });
  }
  if (showWorktree && worktreeLabel) {
    segments.push({
      key: "worktree",
      node: <Segment label={worktreeLabel} onSelect={props.onSelectWorktree} mono />,
    });
  }
  segments.push({
    key: "session",
    node: (
      <span className="min-w-0 truncate text-foreground/85" title={props.sessionTitle}>
        {props.sessionTitle}
      </span>
    ),
  });

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium"
    >
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 ? (
            <ChevronRightIcon
              className="size-3 shrink-0 text-muted-foreground/60"
              aria-hidden
              data-slot="breadcrumb-separator"
            />
          ) : null}
          {segment.node}
        </Fragment>
      ))}
    </nav>
  );
});

function Segment(props: {
  label: string;
  onSelect: (() => void) | undefined;
  prominent?: boolean;
  mono?: boolean;
}) {
  const text = (
    <span
      className={cn("min-w-0 truncate", props.mono ? "font-mono text-xs" : "")}
      title={props.label}
    >
      {props.label}
    </span>
  );
  if (props.onSelect) {
    return (
      <button
        type="button"
        onClick={props.onSelect}
        className={cn(
          "inline-flex min-w-0 items-center rounded-md px-1 py-0.5 -mx-1 text-foreground/80 hover:bg-accent/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
          props.prominent ? "text-foreground" : "",
        )}
      >
        {text}
      </button>
    );
  }
  return (
    <span className={cn("min-w-0", props.prominent ? "text-foreground" : "text-foreground/80")}>
      {text}
    </span>
  );
}
