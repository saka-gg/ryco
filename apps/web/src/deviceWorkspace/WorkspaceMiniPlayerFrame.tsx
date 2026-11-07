// The drag and resize model follows t3code's ThreadPreviewMiniPlayer (pingdotgg/t3code, MIT); see
// THIRD_PARTY_NOTICES.md.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { GripGlyph } from "./miniPlayerGlyphs";
import {
  MINI_PLAYER_HANDLE_HEIGHT,
  MINI_PLAYER_RESIZE_DIRECTIONS,
  resizeMiniPlayer,
  resolveMiniPlayerFrame,
  type MiniPlayerFrame,
  type MiniPlayerObstacles,
  type MiniPlayerResizeDirection,
} from "./workspaceMiniPlayerLayout";
import type {
  WorkspaceMiniPlayerPosition,
  WorkspaceMiniPlayerSize,
} from "./workspaceMiniPlayerStore";

/*
 * The floating window itself, independent of what it shows: a drag handle
 * with a title and actions, eight resize edges, and a body. Placed inside the
 * chat column, clear of the composer. During a gesture the frame lives in
 * local state and is committed once, on release.
 */

const EDGE_CLASS: Record<MiniPlayerResizeDirection, string> = {
  north: "inset-x-3 -top-1 h-2 cursor-ns-resize",
  south: "inset-x-3 -bottom-1 h-2 cursor-ns-resize",
  east: "inset-y-3 -right-1 w-2 cursor-ew-resize",
  west: "inset-y-3 -left-1 w-2 cursor-ew-resize",
  "north-east": "-top-1 -right-1 size-3 cursor-nesw-resize",
  "south-west": "-bottom-1 -left-1 size-3 cursor-nesw-resize",
  "north-west": "-top-1 -left-1 size-3 cursor-nwse-resize",
  "south-east": "-bottom-1 -right-1 size-3 cursor-nwse-resize",
};

const EDGE_LABEL: Record<MiniPlayerResizeDirection, string> = {
  north: "top",
  south: "bottom",
  east: "right",
  west: "left",
  "north-east": "top right",
  "south-west": "bottom left",
  "north-west": "top left",
  "south-east": "bottom right",
};

