import { ChevronsLeftIcon, ChevronsRightIcon, MoreHorizontalIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import type { OverviewRailTone } from "./overviewRail.logic";

/*
 * The desktop overview rail: a content-height capsule pinned to the
 * conversation's right edge. Hover, keyboard focus, or an open popup reveal
 * only their row; explicit pinning reveals every row. Fixed-width rows are
 * clipped to the icon column at rest, so revealing them never moves icons or
 * reflows the conversation. The wider scroll viewport lets individual rows
 * extend leftward even when a short window needs vertical scrolling.
 */

const HOVER_EXPAND_DELAY_MS = 70;
const HOVER_COLLAPSE_DELAY_MS = 200;
const ITEM_SELECTOR = "[data-overview-rail-item]";
const ROW_SELECTOR = "[data-overview-rail-row]";
// Focus arriving from one of these is a popup handing focus back to its
// trigger, not the place the user entered the rail from.
const POPUP_SURFACE_SELECTOR =
  '[data-slot="menu-popup"],[data-slot="popover-popup"],[data-slot="combobox-popup"],[role="dialog"],[role="alertdialog"]';

interface OverviewRailContextValue {
  activeItemId: string | null;
  setActiveItemId: (itemId: string) => void;
  pinned: boolean;
  revealedRowIds: ReadonlySet<string>;
}

const OverviewRailContext = createContext<OverviewRailContextValue | null>(null);
const OverviewRailRowContext = createContext<string | null>(null);

function isFocusableItem(item: HTMLElement): boolean {
  return !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true";
}

function isNavigableItem(item: HTMLElement): boolean {
  if (isFocusableItem(item)) return true;
  // An unavailable primary action can still offer useful alternatives.
  const options = item
    .closest(ROW_SELECTOR)
    ?.querySelector<HTMLElement>("[data-overview-rail-secondary]");
  return !item.hasAttribute("disabled") && Boolean(options && isFocusableItem(options));
}

export interface OverviewRailProps {
  /** Accessible name of the toolbar. */
  label: string;
  /** Explicitly expanded (the old "overview open" state). */
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  /** Where Escape sends focus when the rail was entered from nowhere trackable. */
  onFocusReturnFallback?: (() => void) | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function OverviewRail({
  label,
  pinned,
  onPinnedChange,
  onFocusReturnFallback,
  className,
  children,
}: OverviewRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [popupRowIds, setPopupRowIds] = useState<ReadonlyArray<string>>([]);
  // Set by an explicit collapse (toggle or Escape) so the pointer or keyboard
  // focus still resting on the rail cannot immediately re-expand it.
  const [forceCollapsed, setForceCollapsed] = useState(false);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  // Native listeners on purpose: React's synthetic enter/leave follow the
  // component tree, so a portaled menu would count as "inside" and the rail
  // could stay stuck open after that menu closes.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const rowIdFor = (target: EventTarget | null) =>
      target instanceof Element && rail.contains(target)
        ? (target.closest<HTMLElement>(ROW_SELECTOR)?.dataset.overviewRailRow ?? null)
        : null;
    const schedule = (next: string | null) => {
      clearHoverTimer();
      hoverTimerRef.current = window.setTimeout(
        () => {
          hoverTimerRef.current = null;
          setHoveredRowId(next);
        },
        next ? HOVER_EXPAND_DELAY_MS : HOVER_COLLAPSE_DELAY_MS,
      );
    };
    const handleOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const next = rowIdFor(event.target);
      if (next === rowIdFor(event.relatedTarget)) return;
      setForceCollapsed(false);
      schedule(next);
    };
    const handleOut = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const next = rowIdFor(event.relatedTarget);
      if (next !== rowIdFor(event.target)) schedule(next);
    };
    const handleLeave = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      setForceCollapsed(false);
      schedule(null);
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const from = event.relatedTarget;
      if (from instanceof HTMLElement && !rail.contains(from)) {
        if (!from.closest(POPUP_SURFACE_SELECTOR)) returnFocusRef.current = from;
      }
      setFocusedRowId(target.matches(":focus-visible") ? rowIdFor(target) : null);
    };
    const handleFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && rail.contains(next)) return;
      setFocusedRowId(null);
      setForceCollapsed(false);
    };
    rail.addEventListener("pointerover", handleOver);
    rail.addEventListener("pointerout", handleOut);
    rail.addEventListener("pointerleave", handleLeave);
    rail.addEventListener("focusin", handleFocusIn);
    rail.addEventListener("focusout", handleFocusOut);
    return () => {
      clearHoverTimer();
      rail.removeEventListener("pointerover", handleOver);
      rail.removeEventListener("pointerout", handleOut);
      rail.removeEventListener("pointerleave", handleLeave);
      rail.removeEventListener("focusin", handleFocusIn);
      rail.removeEventListener("focusout", handleFocusOut);
    };
  }, [clearHoverTimer]);

  const getItems = useCallback((): HTMLElement[] => {
    const rail = railRef.current;
    if (!rail) return [];
    return Array.from(rail.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
      (item) => !item.hasAttribute("data-overview-rail-secondary") && isNavigableItem(item),
    );
  }, []);

  // Items render from several owners (Git actions, branch picker, scripts…),
  // so the rail watches its own subtree instead of asking each for callbacks:
  // any trigger with an open popup keeps its row revealed while the pointer travels
  // into the portaled menu, and the roving tab stop follows items that mount,
  // unmount, or become disabled.
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const sync = () => {
      const nextPopupRows = Array.from(rail.querySelectorAll<HTMLElement>("[data-popup-open]"))
        .map((trigger) => trigger.closest<HTMLElement>(ROW_SELECTOR)?.dataset.overviewRailRow)
        .filter((id): id is string => Boolean(id));
      setPopupRowIds((current) =>
        current.length === nextPopupRows.length && current.every((id, i) => id === nextPopupRows[i])
          ? current
          : nextPopupRows,
      );
      const items = Array.from(rail.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
        isNavigableItem,
      );
      setActiveItemId((current) => {
        if (current && items.some((item) => item.dataset.overviewRailItem === current)) {
          return current;
        }
        return (
          items.find((item) => !item.hasAttribute("data-overview-rail-secondary"))?.dataset
            .overviewRailItem ?? null
        );
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(rail, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-popup-open", "disabled", "aria-disabled"],
    });
    return () => observer.disconnect();
  }, []);

  const collapse = useCallback(() => {
    clearHoverTimer();
    setHoveredRowId(null);
    setFocusedRowId(null);
    setForceCollapsed(true);
    if (pinned) onPinnedChange(false);
    const rail = railRef.current;
    const returnTarget = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnTarget && returnTarget.isConnected && !rail?.contains(returnTarget)) {
      returnTarget.focus({ preventScroll: true });
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && rail?.contains(activeElement)) {
      activeElement.blur();
    }
    onFocusReturnFallback?.();
  }, [clearHoverTimer, onFocusReturnFallback, onPinnedChange, pinned]);

  const handleTogglePinned = useCallback(() => {
    if (pinned) {
      clearHoverTimer();
      setHoveredRowId(null);
      setForceCollapsed(true);
      onPinnedChange(false);
      return;
    }
    setForceCollapsed(false);
    onPinnedChange(true);
  }, [clearHoverTimer, onPinnedChange, pinned]);

  // Capture phase so arrow keys move between items before a trigger (e.g. the
  // branch combobox) can claim them to open its popup.
  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target;
      const rail = railRef.current;
      if (!(target instanceof HTMLElement) || !rail?.contains(target)) return;
      if (!target.matches(ITEM_SELECTOR)) return;
      const items = getItems();
      if (items.length === 0) return;
      const row = target.closest<HTMLElement>(ROW_SELECTOR);
      const primary = row?.matches(ITEM_SELECTOR)
        ? row
        : row?.querySelector<HTMLElement>(`${ITEM_SELECTOR}:not([data-overview-rail-secondary])`);
      const index = primary ? items.indexOf(primary) : -1;
      let next: HTMLElement | undefined;
      if (event.key === "ArrowLeft" && !target.hasAttribute("data-overview-rail-secondary")) {
        next = row?.querySelector<HTMLElement>("[data-overview-rail-secondary]") ?? undefined;
      } else if (
        event.key === "ArrowRight" &&
        target.hasAttribute("data-overview-rail-secondary")
      ) {
        next = primary ?? undefined;
      } else if (event.key === "ArrowDown") {
        next = index < 0 ? items[0] : items[(index + 1) % items.length];
      } else if (event.key === "ArrowUp") {
        next = index < 0 ? items.at(-1) : items[(index - 1 + items.length) % items.length];
      } else if (event.key === "Home") {
        next = items[0];
      } else if (event.key === "End") {
        next = items.at(-1);
      } else {
        return;
      }
      if (!next || !isNavigableItem(next)) return;
      event.preventDefault();
      event.stopPropagation();
      setForceCollapsed(false);
      next.focus();
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [getItems],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const rail = railRef.current;
      // Escape inside a portaled popup belongs to that popup (it closes and
      // hands focus back to its trigger); only Escape on the rail itself
      // collapses the rail.
      if (!(event.target instanceof Node) || !rail?.contains(event.target)) return;
      if (rail.querySelector("[data-popup-open]")) return;
      event.preventDefault();
      collapse();
    },
    [collapse],
  );

  const contextValue = useMemo<OverviewRailContextValue>(
    () => ({
      activeItemId,
      setActiveItemId,
      pinned,
      revealedRowIds: new Set([
        ...popupRowIds,
        ...(!forceCollapsed
          ? [hoveredRowId, focusedRowId].filter((id): id is string => Boolean(id))
          : []),
      ]),
    }),
    [activeItemId, pinned, popupRowIds, forceCollapsed, hoveredRowId, focusedRowId],
  );

  return (
    <OverviewRailContext.Provider value={contextValue}>
      <div
        ref={railRef}
        role="toolbar"
        aria-orientation="vertical"
        aria-label={label}
        data-slot="overview-rail"
        data-expanded={pinned ? "true" : "false"}
        data-pinned={pinned ? "true" : "false"}
        onKeyDown={handleKeyDown}
        onKeyDownCapture={handleKeyDownCapture}
        className={cn(
          "group/overview-rail selection-glass-surface pointer-events-none flex max-h-full min-h-0 flex-col items-end rounded-[22px] border",
          "w-11 data-[expanded=true]:w-64",
          "transition-[width] duration-(--app-motion-duration-sheet) ease-(--app-motion-ease) motion-reduce:transition-none",
          className,
        )}
      >
        <div
          id={listId}
          className="pointer-events-none flex w-[254px] min-h-0 flex-1 flex-col items-end overflow-x-hidden overflow-y-auto overscroll-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {children}
        </div>
        <OverviewRailSeparator />
        <div className="pointer-events-none flex w-[254px] shrink-0 flex-col items-end pb-1">
          <OverviewRailButton
            icon={pinned ? <ChevronsRightIcon /> : <ChevronsLeftIcon />}
            label={pinned ? "Collapse" : "Keep expanded"}
            aria-label={pinned ? "Collapse overview" : "Expand overview"}
            aria-expanded={pinned}
            aria-controls={listId}
            data-overview-rail-toggle=""
            onClick={handleTogglePinned}
          />
        </div>
      </div>
    </OverviewRailContext.Provider>
  );
}

