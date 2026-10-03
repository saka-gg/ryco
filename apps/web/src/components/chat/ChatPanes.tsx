import { useAppKeybindings } from "../../appKeybindings";
import { navigateWithPreviewGuard } from "../../previewNavigation";
import type { ScopedThreadRef } from "@ryco/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import {
  closePane,
  decodePaneRef,
  paneContains,
  paneDropRect,
  paneDropSide,
  paneGeometry,
  paneKey,
  paneLeaves,
  resizePane,
  resolvePaneDrop,
  sharesPaneLeaves,
  PANE_DRAG_TYPE,
  type PaneDividerGeometry,
  type PaneDropVerdict,
  type PaneLeafGeometry,
  type PaneNode,
  type PaneRect,
  type PaneSide,
} from "../../chatPanes.logic";
import {
  endPaneDrag,
  readPaneDragSource,
  startPaneDrag,
  useChatPanesStore,
} from "../../chatPanesStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { readMotionDurationMs } from "../../lib/perf/motion";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { selectThreadExistsByRef, selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { useDraftThreadExistsByRef } from "../../composerDraftSelectors";
import { flushPreviewFiles } from "../previewFileSessions";
import { InboxMotionContext } from "../inboxSidebar/useInboxListMotion";
import { toastManager } from "../ui/toast";
import { retainDesktopWorkspaceThreadScope } from "../../platform/desktopWorkspace";
import {
  PaneDropPreview,
  PaneHeader,
  PaneStatusTitle,
  paneDropLabel,
  type PaneDropPreviewState,
} from "./ChatPaneChrome";
import {
  PaneFocusContext,
  PaneThreadContext,
  PaneCloseGuardContext,
  type PaneCloseGuard,
} from "./PaneFocus";

const FULL_RECT: PaneRect = { left: 0, top: 0, width: 100, height: 100 };
/**
 * Where an opened pane is pushed in from and a closed one is pushed out to:
 * one full pane length past its edge, so it moves in lockstep with its sibling.
 */
const PANE_PUSH_SHIFT: Record<PaneSide, CSSProperties> = {
  left: { "--chat-pane-shift-x": "-100%" } as CSSProperties,
  right: { "--chat-pane-shift-x": "100%" } as CSSProperties,
  top: { "--chat-pane-shift-y": "-100%" } as CSSProperties,
  bottom: { "--chat-pane-shift-y": "100%" } as CSSProperties,
};
/** Geometry follows the right panel: one curve, one duration, collapsed by reduced motion. */
const PANE_GEOMETRY_TRANSITION_CLASS =
  "transition-[left,top,width,height] duration-(--app-motion-duration-pane) ease-(--app-motion-ease)";
/**
 * A pane being pushed in or out draws the hairline on its travelling edge, so
 * the seam moves with it; the split's divider takes over once it lands.
 */
const PANE_TRAVELLING_EDGE_CLASS: Record<PaneSide, string> = {
  left: "shadow-[1px_0_0_0_var(--border)]",
  right: "shadow-[-1px_0_0_0_var(--border)]",
  top: "shadow-[0_1px_0_0_var(--border)]",
  bottom: "shadow-[0_-1px_0_0_var(--border)]",
};

interface PaneLayoutMotion {
  root: PaneNode;
  leaves: PaneLeafGeometry[];
  /** Panes the last layout change closed; pushed out past their edge, then unmounted. */
  leaving: (PaneLeafGeometry & { index: number })[];
  /** Panes the last layout change opened; pushed in from their edge. */
  entering: ReadonlySet<string>;
  /** The lone pane a new split grew a strip on. */
  headerIn: string | null;
  /** The pane left alone by a closed split; its strip folds away. */
  headerOut: string | null;
  /**
   * Set while opened panes mount offstage: the panes already open hold these
   * previous rects until the mount work drains, then everything moves at once.
   * A ChatView mount is long enough to stall a push that started with it.
   */
  staged: ReadonlyMap<string, PaneRect> | null;
  /** Dividers of splits this change created; hidden until their panes land. */
  newDividers: ReadonlySet<string>;
}
const STILL_MOTION = {
  leaving: [],
  entering: new Set<string>(),
  headerIn: null,
  headerOut: null,
  staged: null,
  newDividers: new Set<string>(),
};

