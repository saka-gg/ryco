import {
  closestCenter,
  DndContext,
  type DraggableSyntheticListeners,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, XIcon } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { createTabStripWheelMapping, scrollTabIntoView } from "../../lib/tabStrip";
import { cn } from "../../lib/utils";

/*
 * Browser-style content tabs, after Synara 1.0.0's SurfaceContentTabs, SurfaceTabChip and
 * SurfaceTabStrip. Tabs are comfortable while few are open, shrink together as more open, and
 * scroll behind an edge fade once they reach their minimum width. Dragging a tab reorders it;
 * holding it near an edge scrolls the hidden tabs in. A middle click closes a tab, and a vertical
 * mouse wheel scrolls the strip sideways.
 */

/** A press must travel this far before it becomes a drag; a still press stays a click. */
export const CONTENT_TAB_DRAG_ACTIVATION_DISTANCE_PX = 6;

// Tab width in `em` of the tab's own font, so it scales with it: every tab starts at a comfortable
// basis and shrinks evenly with the rest down to a floor that still fits the icon, a few
// characters and the close button. Past the floor the strip scrolls instead. The floor never
// exceeds the strip itself, so a strip squeezed by a narrow window still shows one whole tab.
const CONTENT_TAB_SIZE_CLASS_NAME = "min-w-[min(9em,100%)] grow-0 shrink basis-[18em]";
const CONTENT_TAB_FROZEN_SIZE_CLASS_NAME =
  "min-w-0 grow-0 shrink-0 basis-[var(--content-tab-frozen-width)]";
// The strip sits on the header bar, above the chat it belongs to. The active tab takes the chat's
// own surface, so it reads as the open content rather than as a hovered tab. Its hairline is
// inset: the strip's overflow and fade mask would crop an outer outline.
const CONTENT_TAB_ACTIVE_CLASS_NAME =
  "bg-background text-foreground shadow-[inset_0_0_0_0.5px_var(--border)]";
const CONTENT_TAB_IDLE_CLASS_NAME =
  "text-muted-foreground hover:bg-foreground/8 hover:text-foreground";
const CONTENT_TAB_ACTIVE_SELECTOR = "[data-content-tab-active]";

export interface ContentTab<Key extends string> {
  readonly key: Key;
  /** The tab's label, also its tooltip and the name its close button announces. */
  readonly title: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
  /** Omitted for a tab that cannot close: no X, and a middle click does nothing. */
  readonly onClose?: (() => void) | undefined;
  /** Opens the tab's context menu at the pointer. Omitted, the tab has none. */
  readonly onContextMenu?: ((position: { x: number; y: number }) => void) | undefined;
}

interface SortableBinding {
  readonly setNodeRef: (node: HTMLElement | null) => void;
  readonly style: CSSProperties;
  readonly listeners: DraggableSyntheticListeners;
  readonly isDragging: boolean;
}

