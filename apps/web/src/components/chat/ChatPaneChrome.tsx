import type { ScopedThreadRef } from "@ryco/contracts";
import { BanIcon, Columns2Icon, Rows2Icon, XIcon } from "lucide-react";
import type { DragEvent as ReactDragEvent } from "react";

import { paneKey, type PaneDropVerdict, type PaneRect, type PaneSide } from "../../chatPanes.logic";
import { cn } from "../../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { useUiStateStore } from "../../uiStateStore";
import { inboxGlyphLabel, resolveInboxGlyph } from "../inboxSidebar/inboxRowPresentation";
import { resolveInboxThreadStatus } from "../inboxSidebar/inboxSidebarModel";
import { InboxStatusGlyph } from "../inboxSidebar/InboxStatusGlyph";
import { isCompletionUnseen } from "../Sidebar.logic";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The pane strip's height; the inactive-pane scrim starts below it. */
export const PANE_HEADER_HEIGHT_CLASS = "h-8";

/** Title and inbox glyph for a pane. An unseen completion stays lit until the pane is focused. */
function usePaneStatus(threadRef: ScopedThreadRef, focused: boolean) {
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef));
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[paneKey(threadRef)],
  );
  if (!thread) return { title: "Thread", glyph: null };
  const status = resolveInboxThreadStatus(thread);
  const unseen =
    status.state === "idle" &&
    !focused &&
    isCompletionUnseen(thread.latestTurn?.completedAt, lastVisitedAt);
  return {
    title: thread.title || "Untitled task",
    glyph: { kind: resolveInboxGlyph(status, unseen), label: inboxGlyphLabel(status, unseen) },
  };
}

export function PaneStatusTitle(props: {
  readonly threadRef: ScopedThreadRef;
  readonly focused: boolean;
  readonly className?: string;
}) {
  const { title, glyph } = usePaneStatus(props.threadRef, props.focused);
  return (
    <span className={cn("flex min-w-0 items-center gap-2", props.className)}>
      {glyph ? (
        // Keyed by kind so a state change remounts the mark and it morphs in.
        <InboxStatusGlyph key={glyph.kind} kind={glyph.kind} label={glyph.label} />
      ) : null}
      <span className="truncate">{title}</span>
    </span>
  );
}

/**
 * The strip above each split pane: status, title (also the drag handle that
 * rearranges panes) and close. Focus is carried by the pane frame, so the
 * strip only shifts its text weight.
 */
export function PaneHeader(props: {
  readonly threadRef: ScopedThreadRef;
  readonly index: number;
  readonly focused: boolean;
  /** Grows with a new split (held shut while it stages) or folds away when the split closes. */
  readonly motion: "staged" | "in" | "out" | null;
  readonly onMotionEnd: () => void;
  readonly draggable: boolean;
  readonly closeShortcut: string | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd: () => void;
}) {
  const label = `pane ${props.index + 1}`;
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center gap-1 overflow-hidden border-b border-border/70 pr-1 pl-2.5 text-xs",
        PANE_HEADER_HEIGHT_CLASS,
        props.motion === "staged" && "h-0 border-b-0 opacity-0",
        props.motion === "in" && "chat-pane-header-in",
        props.motion === "out" && "chat-pane-header-out",
      )}
      inert={props.motion === "out" || props.motion === "staged" ? true : undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) props.onMotionEnd();
      }}
    >
      <button
        type="button"
        draggable={props.draggable}
        aria-label={`Focus ${label}`}
        className={cn(
          "flex min-w-0 flex-1 self-stretch rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          props.draggable && "cursor-grab active:cursor-grabbing",
        )}
        onClick={props.onActivate}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
      >
        <PaneStatusTitle
          threadRef={props.threadRef}
          focused={props.focused}
          className={cn(
            "transition-colors duration-(--app-motion-duration-chip)",
            props.focused
              ? "font-medium text-foreground"
              : "text-muted-foreground group-hover/pane:text-foreground/80",
          )}
        />
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-pane-close
              aria-label={`Close ${label}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                props.onClose();
              }}
            />
          }
        >
          <XIcon aria-hidden className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Close pane
          {props.focused && props.closeShortcut ? (
            <Kbd className="ml-1.5">{props.closeShortcut}</Kbd>
          ) : null}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export interface PaneDropPreviewState {
  /** One per drag: a new drag fades in fresh instead of gliding from the last one. */
  readonly session: number;
  readonly key: string;
  readonly side: PaneSide;
  readonly verdict: PaneDropVerdict;
  /** Container percentages of the region the drop would claim. */
  readonly rect: PaneRect;
  readonly visible: boolean;
}

/** What the preview says about a drop. Refusals name the reason and the way out. */
export function paneDropLabel(verdict: PaneDropVerdict): string | null {
  switch (verdict.kind) {
    case "split":
      return "Open here";
    case "move":
      return "Move here";
    case "noop":
      return null;
    case "refused":
      switch (verdict.reason) {
        case "full":
          return "Split view holds 4 threads · close one first";
        case "environment":
          return "Only threads from the same machine can share a split";
        case "axis":
          return verdict.alternative === "vertical"
            ? "Drop on the top or bottom edge"
            : verdict.alternative === "horizontal"
              ? "Drop on the left or right edge"
              : "This pane can't split further";
      }
  }
}

/**
 * The region a drop would claim. Accepted drops get a solid frame and say
 * what happens; refused drops turn dashed and grey and say why, so a drop that
 * will do nothing never looks like one that will.
 */
export function PaneDropPreview({ drop }: { readonly drop: PaneDropPreviewState }) {
  const refused = drop.verdict.kind === "refused";
  const label = paneDropLabel(drop.verdict);
  const SideIcon = drop.side === "left" || drop.side === "right" ? Columns2Icon : Rows2Icon;
  return (
    <div
      aria-hidden
      data-pane-drop={drop.verdict.kind}
      className={cn(
        "chat-pane-drop-in pointer-events-none absolute z-50 p-1.5 transition-[left,top,width,height,opacity] duration-(--app-motion-duration-pop) ease-(--app-motion-spring-gentle)",
        drop.visible ? "opacity-100" : "opacity-0",
      )}
      style={{
        left: `${drop.rect.left}%`,
        top: `${drop.rect.top}%`,
        width: `${drop.rect.width}%`,
        height: `${drop.rect.height}%`,
      }}
    >
      <div
        className={cn(
          "flex size-full items-center justify-center rounded-lg border transition-[background-color,border-color] duration-(--app-motion-duration-pop)",
          refused
            ? "border-dashed border-muted-foreground/45 bg-background/80"
            : "border-foreground/30 bg-foreground/[0.07]",
        )}
      >
        {label ? (
          <span
            className={cn(
              "inline-flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full border bg-popover px-2.5 py-1 text-xs font-medium shadow-sm",
              refused ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {refused ? (
              <BanIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <SideIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{label}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