/** A divider is the same divider while the panes either side of it stay. */
function dividerKey(node: Extract<PaneNode, { kind: "split" }>): string {
  return `${node.axis}:${paneKey(paneLeaves(node.first)[0]!)}|${paneKey(paneLeaves(node.second)[0]!)}`;
}

/** Runs once a mount's effects and follow-up layout work have had their frames. */
function afterMountSettles(callback: () => void): () => void {
  let frame = 0,
    idle = 0,
    timer = 0;
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      if (typeof window.requestIdleCallback === "function")
        idle = window.requestIdleCallback(callback, { timeout: 180 });
      else timer = window.setTimeout(callback, 32);
    });
  });
  return () => {
    window.cancelAnimationFrame(frame);
    if (idle) window.cancelIdleCallback(idle);
    window.clearTimeout(timer);
  };
}

/**
 * Diffs two layouts into enter/exit motion. Only an edit of one split animates
 * (the layouts share a pane); navigating to an unrelated thread swaps instantly.
 */
function nextLayoutMotion(
  previous: PaneLayoutMotion,
  root: PaneNode,
  animate: boolean,
): PaneLayoutMotion {
  const leaves = paneGeometry(root).leaves;
  if (!animate || !sharesPaneLeaves(previous.root, root)) return { root, leaves, ...STILL_MOTION };
  const nextKeys = new Set(leaves.map((leaf) => paneKey(leaf.ref)));
  const previousKeys = new Set(previous.leaves.map((leaf) => paneKey(leaf.ref)));
  const wasSplit = previous.root.kind === "split",
    isSplit = root.kind === "split";
  const entering = new Set(
    leaves.filter((leaf) => !previousKeys.has(paneKey(leaf.ref))).map((leaf) => paneKey(leaf.ref)),
  );
  const previousDividers = new Set(
    paneGeometry(previous.root).dividers.map((d) => dividerKey(d.node)),
  );
  return {
    root,
    leaves,
    staged: entering.size
      ? new Map(
          previous.leaves
            .filter((leaf) => nextKeys.has(paneKey(leaf.ref)))
            .map((leaf) => [paneKey(leaf.ref), leaf.rect] as const),
        )
      : null,
    newDividers: new Set(
      paneGeometry(root)
        .dividers.map((d) => dividerKey(d.node))
        .filter((key) => !previousDividers.has(key)),
    ),
    headerIn: !wasSplit && isSplit ? paneKey(paneLeaves(previous.root)[0]!) : null,
    headerOut: wasSplit && !isSplit ? paneKey(paneLeaves(root)[0]!) : null,
    leaving: [
      ...previous.leaving.filter((leaf) => !nextKeys.has(paneKey(leaf.ref))),
      ...previous.leaves.flatMap((leaf, index) =>
        nextKeys.has(paneKey(leaf.ref)) ? [] : [{ ...leaf, index }],
      ),
    ],
    entering,
  };
}