function useElementSize(ref: RefObject<HTMLElement | null>): WorkspaceMiniPlayerSize | null {
  const [size, setSize] = useState<WorkspaceMiniPlayerSize | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setSize((current) =>
        current?.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function useComposerObstacle(
  containerRef: RefObject<HTMLElement | null>,
  composerRef: RefObject<HTMLElement | null> | undefined,
): MiniPlayerObstacles {
  const [obstacles, setObstacles] = useState<MiniPlayerObstacles>({ composer: null });
  useLayoutEffect(() => {
    const composer = composerRef?.current;
    const host = containerRef.current;
    if (!composer || !host) return;
    const measure = () => {
      const hostRect = host.getBoundingClientRect();
      const rect = composer.getBoundingClientRect();
      const next =
        rect.height > 0
          ? {
              left: rect.left - hostRect.left,
              right: rect.right - hostRect.left,
              height: Math.max(0, hostRect.bottom - rect.top),
            }
          : null;
      // The chat publishes its floating header's height on the column.
      const header =
        Number.parseFloat(getComputedStyle(host).getPropertyValue("--chat-header-clearance")) || 0;
      setObstacles((current) =>
        current.composer?.left === next?.left &&
        current.composer?.right === next?.right &&
        current.composer?.height === next?.height &&
        current.header === header
          ? current
          : { composer: next, header },
      );
    };
    measure();
    // The composer's span is measured against the column, so either resizing moves it.
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    observer.observe(host);
    return () => observer.disconnect();
  }, [composerRef, containerRef]);
  return obstacles;
}

type Gesture =
  | {
      readonly kind: "drag";
      readonly pointerId: number;
      readonly origin: WorkspaceMiniPlayerPosition;
      readonly start: MiniPlayerFrame;
    }
  | {
      readonly kind: "resize";
      readonly pointerId: number;
      readonly direction: MiniPlayerResizeDirection;
      readonly origin: WorkspaceMiniPlayerPosition;
      readonly start: MiniPlayerFrame;
    };

export function WorkspaceMiniPlayerFrame(props: {
  /** The chat column the window floats in. */
  readonly containerRef: RefObject<HTMLElement | null>;
  /** What the window keeps clear of, along the bottom. */
  readonly composerRef?: RefObject<HTMLElement | null>;
  readonly title: string;
  readonly label: string;
  /** Content width over height. */
  readonly aspect: number;
  /** Fixed-height parts of the body (a control rail), beyond the handle. */
  readonly bodyChrome: number;
  readonly position: WorkspaceMiniPlayerPosition | null;
  readonly width: number | null;
  readonly onPlace: (frame: {
    readonly position: WorkspaceMiniPlayerPosition;
    readonly width?: number;
  }) => void;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  const { onPlace } = props;
  const container = useElementSize(props.containerRef);
  const obstacles = useComposerObstacle(props.containerRef, props.composerRef);
  const chrome = MINI_PLAYER_HANDLE_HEIGHT + props.bodyChrome;
  const [live, setLiveState] = useState<MiniPlayerFrame | null>(null);
  const liveRef = useRef<MiniPlayerFrame | null>(null);
  const setLive = useCallback((next: MiniPlayerFrame | null) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);
  const gesture = useRef<Gesture | null>(null);

  const resolved =
    container && container.width > 0 && container.height > 0
      ? resolveMiniPlayerFrame({
          width: props.width,
          position: props.position,
          aspect: props.aspect,
          chrome,
          container,
          obstacles,
        })
      : null;
  const frame = live ?? resolved;

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, direction: MiniPlayerResizeDirection | null) => {
      if (event.button !== 0 || !resolved) return;
      // Buttons in the handle keep their own clicks.
      if (direction === null && (event.target as Element).closest("button")) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer tracks; the gesture still follows its events.
      }
      const origin = { x: event.clientX, y: event.clientY };
      gesture.current =
        direction === null
          ? { kind: "drag", pointerId: event.pointerId, origin, start: resolved }
          : { kind: "resize", pointerId: event.pointerId, direction, origin, start: resolved };
      setLive(resolved);
    },
    [resolved, setLive],
  );

  const move = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId || !container) return;
      const delta = { x: event.clientX - current.origin.x, y: event.clientY - current.origin.y };
      if (current.kind === "drag") {
        const next = resolveMiniPlayerFrame({
          width: current.start.width,
          position: { x: current.start.x + delta.x, y: current.start.y + delta.y },
          aspect: props.aspect,
          chrome,
          container,
          obstacles,
        });
        setLive(next);
        return;
      }
      setLive(
        resizeMiniPlayer({
          start: current.start,
          direction: current.direction,
          delta,
          aspect: props.aspect,
          chrome,
          container,
          obstacles,
        }),
      );
    },
    [chrome, container, obstacles, props.aspect, setLive],
  );

  const end = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      gesture.current = null;
      const final = liveRef.current;
      setLive(null);
      if (!final) return;
      onPlace(
        current.kind === "drag"
          ? { position: { x: final.x, y: final.y } }
          : { position: { x: final.x, y: final.y }, width: final.width },
      );
    },
    [onPlace, setLive],
  );

  // A gesture never outlives the window's source.
  useEffect(() => () => void (gesture.current = null), []);

  if (!frame) return null;
  return (
    <div
      role="dialog"
      aria-label={props.label}
      data-slot="workspace-mini-player"
      className={cn(
        "absolute z-30 flex flex-col overflow-visible rounded-xl border border-border bg-card shadow-2xl",
        live && "select-none",
      )}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      <div
        className="flex shrink-0 cursor-grab items-center gap-1 rounded-t-xl border-b border-border/60 bg-muted/40 pl-2 pr-1 active:cursor-grabbing"
        style={{ height: MINI_PLAYER_HANDLE_HEIGHT }}
        data-slot="workspace-mini-player-handle"
        onPointerDown={(event) => begin(event, null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <GripGlyph className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
          {props.title}
        </span>
        {props.actions}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl">
        {props.children}
      </div>
      {MINI_PLAYER_RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          role="separator"
          aria-label={`Resize from the ${EDGE_LABEL[direction]} edge`}
          data-resize={direction}
          className={cn("absolute z-10 touch-none", EDGE_CLASS[direction])}
          onPointerDown={(event) => begin(event, direction)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </div>
  );
}