export function OverviewRailSeparator() {
  // Sits under the icon column while collapsed and spans the row once
  // expanded, so it reads as a group break at both widths.
  return (
    <div
      aria-hidden
      className="my-1 mr-[11px] h-px w-5 shrink-0 self-end bg-border/70 transition-[width] duration-(--app-motion-duration-sheet) ease-(--app-motion-ease) group-data-[expanded=true]/overview-rail:w-[calc(100%-22px)] motion-reduce:transition-none"
    />
  );
}

const TONE_DOT_CLASS: Record<OverviewRailTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  running: "animate-status-pulse bg-sky-400",
  pending: "bg-warning/70",
  primary: "bg-primary",
};

const ROW_CLASS_NAME =
  "group/rail-row pointer-events-auto relative mx-[3px] h-8 w-[248px] shrink-0 rounded-2xl [clip-path:inset(0_0_0_212px_round_16px)] data-[revealed=true]:[clip-path:inset(0_round_16px)] transition-[clip-path,background-color] duration-(--app-motion-duration-sheet) ease-(--app-motion-ease) motion-reduce:transition-none data-[revealed=true]:bg-popover group-data-[pinned=true]/overview-rail:bg-transparent";

function useRailItem() {
  const rail = useContext(OverviewRailContext);
  const itemId = useId();
  return {
    rail,
    itemId,
    tabIndex: rail ? (rail.activeItemId === itemId ? 0 : -1) : undefined,
  };
}

