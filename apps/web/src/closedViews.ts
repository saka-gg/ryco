import type { ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";

import { closePane, paneKey, type PaneNode } from "./chatPanes.logic";
import type { DraftId } from "./composerDraftStore";
import type { RightPanelTabTarget } from "./rightPanelTabs.logic";

/**
 * Views closed in this window, newest first, so they can be reopened:
 * workspace tabs with the thread or draft that showed them, and split panes
 * with the layout they left. Identifiers only, in memory only: never
 * persisted or relayed, and a reload starts over.
 */

/** The route a closed workspace tab belonged to. */
export type ClosedViewOwner =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | { readonly kind: "draft"; readonly draftId: DraftId };

export type ClosedView =
  | {
      readonly kind: "tab";
      readonly owner: ClosedViewOwner;
      readonly target: RightPanelTabTarget;
    }
  | {
      readonly kind: "pane";
      readonly ref: ScopedThreadRef;
      /** The split just before the pane closed. */
      readonly layout: PaneNode;
    };

export const CLOSED_VIEW_LIMIT = 20;

/** What reopening an entry finds right now. */
export type ClosedViewVerdict =
  /** It comes back; the entry is used up. */
  | "reopen"
  /** It never can: its thread is gone or archived, or it is open again. */
  | "drop"
  /** Not reachable yet (its environment is still connecting); a later try may succeed. */
  | "keep";

function closedViewOwnerKey(owner: ClosedViewOwner): string {
  return owner.kind === "thread"
    ? `thread:${scopedThreadKey(owner.ref)}`
    : `draft:${owner.draftId}`;
}

export function sameClosedViewOwner(left: ClosedViewOwner, right: ClosedViewOwner): boolean {
  return closedViewOwnerKey(left) === closedViewOwnerKey(right);
}

/** One entry per view. A scope has one page tab, so its newest page replaces the last. */
function closedViewKey(view: ClosedView): string {
  if (view.kind === "pane") return `pane:${paneKey(view.ref)}`;
  const owner = closedViewOwnerKey(view.owner);
  switch (view.target.kind) {
    case "tab":
      return `${owner}|tab:${view.target.mode}`;
    case "agent":
      return `${owner}|agent:${view.target.agentKey}`;
    case "render":
      return `${owner}|render`;
  }
}

/** `view` on top; closing a view again moves it up instead of adding a second entry. */
export function pushClosedView(
  stack: ReadonlyArray<ClosedView>,
  view: ClosedView,
): ReadonlyArray<ClosedView> {
  const key = closedViewKey(view);
  return [view, ...stack.filter((entry) => closedViewKey(entry) !== key)].slice(
    0,
    CLOSED_VIEW_LIMIT,
  );
}

/**
 * `from`'s closed tabs as `to`'s (a draft that became a thread), in place;
 * where `to` already had the same view, the newer entry stays.
 */
export function moveClosedTabs(
  stack: ReadonlyArray<ClosedView>,
  from: ClosedViewOwner,
  to: ClosedViewOwner,
): ReadonlyArray<ClosedView> {
  const seen = new Set<string>();
  return stack.flatMap((entry) => {
    const moved =
      entry.kind === "tab" && sameClosedViewOwner(entry.owner, from)
        ? { ...entry, owner: to }
        : entry;
    const key = closedViewKey(moved);
    if (seen.has(key)) return [];
    seen.add(key);
    return [moved];
  });
}

/**
 * The newest entry `verdict` reopens, and the stack without it and without
 * the entries above it that can never come back. Kept entries stay in place.
 */
export function pickClosedView(
  stack: ReadonlyArray<ClosedView>,
  verdict: (view: ClosedView) => ClosedViewVerdict,
): { readonly view: ClosedView | null; readonly stack: ReadonlyArray<ClosedView> } {
  const kept: ClosedView[] = [];
  for (const [index, entry] of stack.entries()) {
    const decision = verdict(entry);
    if (decision === "reopen") return { view: entry, stack: [...kept, ...stack.slice(index + 1)] };
    if (decision === "keep") kept.push(entry);
  }
  return { view: null, stack: kept };
}

/** Same panes in the same places with the same ratios. */
function samePaneLayout(left: PaneNode, right: PaneNode): boolean {
  if (left.kind === "thread") {
    return right.kind === "thread" && paneKey(left.ref) === paneKey(right.ref);
  }
  return (
    right.kind === "split" &&
    left.axis === right.axis &&
    left.ratio === right.ratio &&
    samePaneLayout(left.first, right.first) &&
    samePaneLayout(left.second, right.second)
  );
}

/**
 * The split a closed pane left, while nothing has changed since: `current` is
 * exactly what closing it produced. Otherwise null, and the pane goes beside
 * the focused one instead.
 */
export function restoreClosedPaneLayout(
  current: PaneNode,
  ref: ScopedThreadRef,
  layout: PaneNode,
): PaneNode | null {
  const remaining = closePane(layout, ref);
  return remaining && samePaneLayout(remaining, current) ? layout : null;
}

let closedViews: ReadonlyArray<ClosedView> = [];

export function rememberClosedView(view: ClosedView): void {
  closedViews = pushClosedView(closedViews, view);
}

/** Tabs closed on a draft reopen on the thread it became. */
export function handOverClosedTabs(from: ClosedViewOwner, to: ClosedViewOwner): void {
  closedViews = moveClosedTabs(closedViews, from, to);
}

/** Takes the newest view `verdict` reopens, forgetting the ones that can never come back. */
export function takeClosedView(
  verdict: (view: ClosedView) => ClosedViewVerdict,
): ClosedView | null {
  const picked = pickClosedView(closedViews, verdict);
  closedViews = picked.stack;
  return picked.view;
}

export function resetClosedViewsForTests(): void {
  closedViews = [];
}
