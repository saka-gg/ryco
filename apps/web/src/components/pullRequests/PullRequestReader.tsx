import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { slidingTabId, slidingTabPanelId } from "../ui/sliding-tabs";
import { ChecksTab } from "./checks/ChecksTab";
import { CommitsTab } from "./commits/CommitsTab";
import { ConversationTab } from "./conversation/ConversationTab";
import { FilesTab } from "./files/FilesTab";
import { PullRequestBar } from "./PullRequestBar";
import { usePullRequestsPage } from "./PullRequestsPageContext";
import {
  readerTabButton,
  takePageFocusHandoff,
  useHandOffFocusOnUnmount,
} from "./pullRequestsFocus";
import { usePullRequestReaderStore } from "./pullRequestsLayoutStore";
import { PULL_REQUESTS_TABS, type PullRequestsTab } from "./pullRequestsSearch";

const TAB_BODIES: Record<PullRequestsTab, () => React.ReactElement> = {
  conversation: ConversationTab,
  files: FilesTab,
  checks: ChecksTab,
  commits: CommitsTab,
};

const EMPTY_VISITED: ReadonlyArray<PullRequestsTab> = [];

/**
 * One change request: the bar, then every tab the reader has visited, kept
 * mounted (hidden and inert) behind the active one so scroll position, drafts
 * and expanded rows survive tab switches. Keyed by `readerKey` in the page, so
 * a new selection mounts a fresh reader that settles in from the direction of
 * travel (or, for a stack layer, pushes its body while the bar title rolls).
 */
export function PullRequestReader() {
  const { nav, readerKey, selectionMotion } = usePullRequestsPage();
  const tab = nav.tab;
  const tabsId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const visited = usePullRequestReaderStore((state) =>
    readerKey ? (state.visitedTabs[readerKey] ?? EMPTY_VISITED) : EMPTY_VISITED,
  );
  const markTabVisited = usePullRequestReaderStore((state) => state.markTabVisited);
  useEffect(() => {
    if (readerKey) markTabVisited(readerKey, tab);
  }, [markTabVisited, readerKey, tab]);

  // Focus survives the remount: when the reader (or the full-page list) that
  // held focus was replaced by this one, continue on this reader's active tab.
  useHandOffFocusOnUnmount(rootRef);
  useLayoutEffect(() => {
    if (!takePageFocusHandoff()) return;
    readerTabButton(null, rootRef.current ?? document)?.focus({ preventScroll: true });
  }, []);

  // A tab switch shows the incoming pane with a short directional enter; the
  // class stays until its animation ends so re-renders cannot cut it short.
  const previousTabRef = useRef(tab);
  const [entering, setEntering] = useState<{ tab: PullRequestsTab; direction: 1 | -1 } | null>(
    null,
  );
  useLayoutEffect(() => {
    const previous = previousTabRef.current;
    if (previous === tab) return;
    previousTabRef.current = tab;
    setEntering({
      tab,
      direction: PULL_REQUESTS_TABS.indexOf(tab) > PULL_REQUESTS_TABS.indexOf(previous) ? 1 : -1,
    });
    // The panel that held focus just went inert (`1`–`4` pressed inside it):
    // move focus to the new tab instead of letting it fall to <body>.
    const root = rootRef.current;
    const active = document.activeElement;
    const previousPanel = root?.querySelector(`[role="tabpanel"][data-tab="${previous}"]`);
    if (root && active && previousPanel?.contains(active)) {
      readerTabButton(tab, root)?.focus({ preventScroll: true });
    }
  }, [tab]);

  // Captured once per mount: the reader settles in only for the selection that created it.
  const [mountMotion] = useState(selectionMotion);
  const settleDirection = mountMotion.kind === "none" ? 0 : mountMotion.direction;

  return (
    <div
      ref={rootRef}
      data-reader-motion={mountMotion.kind}
      className={cn(
        "pr-reader @container/reader flex min-h-0 min-w-0 flex-1 flex-col",
        mountMotion.kind === "settle" && "pr-reader-settle",
      )}
      style={{ "--pr-motion-dir": settleDirection } as CSSProperties}
    >
      <PullRequestBar
        tabsId={tabsId}
        visitedTabs={visited}
        titleRollFrom={
          mountMotion.kind === "push" && mountMotion.from
            ? { ...mountMotion.from, direction: mountMotion.direction }
            : null
        }
      />
      {/* The body alone takes part in the stack-layer push; the bar stays. */}
      <div className="pr-reader-body relative min-h-0 flex-1">
        {PULL_REQUESTS_TABS.map((candidate) => {
          if (candidate !== tab && !visited.includes(candidate)) return null;
          const Body = TAB_BODIES[candidate];
          const active = candidate === tab;
          return (
            <div
              key={candidate}
              id={slidingTabPanelId(tabsId, candidate)}
              role="tabpanel"
              aria-labelledby={slidingTabId(tabsId, candidate)}
              aria-hidden={!active}
              inert={!active}
              data-tab={candidate}
              className={cn(
                "absolute inset-0 flex min-h-0 flex-col",
                active ? "visible" : "invisible pointer-events-none",
                active && entering?.tab === candidate && "pr-tab-enter",
              )}
              style={{ "--pr-motion-dir": entering?.direction ?? 1 } as CSSProperties}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget && entering?.tab === candidate) {
                  setEntering(null);
                }
              }}
            >
              <Body />
            </div>
          );
        })}
      </div>
    </div>
  );
}
