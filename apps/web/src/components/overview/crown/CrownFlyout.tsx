import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { OverviewLayoutProps } from "../overviewTypes";
import { CrownNotesDetail, CrownSectionDetail } from "./details/CrownSectionDetail";
import { computeFlyoutPlacement } from "./crownGeometry.logic";
import { CROWN_FLYOUT_GAP_PX, CROWN_FLYOUT_WIDTH_PX } from "./crownLayout";
import {
  CROWN_SECTION_LABEL,
  crownSectionForRailKey,
  type CrownRailKey,
  type CrownSection,
} from "./crownSections";
import type { CrownNotesBinding } from "./crownTypes";

type FlyoutSection = CrownSection;

interface FlyoutEntry {
  readonly key: number;
  readonly section: FlyoutSection;
  readonly phase: "idle" | "enter" | "leave";
}

/** Prototype `Flyout.swap()`: the leaving layer is dropped once its fade is done. */
const LEAVING_LAYER_MS = 230;
/** Prototype `Flyout.close()`: content stays through the fade-out, then goes. */
const CLOSED_CONTENT_MS = 280;

function flyoutSection(key: CrownRailKey | null, hasNotes: boolean): FlyoutSection | null {
  if (key === null) return null;
  const section = crownSectionForRailKey(key);
  return section === "notes" && !hasNotes ? null : section;
}

function isEditable(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || element.closest("input, textarea, select") !== null)
  );
}

/**
 * Focus that holds the preview open: a text field, or keyboard focus on any
 * control inside (Tab from the composer to Save). A mouse click on a button
 * does not, so a hover preview never pins itself open.
 */
function holdsFlyout(element: Element | null): boolean {
  return (
    isEditable(element) || (element instanceof HTMLElement && element.matches(":focus-visible"))
  );
}

/**
 * The rail's hover preview (prototype `Flyout` with the island material): one
 * panel that grows out of the hovered icon, glides between icons and
 * cross-fades its content. Custom rather than a base-ui popover so it stays
 * inside the crown's dark tokens and motion scope, and positioned by hand so
 * its transform origin can sit on the icon.
 *
 * A hover preview, not an interaction surface: the details render their
 * read-only flyout variant, and the card hosts the stateful controls. The
 * Notes preview is the exception, as in the prototype: its composer works
 * here too, and while it has focus the crown holds the flyout open. It is a
 * labelled non-modal group, inert while closed and in its leaving layer, so
 * hidden content is never focusable. Keyboard users get the same detail in
 * the card.
 */