function useRowRevealed(rowId: string) {
  const rail = useContext(OverviewRailContext);
  return Boolean(rail?.pinned || rail?.revealedRowIds.has(rowId));
}

export interface OverviewRailButtonProps extends Omit<
  ComponentProps<"button">,
  "children" | "value"
> {
  icon: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  /** A single status dot on the icon; visible collapsed and expanded. */
  tone?: OverviewRailTone | null | undefined;
  /** The item's surface is showing (drawer open, workspace tab selected). */
  active?: boolean | undefined;
}

/**
 * One rail row. Also the `render` target for Base UI triggers (menus,
 * popovers, the branch combobox), which merge their props into it — the rail
 * still owns the roving tab stop.
 */
export function OverviewRailButton({
  icon,
  label,
  value,
  tone,
  active,
  className,
  onFocus,
  tabIndex,
  ...props
}: OverviewRailButtonProps) {
  const { rail, itemId, tabIndex: rovingTabIndex } = useRailItem();
  const parentRowId = useContext(OverviewRailRowContext);
  const revealed = useRowRevealed(parentRowId ?? itemId);
  const hasValue = value !== undefined && value !== null && value !== false && value !== "";
  return (
    <button
      type="button"
      {...props}
      tabIndex={rail ? rovingTabIndex : tabIndex}
      data-overview-rail-item={itemId}
      data-overview-rail-row={parentRowId ? undefined : itemId}
      data-revealed={revealed ? "true" : "false"}
      data-active={active ? "true" : undefined}
      onFocus={(event) => {
        rail?.setActiveItemId(itemId);
        onFocus?.(event);
      }}
      className={cn(
        parentRowId ? "group/rail-item relative h-8 w-full rounded-2xl" : ROW_CLASS_NAME,
        "group/rail-item grid grid-cols-[minmax(0,1fr)_36px] items-center text-left outline-none",
        parentRowId && "hover:bg-foreground/[0.06]",
        "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
        className,
      )}
    >
      <span
        data-overview-rail-label=""
        className={cn(
          "flex min-w-0 items-center gap-2 pr-1 pl-3 opacity-0 transition-opacity duration-(--app-motion-duration-chip) motion-reduce:transition-none",
          revealed && "opacity-100",
          parentRowId && "pr-9",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground/90">
          {label}
        </span>
        {hasValue ? (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground tabular-nums">
            {value}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative grid size-8 place-items-center justify-self-center rounded-full text-muted-foreground transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
          "group-hover/rail-row:bg-foreground/[0.06] group-hover/rail-row:text-foreground group-focus-visible/rail-item:text-foreground group-data-popup-open/rail-item:text-foreground",
          "group-data-[active=true]/rail-item:bg-foreground/[0.08] group-data-[active=true]/rail-item:text-foreground",
        )}
      >
        {icon}
        {tone ? (
          <span
            data-overview-rail-tone={tone}
            className={cn(
              "absolute top-1 right-1 size-[7px] rounded-full shadow-[0_0_0_2px_var(--color-popover)]",
              TONE_DOT_CLASS[tone],
            )}
          />
        ) : null}
      </span>
    </button>
  );
}

/** Primary action on the icon/label, with a separate options trigger revealed beside it. */
export function OverviewRailAction({
  options,
  disabled,
  onClick,
  ...props
}: OverviewRailButtonProps & { options: ReactElement }) {
  const rowId = useId();
  const revealed = useRowRevealed(rowId);
  const actionDisabled =
    disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true";
  return (
    <OverviewRailRowContext.Provider value={rowId}>
      <div
        data-overview-rail-row={rowId}
        data-revealed={revealed ? "true" : "false"}
        className={ROW_CLASS_NAME}
      >
        <OverviewRailButton
          {...props}
          aria-disabled={actionDisabled || undefined}
          onClick={(event) => {
            if (actionDisabled) return;
            onClick?.(event);
          }}
        />
        <div
          aria-hidden={!revealed || undefined}
          className={cn(
            "absolute top-0 right-10 grid h-8 w-7 place-items-center opacity-0 transition-opacity duration-(--app-motion-duration-chip) motion-reduce:transition-none",
            revealed && "opacity-100",
          )}
        >
          {options}
        </div>
      </div>
    </OverviewRailRowContext.Provider>
  );
}

export function OverviewRailOptionsButton({
  className,
  onFocus,
  tabIndex,
  ...props
}: ComponentProps<"button">) {
  const { rail, itemId } = useRailItem();
  return (
    <button
      type="button"
      {...props}
      tabIndex={rail ? -1 : tabIndex}
      data-overview-rail-item={itemId}
      data-overview-rail-secondary=""
      onFocus={(event) => {
        const primaryId = event.currentTarget
          .closest(ROW_SELECTOR)
          ?.querySelector<HTMLElement>(`${ITEM_SELECTOR}:not([data-overview-rail-secondary])`)
          ?.dataset.overviewRailItem;
        if (primaryId) rail?.setActiveItemId(primaryId);
        onFocus?.(event);
      }}
      className={cn(
        "grid size-6 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground data-popup-open:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
    >
      <MoreHorizontalIcon aria-hidden className="size-3.5" />
    </button>
  );
}

/** Keeps alternatives beside the full row, rather than covering its label. */
export function OverviewRailMenuAction({
  optionsLabel,
  optionsDisabled,
  menuProps,
  popupClassName,
  children,
  ...props
}: Omit<OverviewRailButtonProps, "ref"> & {
  optionsLabel: string;
  optionsDisabled?: boolean;
  menuProps?: Pick<ComponentProps<typeof Menu>, "onOpenChange" | "highlightItemOnHover">;
  popupClassName?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Menu {...menuProps}>
      <OverviewRailAction
        {...props}
        ref={anchorRef}
        options={
          <MenuTrigger
            disabled={optionsDisabled}
            render={<OverviewRailOptionsButton aria-label={optionsLabel} />}
          />
        }
      />
      <MenuPopup
        side="left"
        align="start"
        sideOffset={10}
        anchor={anchorRef}
        className={popupClassName}
      >
        {children}
      </MenuPopup>
    </Menu>
  );
}

/**
 * A rail item whose details live in a focused popover beside the rail. The
 * popover opens to the left so it never covers the rail it came from.
 */
export function OverviewRailPopover({
  trigger,
  title,
  actions,
  className,
  children,
}: {
  trigger: ReactElement;
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        side="left"
        align="start"
        sideOffset={10}
        surface="glass"
        className={cn("w-[21rem]", className)}
        viewportClassName="p-0"
      >
        <div className="flex min-h-10 items-center gap-2 border-b border-border/60 py-1.5 pr-2 pl-3">
          <PopoverTitle className="min-w-0 flex-1 truncate text-[12.5px] leading-5 font-semibold">
            {title}
          </PopoverTitle>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
        <div className="py-1">{children}</div>
      </PopoverPopup>
    </Popover>
  );
}
