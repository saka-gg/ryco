import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
} from "react";

import { readMotionDurationMs } from "../../lib/perf/motion";
import { cn } from "../../lib/utils";
import { Sheet, SheetPopup } from "../ui/sheet";
import { ListResizeHandle, PullRequestListPane } from "./list/PullRequestListPane";
import { PullRequestReader } from "./PullRequestReader";
import { PullRequestsEmptyReader } from "./PullRequestsEmptyReader";
import { usePullRequestsPage, type PullRequestsLayout } from "./PullRequestsPageContext";
import { readerTabButton } from "./pullRequestsFocus";
import {
  PULL_REQUESTS_LIST_WIDTH_VAR,
  usePullRequestsLayoutStore,
} from "./pullRequestsLayoutStore";
import { PULL_REQUESTS_LIST_DOCK_MIN_PAGE_WIDTH } from "./pullRequestsModel.logic";

type ListMotion = { readonly kind: "enter" | "exit"; readonly id: number } | null;

interface ListMotionSeen {
  readonly listVisible: boolean;
  readonly listFillsPage: boolean;
  readonly wide: boolean;
}

/**
 * Spec motion #13: when the docked list is hidden or shown (`\`, entering or
 * leaving Files) the layout snaps first, then the list slides (a ghost on the
 * way out) while the reader FLIPs from where it was. Transforms only, CSS
 * keyframes on the pane token; window resizes across the docking breakpoint
 * and reduced motion stay instant. Derived during render, so the first
 * painted frame already starts at the old position.
 */
function useListVisibilityMotion(layout: PullRequestsLayout): readonly [ListMotion, () => void] {
  const wide = layout.pageWidth >= PULL_REQUESTS_LIST_DOCK_MIN_PAGE_WIDTH;
  const [seen, setSeen] = useState<ListMotionSeen>({
    listVisible: layout.listVisible,
    listFillsPage: layout.listFillsPage,
    wide,
  });
  const [motion, setMotion] = useState<ListMotion>(null);
  if (
    seen.listVisible !== layout.listVisible ||
    seen.listFillsPage !== layout.listFillsPage ||
    seen.wide !== wide
  ) {
    const animate =
      seen.listVisible !== layout.listVisible &&
      seen.wide &&
      wide &&
      !seen.listFillsPage &&
      !layout.listFillsPage &&
      readMotionDurationMs("--app-motion-duration-pane", 360) > 0;
    setSeen({ listVisible: layout.listVisible, listFillsPage: layout.listFillsPage, wide });
    setMotion(
      animate ? { kind: layout.listVisible ? "enter" : "exit", id: (motion?.id ?? 0) + 1 } : null,
    );
  }
  const clear = useCallback(() => setMotion(null), []);
  return [motion, clear] as const;
}

/** Where focus goes when the drawer closes: its opener, or the reader that replaced it. */
function drawerFinalFocus(): HTMLElement | boolean {
  const opener = usePullRequestsLayoutStore.getState().drawerOpener;
  if (opener?.isConnected) return opener;
  return readerTabButton(null) ?? true;
}

/**
 * The page under the providers: the list (full page, docked column or drawer)
 * and the reader (or the empty reader). Split from `PullRequestsPage` so tests
 * render the exact shell inside `PullRequestsTestProvider`.
 */
export function PullRequestsPageBody() {
  const { layout, model, readerKey } = usePullRequestsPage();
  const setDrawerOpen = usePullRequestsLayoutStore((state) => state.setDrawerOpen);
  const [listMotion, clearListMotion] = useListVisibilityMotion(layout);
  const listWidthStyle = {
    width: `var(${PULL_REQUESTS_LIST_WIDTH_VAR}, ${layout.listWidth}px)`,
  } satisfies CSSProperties;
  const ghost = !layout.listVisible && listMotion?.kind === "exit";
  const onMotionEnd = (event: AnimationEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) clearListMotion();
  };

  // Hiding the docked list (`\`, Files) while focus is in it would drop focus
  // to <body> (the column goes inert or away): continue on the reader's tab.
  const listHadFocusRef = useRef(false);
  const listVisible = layout.listVisible;
  useLayoutEffect(() => {
    if (listVisible || !listHadFocusRef.current) return;
    listHadFocusRef.current = false;
    readerTabButton(null)?.focus({ preventScroll: true });
  }, [listVisible]);

  return (
    <>
      {layout.listFillsPage ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PullRequestListPane variant="fill" />
        </div>
      ) : (
        <>
          {layout.listVisible || ghost ? (
            <>
              <aside
                key="pr-list-column"
                aria-label={ghost ? undefined : "Pull requests"}
                aria-hidden={ghost || undefined}
                inert={ghost}
                data-list-motion={listMotion?.kind}
                className={cn(
                  "pr-list-column relative flex min-h-0 shrink-0 flex-col border-r border-border/70",
                  ghost && "absolute inset-y-0 left-0 z-[1]",
                )}
                style={listWidthStyle}
                onAnimationEnd={ghost ? onMotionEnd : undefined}
                onFocusCapture={() => {
                  listHadFocusRef.current = true;
                }}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    listHadFocusRef.current = false;
                  }
                }}
              >
                <PullRequestListPane variant="docked" />
              </aside>
              {layout.listVisible ? <ListResizeHandle /> : null}
            </>
          ) : null}
          {/* SidebarInset is already the page's <main>. */}
          <div
            data-list-motion={listMotion?.kind}
            className="pr-reader-column flex min-h-0 min-w-0 flex-1 flex-col"
            style={
              listMotion
                ? ({ "--pr-list-shift": `${layout.listWidth}px` } as CSSProperties)
                : undefined
            }
            onAnimationEnd={listMotion && !ghost ? onMotionEnd : undefined}
          >
            {model.selection && readerKey ? (
              <PullRequestReader key={readerKey} />
            ) : (
              <PullRequestsEmptyReader />
            )}
          </div>
        </>
      )}
      {!layout.listVisible && !layout.listFillsPage ? (
        <Sheet open={layout.drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetPopup
            side="left"
            aria-label="Pull requests"
            showCloseButton={false}
            finalFocus={drawerFinalFocus}
            className="w-[min(22rem,calc(100%-3rem))] max-w-none p-0"
          >
            <PullRequestListPane variant="drawer" />
          </SheetPopup>
        </Sheet>
      ) : null}
    </>
  );
}