function ContentTabChip<Key extends string>(props: {
  readonly tab: ContentTab<Key>;
  readonly active: boolean;
  readonly sizeClassName: string;
  readonly onClose: (() => void) | undefined;
  readonly sortable?: SortableBinding | undefined;
}) {
  const { tab, active, onClose, sortable } = props;
  const closeLabel = `Close ${tab.title}`;
  const handleClose = (event: MouseEvent) => {
    event.stopPropagation();
    onClose?.();
  };
  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      {...sortable?.listeners}
      data-content-tab=""
      data-content-tab-active={active ? "" : undefined}
      className={cn(
        // `relative` anchors the between-tab hairline (index.css) and the overlaid X.
        "group/content-tab relative flex h-8 min-w-0 items-center rounded-md text-xs font-normal transition-colors [-webkit-app-region:no-drag]",
        active ? CONTENT_TAB_ACTIVE_CLASS_NAME : CONTENT_TAB_IDLE_CLASS_NAME,
        props.sizeClassName,
      )}
      onMouseDown={
        onClose
          ? (event) => {
              // Suppress middle-button autoscroll and paste before auxclick closes the tab.
              if (event.button === 1) event.preventDefault();
            }
          : undefined
      }
      onAuxClick={
        onClose
          ? (event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              handleClose(event);
            }
          : undefined
      }
      onContextMenu={
        tab.onContextMenu
          ? (event) => {
              event.preventDefault();
              tab.onContextMenu?.({ x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[inherit] pl-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset",
          sortable &&
            (sortable.isDragging ? "cursor-grabbing" : "cursor-grab active:cursor-grabbing"),
          // Room for the overlaid X only while it shows.
          !onClose
            ? "pr-2.5"
            : active
              ? "pr-8"
              : "pr-2.5 group-focus-within/content-tab:pr-8 group-hover/content-tab:pr-8",
        )}
        title={tab.title}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          tab.onSelect();
        }}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          {sortable ? (
            <>
              {/* Hovering swaps the tab's glyph for the reorder grip, in the same slot. */}
              <span
                className={cn(
                  "flex items-center justify-center transition-opacity group-hover/content-tab:opacity-0",
                  sortable.isDragging && "opacity-0",
                )}
              >
                {tab.icon}
              </span>
              <GripVerticalIcon
                aria-hidden
                className={cn(
                  "absolute size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/content-tab:opacity-100",
                  sortable.isDragging && "opacity-100",
                )}
              />
            </>
          ) : (
            tab.icon
          )}
        </span>
        <span className="content-tab-label min-w-0 flex-1">{tab.title}</span>
      </button>
      {onClose ? (
        <button
          type="button"
          className={cn(
            "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none transition-[opacity,background-color,color] hover:bg-foreground/8 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60",
            // Hidden but still hit-testable for a mouse: after a close slides the next tab under
            // the cursor the browser can lag a frame in re-evaluating :hover, and a rapid second
            // click must still close that tab rather than select it. A touch has no hover, so a
            // tap on the hidden X selects the tab instead.
            active
              ? "opacity-100"
              : "opacity-0 group-focus-within/content-tab:opacity-100 group-hover/content-tab:opacity-100 pointer-coarse:pointer-events-none",
          )}
          aria-label={closeLabel}
          title={closeLabel}
          // A press on the X must not arm the drag sensor.
          onPointerDown={sortable ? (event) => event.stopPropagation() : undefined}
          onClick={handleClose}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function SortableContentTabChip<Key extends string>(props: {
  readonly tab: ContentTab<Key>;
  readonly active: boolean;
  readonly sizeClassName: string;
  readonly onClose: (() => void) | undefined;
}) {
  const sortable = useSortable({ id: props.tab.key });
  const { listeners } = sortable;
  return (
    <ContentTabChip
      {...props}
      sortable={{
        setNodeRef: sortable.setNodeRef,
        isDragging: sortable.isDragging,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // The dragged tab rides above the neighbours sliding out of its way.
          ...(sortable.isDragging ? { zIndex: 1 } : {}),
        },
        listeners: listeners && {
          ...listeners,
          // Ctrl+click is the context click on macOS: it opens the tab's menu, which swallows
          // the pointer release, so it must not arm a drag that never ends.
          onPointerDown: (event: PointerEvent) => {
            if (!event.ctrlKey) listeners.onPointerDown?.(event);
          },
        },
      }}
    />
  );
}

/**
 * The horizontal scroller: hides the scrollbar, fades whichever edge has tabs behind it, keeps the
 * active tab in view when the selection changes or the strip resizes, and lets a vertical mouse
 * wheel scroll it sideways.
 */
function ContentTabScroller(props: { readonly activeKey: string | null; children: ReactNode }) {
  const { activeKey } = props;
  const stripRef = useRef<HTMLDivElement>(null);

  // A tab selected past the visible edge (opened elsewhere, or appended at the end) must come into
  // view or the switch looks like it did nothing. Resizes and tabs opening or closing around it
  // move the active tab without changing the selection, so they re-run it. No reveal in this
  // commit: reading geometry here would force a layout of the whole chat the switch just changed;
  // a fresh observer reports its target once, after the layout of the frame that paints it.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || activeKey === null) return;
    const revealActiveTab = () => {
      const activeTab = strip.querySelector<HTMLElement>(CONTENT_TAB_ACTIVE_SELECTOR);
      if (activeTab) scrollTabIntoView(strip, activeTab);
    };
    const resizeObserver = new ResizeObserver(revealActiveTab);
    resizeObserver.observe(strip);
    const mutationObserver = new MutationObserver(revealActiveTab);
    mutationObserver.observe(strip, { childList: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [activeKey]);

  // Passive: a cancelable wheel listener makes every wheel event, sideways trackpad swipes
  // included, wait for the main thread, so the strip would stall whenever a chat renders.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const map = createTabStripWheelMapping();
    const onWheel = (event: WheelEvent) => {
      const delta = map(event);
      if (delta !== 0) strip.scrollLeft += delta;
    };
    strip.addEventListener("wheel", onWheel, { passive: true });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={stripRef}
      data-content-tab-scroller=""
      className="content-tab-scroller flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {props.children}
    </div>
  );
}

export function ContentTabStrip<Key extends string>(props: {
  readonly ariaLabel: string;
  readonly tabs: readonly ContentTab<Key>[];
  readonly activeKey: Key | null;
  /** Drops the dragged tab onto another tab's slot. Omitted, the tabs are not draggable. */
  readonly onMove?: ((key: Key, overKey: Key) => void) | undefined;
}) {
  const { tabs, activeKey, onMove } = props;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: CONTENT_TAB_DRAG_ACTIVATION_DISTANCE_PX },
    }),
  );
  const navRef = useRef<HTMLElement>(null);
  // Closing tabs with the pointer keeps the survivors at their current width until the pointer
  // leaves the strip (like browser tabs), so the next X lands under the cursor instead of the
  // widened neighbour's title.
  const [frozenTabWidthPx, setFrozenTabWidthPx] = useState<number | null>(null);
  const freezeTabWidths = () => {
    const nav = navRef.current;
    // Every tab shares one width (same basis and floor), so any of them measures it.
    const tab = nav?.querySelector<HTMLElement>("[data-content-tab]");
    if (nav?.matches(":hover") && tab) setFrozenTabWidthPx(tab.getBoundingClientRect().width);
  };
  const sizeClassName =
    frozenTabWidthPx === null ? CONTENT_TAB_SIZE_CLASS_NAME : CONTENT_TAB_FROZEN_SIZE_CLASS_NAME;

  const strip = (
    <ContentTabScroller activeKey={activeKey}>
      {tabs.map((tab) => {
        const onClose = tab.onClose
          ? () => {
              freezeTabWidths();
              tab.onClose?.();
            }
          : undefined;
        const chipProps = { tab, active: tab.key === activeKey, sizeClassName, onClose };
        return onMove ? (
          <SortableContentTabChip key={tab.key} {...chipProps} />
        ) : (
          <ContentTabChip key={tab.key} {...chipProps} />
        );
      })}
    </ContentTabScroller>
  );

  return (
    <nav
      ref={navRef}
      aria-label={props.ariaLabel}
      className="flex min-w-0 flex-1 items-center"
      style={
        frozenTabWidthPx === null
          ? undefined
          : ({ "--content-tab-frozen-width": `${frozenTabWidthPx}px` } as CSSProperties)
      }
      onPointerLeave={() => setFrozenTabWidthPx(null)}
    >
      {onMove ? (
        // The scroller is the drag's scroll container: dnd-kit scrolls it while a tab is held
        // near either edge, which brings tabs hidden past the neighbouring controls into reach.
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={({ active, over }) => {
            if (over && active.id !== over.id) onMove(active.id as Key, over.id as Key);
          }}
        >
          <SortableContext
            items={tabs.map((tab) => tab.key)}
            strategy={horizontalListSortingStrategy}
          >
            {strip}
          </SortableContext>
        </DndContext>
      ) : (
        strip
      )}
    </nav>
  );
}