export function CrownFlyout(props: {
  readonly openKey: CrownRailKey | null;
  readonly anchorEl: HTMLElement | null;
  /** The crown root the flyout is positioned in. */
  readonly rootRef: RefObject<HTMLElement | null>;
  /** The rail the flyout sits beside. */
  readonly railRef: RefObject<HTMLElement | null>;
  readonly layout: OverviewLayoutProps;
  readonly isGitRepo: boolean;
  readonly reducedMotion: boolean;
  readonly notes?: CrownNotesBinding | undefined;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  /** Focus inside started or stopped holding the preview (the Notes composer, keyboard focus). */
  readonly onEditingChange?: (editing: boolean) => void;
}) {
  const { anchorEl, rootRef, railRef, reducedMotion, notes, onEditingChange } = props;
  const section = flyoutSection(props.openKey, notes !== undefined);
  const open = section !== null && anchorEl !== null;
  const flyRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchorEl);

  // Content layers, swapped like RollingText entries (adjusted during render).
  const [entries, setEntries] = useState<ReadonlyArray<FlyoutEntry>>([]);
  const [shownSection, setShownSection] = useState<FlyoutSection | null>(null);
  if (section !== shownSection) {
    setShownSection(section);
    if (section !== null) {
      const key = entries.reduce((max, entry) => Math.max(max, entry.key), 0) + 1;
      const animate = shownSection !== null && !reducedMotion;
      setEntries(
        animate
          ? [
              ...entries
                .filter((entry) => entry.phase !== "leave")
                .map((entry): FlyoutEntry => ({
                  key: entry.key,
                  section: entry.section,
                  phase: "leave",
                })),
              { key, section, phase: "enter" },
            ]
          : [{ key, section, phase: "idle" }],
      );
    }
  }
  const current = entries.findLast((entry) => entry.phase !== "leave") ?? null;
  const enteringKey = entries.find((entry) => entry.phase === "enter")?.key ?? null;
  const leavingKeys = entries
    .filter((entry) => entry.phase === "leave")
    .map((entry) => entry.key)
    .join(",");

  // The entering layer settles on the second frame, so its start state paints first.
  useEffect(() => {
    if (enteringKey === null) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() =>
        setEntries((list) =>
          list.map((entry) =>
            entry.key === enteringKey ? { ...entry, phase: "idle" as const } : entry,
          ),
        ),
      );
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [enteringKey]);

  useEffect(() => {
    if (leavingKeys === "") return;
    const keys = new Set(leavingKeys.split(",").map(Number));
    const timer = setTimeout(
      () => setEntries((list) => list.filter((entry) => !keys.has(entry.key))),
      reducedMotion ? 0 : LEAVING_LAYER_MS,
    );
    return () => clearTimeout(timer);
  }, [leavingKeys, reducedMotion]);

  useEffect(() => {
    if (section !== null) return;
    const timer = setTimeout(() => setEntries([]), reducedMotion ? 0 : CLOSED_CONTENT_MS);
    return () => clearTimeout(timer);
  }, [section, reducedMotion]);

  /** Prototype `Flyout.fit()`: beside the rail, next to the icon, clamped to the bounds. */
  const fit = useCallback(() => {
    const fly = flyRef.current;
    const root = rootRef.current;
    const rail = railRef.current;
    const anchor = anchorRef.current;
    const layer = fly?.querySelector<HTMLElement>(
      '[data-slot="crown-flyout-layer"]:not([data-phase="leave"])',
    );
    if (!fly || !root || !rail || !anchor || !layer) return;
    const bounds = root.parentElement ?? document.documentElement;
    const boundsRect = bounds.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const placement = computeFlyoutPlacement({
      anchorTop: anchorRect.top - boundsRect.top,
      anchorHeight: anchorRect.height,
      contentHeight: layer.offsetHeight,
      boundsHeight: bounds.clientHeight,
      // The crown starts below the chat header's clearance; so does the flyout.
      topInset: rootRect.top - boundsRect.top,
    });
    const railLeft = rail.getBoundingClientRect().left;
    fly.style.setProperty("--fly-max", `${placement.maxHeight}px`);
    fly.style.right = `${rootRect.right - railLeft + CROWN_FLYOUT_GAP_PX}px`;
    fly.style.top = `${placement.top - (rootRect.top - boundsRect.top)}px`;
    fly.style.height = `${placement.height}px`;
    fly.style.setProperty("--oy", `${placement.originY}px`);
  }, [railRef, rootRef]);

  // Open / move / close imperatively, so the first open can snap into place before animating.
  const currentKey = current?.key ?? null;
  useLayoutEffect(() => {
    const previousAnchor = anchorRef.current;
    anchorRef.current = anchorEl;
    const fly = flyRef.current;
    if (!fly) return;
    // `currentKey` also refits when the content layer swaps.
    if (!open || currentKey === null) {
      // Focus inside goes back to its icon before the closed panel turns inert.
      if (fly.contains(document.activeElement) && previousAnchor?.closest("[inert]") === null) {
        previousAnchor.focus({ preventScroll: true });
      }
      fly.inert = true;
      delete fly.dataset.open;
      return;
    }
    fly.inert = false;
    if (fly.dataset.open === undefined) {
      fly.dataset.snap = "true";
      fit();
      void fly.offsetWidth;
      delete fly.dataset.snap;
      fly.dataset.open = "true";
    } else {
      fit();
    }
  }, [open, anchorEl, currentKey, fit]);

  // Keep the height fitted to the current layer as its content changes.
  useEffect(() => {
    const fly = flyRef.current;
    if (!open || currentKey === null || !fly || typeof ResizeObserver === "undefined") return;
    const layer = fly.querySelector<HTMLElement>(`[data-flyout-key="${currentKey}"]`);
    if (!layer) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(layer);
    return () => observer.disconnect();
  }, [open, currentKey, fit]);

  return (
    <div
      ref={flyRef}
      role="group"
      aria-label={current ? `${CROWN_SECTION_LABEL[current.section]} preview` : undefined}
      className="crown-flyout crown-mat"
      data-slot="crown-flyout"
      data-section={current?.section}
      style={{ width: CROWN_FLYOUT_WIDTH_PX }}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      onFocus={(event) => onEditingChange?.(holdsFlyout(event.target))}
      onBlur={(event) => {
        const next = event.relatedTarget;
        // Focus moving within the preview is judged by the focus event that follows.
        if (next instanceof Element && event.currentTarget.contains(next)) return;
        onEditingChange?.(false);
      }}
    >
      {entries.map((entry) => (
        <div
          key={entry.key}
          className="crown-flyout-layer"
          data-slot="crown-flyout-layer"
          data-flyout-key={entry.key}
          data-phase={entry.phase}
          inert={entry.phase === "leave" || undefined}
        >
          {entry.section === "notes" ? (
            notes ? (
              <CrownNotesDetail notes={notes} variant="flyout" />
            ) : null
          ) : (
            <CrownSectionDetail
              section={entry.section}
              variant="flyout"
              layout={props.layout}
              isGitRepo={props.isGitRepo}
            />
          )}
        </div>
      ))}
    </div>
  );
}
