import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface SlidingTab {
  readonly id: string;
  readonly label: ReactNode;
  /**
   * Optional glyph. Rendered (hidden by default) as `[data-slot="tab-icon"]`
   * so a narrow container can swap inactive labels for it in CSS.
   */
  readonly icon?: ReactNode;
  /** Quantity shown after the label (omit to hide). */
  readonly count?: number | undefined;
  /** Accessible name when `label` is not plain text. */
  readonly ariaLabel?: string | undefined;
  readonly title?: string | undefined;
  /**
   * Whether the tab's panel is in the DOM (with `slidingTabPanelId`), so the
   * tab can point at it with `aria-controls`. Defaults to true when `idPrefix` is set.
   */
  readonly hasPanel?: boolean | undefined;
}

/** The `id` SlidingTabs gives a tab when it has an `idPrefix`. */
export function slidingTabId(idPrefix: string, tabId: string): string {
  return `${idPrefix}-tab-${tabId}`;
}

/** The `id` a tab's panel should carry (and `aria-labelledby={slidingTabId(…)}`). */
export function slidingTabPanelId(idPrefix: string, tabId: string): string {
  return `${idPrefix}-panel-${tabId}`;
}

/**
 * Roving keyboard movement for a horizontal composite (tabs, segmented radio
 * groups): ←/→ step with wrap-around, Home/End jump. Returns the index to move
 * to, or null when the key is not a movement key.
 */
export function rovingTargetIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * A tab strip with one travelling indicator: a pill behind the active tab, or
 * an underline under it. The indicator is measured after layout and only
 * starts animating after its first placement, so it never slides in from 0 on
 * mount; it follows the house stack/gentle curve and stops under reduced
 * motion via the zeroed duration token.
 *
 * Keyboard: one Tab stop (the active tab); ←/→/Home/End move focus and select
 * (automatic activation). With `idPrefix`, tabs carry ids and `aria-controls`
 * so panels can be labelled by them.
 */
export const SlidingTabs = memo(function SlidingTabs(props: {
  readonly tabs: ReadonlyArray<SlidingTab>;
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly variant?: "pill" | "underline";
  readonly density?: "default" | "compact";
  readonly className?: string;
  readonly tabClassName?: string;
  readonly "aria-label"?: string;
  /** Prefix for tab ids (`slidingTabId`) and their panels' ids (`slidingTabPanelId`). */
  readonly idPrefix?: string | undefined;
  /** Called when a tab is hovered or focused (e.g. to preload its content). */
  readonly onTabIntent?: (id: string) => void;
}) {
  const variant = props.variant ?? "pill";
  const tablistRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ width: 0, height: 0, x: 0, y: 0, visible: false });
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const tablist = tablistRef.current;
    if (!tablist) return;
    const measure = () => {
      const active = tablist.querySelector<HTMLElement>(
        `[data-sliding-tab-id="${CSS.escape(props.activeId)}"]`,
      );
      if (!active) {
        setIndicator((current) => ({ ...current, visible: false }));
        return;
      }
      setIndicator({
        width: active.offsetWidth,
        height: active.offsetHeight,
        x: active.offsetLeft,
        y: active.offsetTop,
        visible: true,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tablist);
    return () => observer.disconnect();
  }, [props.activeId, props.tabs]);

  useLayoutEffect(() => {
    if (animate || !indicator.visible) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [animate, indicator.visible]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = props.tabs.findIndex((tab) => tab.id === props.activeId);
    const target = rovingTargetIndex(event.key, Math.max(0, index), props.tabs.length);
    if (target === null) return;
    const next = props.tabs[target];
    if (!next) return;
    event.preventDefault();
    if (next.id !== props.activeId) props.onSelect(next.id);
    tablistRef.current
      ?.querySelector<HTMLElement>(`[data-sliding-tab-id="${CSS.escape(next.id)}"]`)
      ?.focus();
  };

  const activeExists = props.tabs.some((tab) => tab.id === props.activeId);
  const compact = props.density === "compact";
  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label={props["aria-label"]}
      aria-orientation="horizontal"
      className={cn("relative isolate flex min-w-0 items-center gap-1", props.className)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 z-0",
          variant === "pill"
            ? "top-0 rounded-md bg-accent"
            : "bottom-0 h-[1.5px] rounded-full bg-foreground",
          animate &&
            "transition-[transform,width,height,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
          indicator.visible ? "opacity-100" : "opacity-0",
        )}
        style={
          variant === "pill"
            ? {
                width: indicator.width,
                height: indicator.height,
                transform: `translate(${indicator.x}px, ${indicator.y}px)`,
              }
            : { width: indicator.width, transform: `translateX(${indicator.x}px)` }
        }
      />
      {props.tabs.map((tab, index) => {
        const selected = props.activeId === tab.id;
        // One Tab stop: the active tab (the first one if none is active).
        const tabStop = selected || (!activeExists && index === 0);
        const controls =
          props.idPrefix !== undefined && (tab.hasPanel ?? true)
            ? slidingTabPanelId(props.idPrefix, tab.id)
            : undefined;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={props.idPrefix !== undefined ? slidingTabId(props.idPrefix, tab.id) : undefined}
            aria-selected={selected}
            aria-controls={controls}
            aria-label={tab.ariaLabel}
            tabIndex={tabStop ? 0 : -1}
            title={tab.title}
            data-sliding-tab-id={tab.id}
            onClick={() => props.onSelect(tab.id)}
            onPointerEnter={props.onTabIntent ? () => props.onTabIntent?.(tab.id) : undefined}
            onFocus={props.onTabIntent ? () => props.onTabIntent?.(tab.id) : undefined}
            className={cn(
              "relative z-10 inline-flex shrink-0 items-center gap-1 rounded-md text-xs whitespace-nowrap outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring",
              compact ? "px-2 py-1" : variant === "underline" ? "h-full px-2" : "px-2 py-1",
              selected
                ? variant === "pill"
                  ? "text-accent-foreground"
                  : "text-foreground"
                : "text-muted-foreground hover:text-foreground",
              props.tabClassName,
            )}
          >
            {tab.icon ? (
              <span data-slot="tab-icon" aria-hidden className="hidden items-center">
                {tab.icon}
              </span>
            ) : null}
            <span data-slot="tab-label">{tab.label}</span>
            {typeof tab.count === "number" ? (
              <span data-slot="tab-count" className="text-[11px] tabular-nums opacity-55">
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
});
