import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type { PendingDiffFile as PendingDiffFileState } from "./fileIndexedDiff";

/** Rows a placeholder reserves per changed line, so loading a file moves little. */
const ROW_HEIGHT_PX = 20;
/** Loads a file this far before it scrolls into view. */
const NEAR_VIEWPORT_MARGIN = "1200px 0px";

/**
 * A file of a diff read file by file whose patch has not arrived: its header
 * (path and counts, the same fold toggle as a loaded file) and the room its
 * rows will take. It asks for its patch once it comes near the viewport,
 * unless folded.
 */
export function PendingDiffFile(props: {
  readonly pending: PendingDiffFileState;
  readonly path: string;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onNeeded: () => void;
}) {
  const { pending, path, collapsed, onNeeded } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || collapsed || pending.loading || pending.error !== null) return;
    if (typeof IntersectionObserver === "undefined") {
      onNeeded();
      return;
    }
    const root = element.closest<HTMLElement>(".diff-render-surface");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onNeeded();
        }
      },
      { root, rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed, onNeeded, pending.error, pending.loading]);

  const { file } = pending;
  const changedLines = file.additions + file.deletions;
  return (
    <div
      ref={ref}
      data-diff-file-pending=""
      className="overflow-hidden rounded-md border border-border/60"
    >
      <div className="flex items-center gap-2 bg-muted/40 px-2 py-1.5 text-xs">
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10"
          aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand diff" : "Collapse diff"}
          onClick={props.onToggleCollapsed}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-4" />
          ) : (
            <ChevronDownIcon className="size-4" />
          )}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono">
          {file.previousPath ? `${file.previousPath} → ${path}` : path}
        </span>
        {file.binary ? (
          <span className="text-muted-foreground">binary</span>
        ) : (
          <span className="shrink-0 font-mono">
            <span className="text-[var(--diffs-addition-base)]">+{file.additions}</span>{" "}
            <span className="text-[var(--diffs-deletion-base)]">-{file.deletions}</span>
          </span>
        )}
      </div>
      {collapsed ? null : pending.error !== null ? (
        <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
          {pending.error}
          <button type="button" className="underline" onClick={onNeeded}>
            Try again
          </button>
        </div>
      ) : (
        <div
          role="status"
          aria-label={`Loading ${path}`}
          className={cn("px-3 py-2 text-xs text-muted-foreground")}
          style={{ height: Math.max(1, changedLines + 3) * ROW_HEIGHT_PX }}
        >
          {pending.loading ? "Loading…" : null}
        </div>
      )}
    </div>
  );
}
