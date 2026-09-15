import { navigateWithPreviewGuard } from "../../previewNavigation";
import type { ScopedThreadRef } from "@ryco/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  closePane,
  decodePaneRef,
  paneContains,
  paneDropSide,
  paneKey,
  paneLeaves,
  resizePane,
  PANE_DRAG_TYPE,
  type PaneNode,
  type PaneSide,
} from "../../chatPanes.logic";
import { useChatPanesStore } from "../../chatPanesStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { selectThreadExistsByRef, selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { useDraftThreadExistsByRef } from "../../composerDraftSelectors";
import { flushPreviewFiles } from "../previewFileSessions";
import { toastManager } from "../ui/toast";
import { retainDesktopWorkspaceThreadScope } from "../../platform/desktopWorkspace";
import {
  PaneFocusContext,
  PaneThreadContext,
  PaneCloseGuardContext,
  type PaneCloseGuard,
} from "./PaneFocus";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Divider {
  path: string;
  node: Extract<PaneNode, { kind: "split" }>;
  rect: Rect;
}
function geometry(
  node: PaneNode,
  rect: Rect,
  path = "",
  leaves: { ref: ScopedThreadRef; rect: Rect }[] = [],
  dividers: Divider[] = [],
) {
  if (node.kind === "thread") leaves.push({ ref: node.ref, rect });
  else {
    dividers.push({ path, node, rect });
    const horizontal = node.axis === "horizontal";
    geometry(
      node.first,
      {
        ...rect,
        width: horizontal ? rect.width * node.ratio : rect.width,
        height: horizontal ? rect.height : rect.height * node.ratio,
      },
      `${path}0`,
      leaves,
      dividers,
    );
    geometry(
      node.second,
      {
        left: rect.left + (horizontal ? rect.width * node.ratio : 0),
        top: rect.top + (horizontal ? 0 : rect.height * node.ratio),
        width: horizontal ? rect.width * (1 - node.ratio) : rect.width,
        height: horizontal ? rect.height : rect.height * (1 - node.ratio),
      },
      `${path}1`,
      leaves,
      dividers,
    );
  }
  return { leaves, dividers };
}
function PaneTitle({ threadRef, index }: { threadRef: ScopedThreadRef; index: number }) {
  const title = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef)?.title);
  return (
    <span className="block truncate">
      {index + 1} · {title ?? "Thread"}
    </span>
  );
}

function PaneThread({
  threadRef,
  focused,
  children,
  guards,
  inSplit,
}: {
  threadRef: ScopedThreadRef;
  focused: boolean;
  children: ReactNode;
  guards: Map<string, Set<PaneCloseGuard>>;
  inSplit: boolean;
}) {
  useEffect(
    () => retainDesktopWorkspaceThreadScope(threadRef.environmentId, threadRef.threadId),
    [threadRef.environmentId, threadRef.threadId],
  );
  const register = useMemo(
    () => (guard: PaneCloseGuard) => {
      const key = paneKey(threadRef),
        entries = guards.get(key) ?? new Set<PaneCloseGuard>();
      entries.add(guard);
      guards.set(key, entries);
      return () => {
        entries.delete(guard);
        if (!entries.size) guards.delete(key);
      };
    },
    [guards, threadRef],
  );
  return (
    <PaneThreadContext value={inSplit ? threadRef : null}>
      <PaneFocusContext value={focused}>
        <PaneCloseGuardContext value={register}>{children}</PaneCloseGuardContext>
      </PaneFocusContext>
    </PaneThreadContext>
  );
}

export function PaneThreadAvailability({
  threadRef,
  children,
}: {
  threadRef: ScopedThreadRef;
  children: ReactNode;
}) {
  const exists = useStore(
    (s) =>
      selectThreadExistsByRef(s, threadRef) &&
      !selectSidebarThreadSummaryByRef(s, threadRef)?.archivedAt,
  );
  const draftExists = useDraftThreadExistsByRef(threadRef);
  if (!exists && !draftExists)
    return (
      <div className="m-auto p-4 text-center text-sm text-muted-foreground" role="status">
        Thread unavailable. Reconnect to its machine or close this pane.
      </div>
    );
  return children;
}