function rectStyle(rect: PaneRect): CSSProperties {
  return {
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}

function dropRegion(pane: PaneRect, side: PaneSide, verdict: PaneDropVerdict): PaneRect {
  // Whole-pane refusals are not about the edge, so they cover the whole pane.
  if (verdict.kind === "refused" && verdict.reason !== "axis") return pane;
  const half = paneDropRect(side);
  return {
    left: pane.left + (pane.width * half.left) / 100,
    top: pane.top + (pane.height * half.top) / 100,
    width: (pane.width * half.width) / 100,
    height: (pane.height * half.height) / 100,
  };
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
  const keybindings = useAppKeybindings();
  const container = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  // A narrow/wide flip re-lays every pane at once; that is a mode switch, not
  // a resize, so geometry snaps for the frame it happens in.
  const [settledNarrow, setSettledNarrow] = useState(narrow);
  const narrowFlipped = settledNarrow !== narrow;
  useEffect(() => {
    if (!narrowFlipped) return;
    const frame = window.requestAnimationFrame(() => setSettledNarrow(narrow));
    return () => window.cancelAnimationFrame(frame);
  }, [narrow, narrowFlipped]);
  const [drop, setDrop] = useState<PaneDropPreviewState | null>(null);
  const [resizing, setResizing] = useState<{ root: PaneNode; path: string } | null>(null);
  const dragResize = useRef<{
    divider: PaneDividerGeometry;
    bounds: DOMRect;
    original: PaneNode;
    current: PaneNode;
    pointerId: number;
  } | null>(null);
  const currentRoot = useRef(root);
  useLayoutEffect(() => {
    currentRoot.current = root;
  }, [root]);
  // Derived during render so a closing pane is never committed unmounted: its
  // ChatView instance is kept, faded, and released when the exit ends.
  const [layoutMotion, setLayoutMotion] = useState<PaneLayoutMotion>(() => ({
    root,
    leaves: paneGeometry(root).leaves,
    ...STILL_MOTION,
  }));
  if (layoutMotion.root !== root) {
    setLayoutMotion(
      nextLayoutMotion(
        layoutMotion,
        root,
        enabled && !narrow && readMotionDurationMs("--app-motion-duration-pane", 360) > 0,
      ),
    );
  }
  const releaseLeaving = useCallback((key: string) => {
    setLayoutMotion((current) => {
      const leaving = current.leaving.filter((leaf) => paneKey(leaf.ref) !== key);
      return leaving.length === current.leaving.length ? current : { ...current, leaving };
    });
  }, []);
  const settleEntering = useCallback((key: string) => {
    setLayoutMotion((current) => {
      if (!current.entering.has(key)) return current;
      const entering = new Set(current.entering);
      entering.delete(key);
      return { ...current, entering };
    });
  }, []);
  const settleHeader = useCallback((key: string) => {
    setLayoutMotion((current) =>
      current.headerIn === key || current.headerOut === key
        ? { ...current, headerIn: null, headerOut: null }
        : current,
    );
  }, []);
  const staged = layoutMotion.staged;
  useEffect(() => {
    if (!staged) return;
    return afterMountSettles(() =>
      setLayoutMotion((current) =>
        current.staged === staged ? { ...current, staged: null } : current,
      ),
    );
  }, [staged]);
  // animationend is the release; this only covers an exit that never ran.
  const leavingCount = layoutMotion.leaving.length;
  const folding = layoutMotion.headerOut !== null;
  useEffect(() => {
    if (!leavingCount && !folding) return;
    const timer = window.setTimeout(
      () => setLayoutMotion((current) => ({ ...current, leaving: [], headerOut: null })),
      readMotionDurationMs("--app-motion-duration-pane", 360) + 400,
    );
    return () => window.clearTimeout(timer);
  }, [folding, leavingCount]);
  // Status glyphs in pane strips morph on change, never on first paint.
  const glyphMotion = useRef({ ready: false, enabled: true });
  useEffect(() => {
    glyphMotion.current.ready = true;
  }, []);
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
  // Keyboard entry points (`_chat.tsx` resolves the shortcuts). The latest
  // closures are read at call time; the registered object stays stable.
  const controllerActions = useRef({ activate, close, split, threadRef });
  useLayoutEffect(() => {
    controllerActions.current = { activate, close, split, threadRef };
  });
  useEffect(() => {
    if (!enabled) return;
    return useChatPanesStore.getState().registerController({
      focusSibling: (offset) => {
        const actions = controllerActions.current;
        const leaves = paneLeaves(currentRoot.current);
        if (!actions.split || leaves.length < 2) return false;
        const index = leaves.findIndex((ref) => paneKey(ref) === paneKey(actions.threadRef));
        const next = leaves[(index + offset + leaves.length) % leaves.length]!;
        // Land in the sibling's composer so typing continues there.
        const composer = container.current
          ?.querySelector(`[data-pane-thread="${CSS.escape(paneKey(next))}"]`)
          ?.querySelector<HTMLElement>('[data-testid="composer-editor"]');
        void actions.activate(next, composer);
        return true;
      },
      closeFocused: () => {
        const actions = controllerActions.current;
        if (!actions.split) return false;
        void actions.close(actions.threadRef);
        return true;
      },
    });
  }, [enabled]);
  const hideDrop = useCallback(() => {
    setDrop((current) => (current?.visible ? { ...current, visible: false } : current));
  }, []);
  useEffect(() => {
    if (!drop?.visible) return;
    // A drag cancelled or dropped outside the panes must not leave a preview.
    window.addEventListener("dragend", hideDrop);
    window.addEventListener("drop", hideDrop);
    return () => {
      window.removeEventListener("dragend", hideDrop);
      window.removeEventListener("drop", hideDrop);
    };
  }, [drop?.visible, hideDrop]);
  const showDrop = (key: string, side: PaneSide, verdict: PaneDropVerdict, pane: PaneRect) => {
    if (verdict.kind === "noop") {
      hideDrop();
      return;
    }
    setDrop((current) => {
      if (
        current?.visible &&
        current.key === key &&
        current.side === side &&
        current.verdict.kind === verdict.kind
      )
        return current;
      return {
        session: current ? current.session + (current.visible ? 0 : 1) : 0,
        key,
        side,
        verdict,
        rect: dropRegion(pane, side, verdict),
        visible: true,
      };
    });
  };
  const startTitleDrag = (event: ReactDragEvent<HTMLButtonElement>, ref: ScopedThreadRef) =>
    startPaneDrag(event.dataTransfer, ref, "move");
  const endTitleDrag = () => {
    endPaneDrag();
    hideDrop();
  };
  const closeShortcut = shortcutLabelForCommand(keybindings, "pane.close");
  const layout = paneGeometry(resizing?.root ?? root);
  const focusedIndex = layout.leaves.findIndex((leaf) => paneKey(leaf.ref) === paneKey(threadRef));
  // Not gated on `split`: the survivor of a closed split must ease to full size.
  const animateGeometry = enabled && !narrow && !narrowFlipped && !resizing;
  const renderPane = (leaf: PaneLeafGeometry, i: number, leaving: boolean) => {
    const { ref } = leaf;
    const key = paneKey(ref),
      focused = !leaving && key === paneKey(threadRef);
    const visible = leaving || !split || !narrow || focused;
    const rect = narrow && !leaving ? FULL_RECT : (staged?.get(key) ?? leaf.rect);
    const entering = !leaving && layoutMotion.entering.has(key);
    const pushed = (entering || leaving) && leaf.side ? PANE_PUSH_SHIFT[leaf.side] : null;
    // Offstage while staged: parked where the push will start from.
    const parked = entering && staged !== null && pushed !== null;
    const inSplit = split || leaving;
    const headerMotion = leaving
      ? null
      : layoutMotion.headerIn === key
        ? staged
          ? "staged"
          : "in"
        : layoutMotion.headerOut === key
          ? "out"
          : null;
    return (
      <section
        key={key}
        data-pane-thread={leaving ? undefined : key}
        data-pane-leaving={leaving ? key : undefined}
        data-pane-focused={focused}
        aria-label={`Thread pane ${i + 1}`}
        aria-hidden={leaving ? true : undefined}
        className={cn(
          "group/pane absolute isolate flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
          animateGeometry && !leaving && PANE_GEOMETRY_TRANSITION_CLASS,
          pushed && entering && !parked && "chat-pane-enter",
          leaving && "chat-pane-exit pointer-events-none",
          pushed && leaf.side && cn("z-30", PANE_TRAVELLING_EDGE_CLASS[leaf.side]),
        )}
        hidden={!visible}
        inert={!visible || leaving ? true : undefined}
        style={{
          display: visible ? undefined : "none",
          ...rectStyle(rect),
          ...pushed,
          ...(parked
            ? { transform: "translate(var(--chat-pane-shift-x, 0), var(--chat-pane-shift-y, 0))" }
            : {}),
        }}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.animationName === "chat-pane-exit") releaseLeaving(key);
          if (event.animationName === "chat-pane-enter") settleEntering(key);
        }}
        onPointerDownCapture={(event) => {
          if (
            leaving ||
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
          if (leaving || event.target.closest("[data-pane-close]")) return;
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
            !leaving &&
            !focused &&
            !(event.target instanceof Element && event.target.closest("[data-pane-close]"))
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onDragOver={(event) => {
          if (
            leaving ||
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
          if (!side) return;
          const source = readPaneDragSource();
          // Drags from another window carry an unknown thread; the drop decides.
          const verdict: PaneDropVerdict = source
            ? resolvePaneDrop(root, ref, source, side)
            : { kind: "split" };
          if (source)
            event.dataTransfer.dropEffect =
              verdict.kind === "split" ? "copy" : verdict.kind === "move" ? "move" : "none";
          showDrop(key, side, verdict, rect);
        }}
        onDrop={(event) => {
          if (leaving || !enabled || !event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          hideDrop();
          endPaneDrag();
          const side = paneDropSide(
            event.currentTarget.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          );
          let source: ScopedThreadRef | null = null;
          try {
            source = decodePaneRef(JSON.parse(event.dataTransfer.getData(PANE_DRAG_TYPE)));
          } catch {
            /* unrelated/malformed drag */
          }
          if (!source || !side) return;
          const verdict = resolvePaneDrop(root, ref, source, side);
          if (verdict.kind === "refused") {
            toastManager.add({ type: "info", title: paneDropLabel(verdict) ?? "Cannot split" });
            return;
          }
          if (verdict.kind === "noop") return;
          useChatPanesStore.getState().open(source, side, ref);
        }}
      >
        {/* Narrow splits name and close panes from the tab bar instead. */}
        {(inSplit && !(narrow && !leaving)) || headerMotion === "out" ? (
          <InboxMotionContext value={glyphMotion}>
            <PaneHeader
              threadRef={ref}
              index={i}
              focused={focused}
              motion={headerMotion}
              onMotionEnd={() => settleHeader(key)}
              draggable={!narrow && !leaving}
              closeShortcut={closeShortcut}
              onActivate={() => void activate(ref)}
              onClose={() => void close(ref)}
              onDragStart={(event) => startTitleDrag(event, ref)}
              onDragEnd={endTitleDrag}
            />
          </InboxMotionContext>
        ) : null}
        <PaneThread threadRef={ref} focused={focused && visible} guards={guards} inSplit={inSplit}>
          {children(ref, focused && visible)}
        </PaneThread>
        {split && !leaving && !narrow ? (
          <>
            {/* Where typing goes: the focused pane is framed, the rest recede.
                Hovering a receded pane lifts it, hinting a click focuses it. */}
            <div
              aria-hidden
              data-pane-scrim
              className={cn(
                "pointer-events-none absolute inset-x-0 top-8 bottom-0 z-[60] bg-background transition-opacity duration-(--app-motion-duration-stack) ease-(--app-motion-ease)",
                focused ? "opacity-0" : "opacity-35 group-hover/pane:opacity-15",
              )}
            />
            <div
              aria-hidden
              data-pane-frame
              className={cn(
                "pointer-events-none absolute inset-0 z-[60] shadow-[inset_0_0_0_1px_var(--ring)] transition-opacity duration-(--app-motion-duration-stack) ease-(--app-motion-ease)",
                focused ? "opacity-55" : "opacity-0",
              )}
            />
          </>
        ) : null}
      </section>
    );
  };
  return (
    <div
      ref={container}
      data-chat-panes
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {split && narrow ? (
        <div className="flex shrink-0 items-center gap-1 border-b p-1">
          <InboxMotionContext value={glyphMotion}>
            <div
              className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
              role="tablist"
              aria-label="Split threads"
            >
              {layout.leaves.map(({ ref }) => {
                const selected = paneKey(ref) === paneKey(threadRef);
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    key={paneKey(ref)}
                    className="max-w-56 min-w-0 shrink-0 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-(--app-motion-duration-chip) hover:text-foreground aria-selected:bg-accent aria-selected:text-foreground"
                    onClick={() => void activate(ref)}
                  >
                    <PaneStatusTitle threadRef={ref} focused={selected} />
                  </button>
                );
              })}
            </div>
          </InboxMotionContext>
          <button
            type="button"
            data-pane-close
            aria-label={`Close pane ${focusedIndex + 1}`}
            title="Close this pane"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => void close(threadRef)}
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}
      <div
        className="relative min-h-0 flex-1"
        onDragOver={() => hideDrop()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideDrop();
        }}
      >
        {layout.leaves.map((leaf, i) => renderPane(leaf, i, false))}
        {layoutMotion.leaving.map((leaf) => renderPane(leaf, leaf.index, true))}
        {!narrow &&
          layout.dividers.map((divider) => {
            const { node, rect, path } = divider,
              horizontal = node.axis === "horizontal";
            const active = resizing?.path === path;
            const landing =
              layoutMotion.newDividers.has(dividerKey(node)) &&
              (staged !== null || layoutMotion.entering.size > 0);
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
                title="Drag to resize · Double-click to reset"
                data-resizing={active ? "" : undefined}
                className={cn(
                  "group/divider absolute z-40 touch-none outline-none",
                  horizontal ? "cursor-col-resize" : "cursor-row-resize",
                  animateGeometry &&
                    "transition-[left,top,width,height,opacity] duration-(--app-motion-duration-pane) ease-(--app-motion-ease)",
                  landing && "pointer-events-none opacity-0",
                )}
                // A 9px grab target centred on a hairline.
                style={{
                  left: horizontal
                    ? `calc(${rect.left + rect.width * node.ratio}% - 4.5px)`
                    : `${rect.left}%`,
                  top: horizontal
                    ? `${rect.top}%`
                    : `calc(${rect.top + rect.height * node.ratio}% - 4.5px)`,
                  width: horizontal ? 9 : `${rect.width}%`,
                  height: horizontal ? `${rect.height}%` : 9,
                }}
                onKeyDown={(event) => {
                  const minus = horizontal ? "ArrowLeft" : "ArrowUp",
                    plus = horizontal ? "ArrowRight" : "ArrowDown";
                  if (![minus, plus, "Home", "End", "Enter"].includes(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  useChatPanesStore
                    .getState()
                    .setRoot(
                      resizePane(
                        root,
                        path,
                        event.key === "Enter"
                          ? 0.5
                          : event.key === "Home"
                            ? 0.25
                            : event.key === "End"
                              ? 0.75
                              : node.ratio + (event.key === plus ? 0.05 : -0.05),
                      ),
                    );
                }}
                onDoubleClick={() => {
                  if (node.ratio !== 0.5)
                    useChatPanesStore.getState().setRoot(resizePane(root, path, 0.5));
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
                  setResizing({ root: drag.current, path });
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
              >
                {/* The hairline thickens on hover; a grip pill names the affordance. */}
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute bg-border transition-[background-color,width,height] duration-(--app-motion-duration-chip) ease-(--app-motion-ease) group-hover/divider:bg-foreground/25 group-focus-visible/divider:bg-ring group-data-resizing/divider:bg-ring",
                    horizontal
                      ? "inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover/divider:w-[3px] group-focus-visible/divider:w-[3px] group-data-resizing/divider:w-[3px]"
                      : "inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover/divider:h-[3px] group-focus-visible/divider:h-[3px] group-data-resizing/divider:h-[3px]",
                  )}
                />
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute top-1/2 left-1/2 -translate-1/2 rounded-full bg-foreground/45 opacity-0 scale-75 transition-[opacity,scale] duration-(--app-motion-duration-pop) ease-(--app-motion-spring-snappy) group-hover/divider:scale-100 group-hover/divider:opacity-100 group-focus-visible/divider:scale-100 group-focus-visible/divider:opacity-100 group-data-resizing/divider:scale-100 group-data-resizing/divider:opacity-100",
                    horizontal ? "h-7 w-[5px]" : "h-[5px] w-7",
                  )}
                />
              </div>
            );
          })}
        {drop ? <PaneDropPreview key={drop.session} drop={drop} /> : null}
      </div>
    </div>
  );
}