/** Flat keyed children preserve ChatView/composer identity when the tree is rearranged. */
export function ChatPanes({
  threadRef,
  children,
  enabled = true,
}: {
  threadRef: ScopedThreadRef;
  enabled?: boolean;
  children: (ref: ScopedThreadRef, focused: boolean) => ReactNode;
}) {
  const storedRoot = useChatPanesStore((s) => s.root);
  const root = useMemo<PaneNode>(
    () =>
      enabled && storedRoot && paneContains(storedRoot, threadRef)
        ? storedRoot
        : { kind: "thread", ref: threadRef },
    [enabled, storedRoot, threadRef],
  );
  const split = root.kind === "split";
  const navigate = useNavigate();
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [drop, setDrop] = useState<{ key: string; side: PaneSide } | null>(null);
  const [resizing, setResizing] = useState<PaneNode | null>(null);
  const dragResize = useRef<{
    divider: Divider;
    bounds: DOMRect;
    original: PaneNode;
    current: PaneNode;
    pointerId: number;
  } | null>(null);
  const currentRoot = useRef(root);
  useLayoutEffect(() => {
    currentRoot.current = root;
  }, [root]);
  const [guards] = useState(() => new Map<string, Set<PaneCloseGuard>>());
  const abort = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, []);
  const operation = useRef(false);
  const lastFocusedElement = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const focus = useCallback(
    async (ref: ScopedThreadRef) => {
      if (paneKey(ref) === paneKey(threadRef)) return;
      const destination = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
      await navigateWithPreviewGuard(
        destination.pathname,
        () => navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }),
        abort.current!.signal,
      );
    },
    [abort, navigate, router, threadRef],
  );
  useEffect(() => {
    useChatPanesStore.getState().setActiveRef(enabled ? threadRef : null);
    return () => useChatPanesStore.getState().setActiveRef(null);
  }, [enabled, threadRef]);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const update = () => setNarrow(node.clientWidth < 900 || node.clientHeight < 520);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const close = async (ref: ScopedThreadRef) => {
    if (operation.current) return;
    operation.current = true;
    const original = currentRoot.current;
    try {
      for (const guard of guards.get(paneKey(ref)) ?? []) {
        if (!(await guard())) {
          toastManager.add({
            type: "warning",
            title: "Finish or discard this pane’s unsent selection draft before closing it",
          });
          return;
        }
      }
      if (!(await flushPreviewFiles())) {
        toastManager.add({
          type: "error",
          title: "Editor changes could not be saved",
          description:
            "This pane and its draft are preserved. Resolve the error in File Preview before closing.",
        });
        return;
      }
      if (currentRoot.current !== original) return;
      const next = closePane(original, ref);
      if (!next) return;
      if (paneKey(ref) === paneKey(threadRef)) {
        const survivor = paneLeaves(next)[0]!;
        await focus(survivor);
        const destination = router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(survivor),
        });
        if (router.state.location.pathname !== destination.pathname) return;
      }
      if (useChatPanesStore.getState().root === original)
        useChatPanesStore.getState().setRoot(next);
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not close the pane",
        description: "The pane and its draft are preserved.",
      });
    } finally {
      operation.current = false;
    }
  };
  const activate = async (ref: ScopedThreadRef, target?: HTMLElement | null) => {
    // One navigation at a time. A blocked save cannot race later targets or
    // replay a button action against a different thread.
    if (operation.current) return;
    operation.current = true;
    try {
      await focus(ref);
      const destination = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
      if (!mounted.current) return;
      if (router.state.location.pathname === destination.pathname && target?.isConnected)
        target.focus({ preventScroll: true });
      else if (lastFocusedElement.current?.isConnected)
        lastFocusedElement.current.focus({ preventScroll: true });
    } catch {
      toastManager.add({ type: "error", title: "Could not activate the thread pane" });
      if (mounted.current) lastFocusedElement.current?.focus({ preventScroll: true });
    } finally {
      operation.current = false;
    }
  };
  const layout = geometry(resizing ?? root, { left: 0, top: 0, width: 100, height: 100 });
  return (
    <div
      ref={container}
      data-chat-panes
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {split && narrow ? (
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-b p-1"
          role="tablist"
          aria-label="Split threads"
        >
          {layout.leaves.map(({ ref }, i) => (
            <button
              type="button"
              role="tab"
              aria-selected={paneKey(ref) === paneKey(threadRef)}
              key={paneKey(ref)}
              className="rounded px-3 py-1 text-xs aria-selected:bg-accent"
              onClick={() => void activate(ref)}
            >
              <PaneTitle threadRef={ref} index={i} />
            </button>
          ))}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {layout.leaves.map(({ ref, rect }, i) => {
          const key = paneKey(ref),
            focused = key === paneKey(threadRef);
          const visible = !split || !narrow || focused;
          return (
            <section
              key={key}
              data-pane-thread={key}
              data-pane-focused={focused}
              aria-label={`Thread pane ${i + 1}`}
              className="absolute flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
              hidden={!visible}
              inert={!visible ? true : undefined}
              style={{
                display: visible ? undefined : "none",
                left: `${narrow ? 0 : rect.left}%`,
                top: `${narrow ? 0 : rect.top}%`,
                width: `${narrow ? 100 : rect.width}%`,
                height: `${narrow ? 100 : rect.height}%`,
              }}
              onPointerDownCapture={(event) => {
                if (
                  focused ||
                  (event.target instanceof Element && event.target.closest("[data-pane-close]"))
                )
                  return;
                // Prevent input in a pane whose route activation may be blocked by an
                // unsaved editor. Activate first; restore the intended focus on success.
                const target = event.target instanceof HTMLElement ? event.target : null;
                if (!target?.closest("[draggable=true]")) event.preventDefault();
                void activate(ref, target);
              }}
              onFocusCapture={(event) => {
                if (event.target.closest("[data-pane-close]")) return;
                if (focused) {
                  lastFocusedElement.current = event.target;
                  return;
                }
                const target = event.target;
                target.blur();
                lastFocusedElement.current?.focus({ preventScroll: true });
                void activate(ref, target);
              }}
              onClickCapture={(event) => {
                if (
                  !focused &&
                  !(event.target instanceof Element && event.target.closest("[data-pane-close]"))
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onDragOver={(event) => {
                if (
                  !enabled ||
                  !event.dataTransfer.types.includes(PANE_DRAG_TYPE) ||
                  (narrow && split)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                const side = paneDropSide(
                  event.currentTarget.getBoundingClientRect(),
                  event.clientX,
                  event.clientY,
                );
                if (side) setDrop({ key, side });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDrop(null);
              }}
              onDrop={(event) => {
                if (!enabled || !event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
                event.preventDefault();
                event.stopPropagation();
                setDrop(null);
                const side = paneDropSide(
                  event.currentTarget.getBoundingClientRect(),
                  event.clientX,
                  event.clientY,
                );
                try {
                  const source = decodePaneRef(
                    JSON.parse(event.dataTransfer.getData(PANE_DRAG_TYPE)),
                  );
                  if (source && side) useChatPanesStore.getState().open(source, side, ref);
                } catch {
                  /* unrelated/malformed drag */
                }
              }}
            >
              {split ? (
                <div
                  className={`flex h-7 shrink-0 items-center justify-between border-b px-2 text-xs ${focused ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                >
                  <button
                    type="button"
                    draggable={!narrow}
                    className="min-w-0 flex-1 truncate text-left"
                    aria-label={`Focus pane ${i + 1}`}
                    onClick={() => void activate(ref)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(PANE_DRAG_TYPE, JSON.stringify(ref));
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDrop(null)}
                  >
                    <PaneTitle threadRef={ref} index={i} />
                  </button>
                  <button
                    type="button"
                    data-pane-close
                    aria-label={`Close pane ${i + 1}`}
                    className="px-2 hover:bg-muted"
                    onClick={(event) => {
                      event.stopPropagation();
                      void close(ref);
                    }}
                  >
                    ×
                  </button>
                </div>
              ) : null}
              <PaneThread
                threadRef={ref}
                focused={focused && visible}
                guards={guards}
                inSplit={split}
              >
                {children(ref, focused && visible)}
              </PaneThread>
              {drop?.key === key ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-50 border-2 border-primary bg-primary/10"
                  style={{
                    left: drop.side === "right" ? "50%" : 0,
                    top: drop.side === "bottom" ? "50%" : 0,
                    width: drop.side === "left" || drop.side === "right" ? "50%" : "100%",
                    height: drop.side === "top" || drop.side === "bottom" ? "50%" : "100%",
                  }}
                />
              ) : null}
            </section>
          );
        })}
        {!narrow &&
          layout.dividers.map((divider) => {
            const { node, rect, path } = divider,
              horizontal = node.axis === "horizontal";
            return (
              <div
                key={path}
                role="separator"
                tabIndex={0}
                aria-label="Resize thread panes"
                aria-orientation={horizontal ? "vertical" : "horizontal"}
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(node.ratio * 100)}
                className={`absolute z-40 touch-none bg-border hover:bg-primary focus-visible:bg-primary ${horizontal ? "cursor-col-resize" : "cursor-row-resize"}`}
                style={{
                  left: horizontal
                    ? `calc(${rect.left + rect.width * node.ratio}% - 2px)`
                    : `${rect.left}%`,
                  top: horizontal
                    ? `${rect.top}%`
                    : `calc(${rect.top + rect.height * node.ratio}% - 2px)`,
                  width: horizontal ? 4 : `${rect.width}%`,
                  height: horizontal ? `${rect.height}%` : 4,
                }}
                onKeyDown={(event) => {
                  const minus = horizontal ? "ArrowLeft" : "ArrowUp",
                    plus = horizontal ? "ArrowRight" : "ArrowDown";
                  if (![minus, plus, "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  useChatPanesStore
                    .getState()
                    .setRoot(
                      resizePane(
                        root,
                        path,
                        event.key === "Home"
                          ? 0.25
                          : event.key === "End"
                            ? 0.75
                            : node.ratio + (event.key === plus ? 0.05 : -0.05),
                      ),
                    );
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !container.current) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragResize.current = {
                    divider,
                    bounds: event.currentTarget.parentElement!.getBoundingClientRect(),
                    original: root,
                    current: root,
                    pointerId: event.pointerId,
                  };
                }}
                onPointerMove={(event) => {
                  const drag = dragResize.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  const position = horizontal
                    ? ((event.clientX - drag.bounds.left) / drag.bounds.width) * 100
                    : ((event.clientY - drag.bounds.top) / drag.bounds.height) * 100;
                  const ratio =
                    (position - (horizontal ? rect.left : rect.top)) /
                    (horizontal ? rect.width : rect.height);
                  drag.current = resizePane(drag.original, path, ratio);
                  setResizing(drag.current);
                }}
                onPointerUp={() => {
                  const drag = dragResize.current;
                  dragResize.current = null;
                  setResizing(null);
                  if (drag && useChatPanesStore.getState().root === drag.original)
                    useChatPanesStore.getState().setRoot(drag.current);
                }}
                onLostPointerCapture={() => {
                  dragResize.current = null;
                  setResizing(null);
                }}
                onPointerCancel={() => {
                  dragResize.current = null;
                  setResizing(null);
                }}
              />
            );
          })}
      </div>
    </div>
  );
}
