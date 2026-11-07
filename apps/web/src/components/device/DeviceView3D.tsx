// The viewport follows pingdotgg/t3code commit 6577c6b6
// (`apps/web/src/components/device/DevicePhoneViewport.tsx` and `mountDeviceViewer.ts`,
// MIT): press on the screen to touch, press off it to turn the device. See
// THIRD_PARTY_NOTICES.md.
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

import { Button } from "../ui/button";
import type { DeviceKind } from "./deviceChassis";
import type { DeviceTurn, DeviceViewer3d } from "./scene3d/deviceViewer3d";
import type { DeviceViewName } from "./scene3d/deviceViewSnap";

/*
 * The live device as a 3D body. The video hook keeps painting its 2D canvas
 * (hidden behind this view), and the 3D view draws that canvas as the screen
 * texture after each frame, so streaming, input and the 2D fallback stay one
 * path. three.js arrives with `scene3d/deviceViewer3d`, a dynamic import of
 * its own: the device panel does not load it until 3D is turned on.
 */

const loadScene3d = () => import("./scene3d/deviceViewer3d");

type PointerHandler = (event: PointerEvent<HTMLCanvasElement>) => void;

export interface DeviceView3DProps {
  /** The decode canvas the video hook paints. */
  readonly source: RefObject<HTMLCanvasElement | null>;
  readonly kind: DeviceKind;
  /** Screen width over height in portrait. */
  readonly aspect: number;
  readonly name: string;
  readonly turn: DeviceTurn;
  /** Set to the viewer's frame callback while it lives; the video hook calls it. */
  readonly frameListenerRef: { current: (() => void) | null };
  /**
   * Set to a mapping from a client position to the frame point under it
   * (fractions of the frame), so the touch hook can target the 3D screen.
   */
  readonly framePointRef: {
    current: ((clientX: number, clientY: number) => { x: number; y: number } | null) | null;
  };
  readonly touch: {
    readonly onPointerDown: PointerHandler;
    readonly onPointerMove: PointerHandler;
    readonly onPointerUp: PointerHandler;
    readonly onPointerCancel: PointerHandler;
    readonly onLostPointerCapture: PointerHandler;
  };
  readonly onKeyDown: React.KeyboardEventHandler<HTMLCanvasElement>;
  readonly onKeyUp: React.KeyboardEventHandler<HTMLCanvasElement>;
  readonly onPaste: React.ClipboardEventHandler<HTMLCanvasElement>;
  readonly label: string;
  readonly onUnavailable: (reason: string) => void;
}

type Gesture =
  | { readonly kind: "touch"; readonly pointerId: number }
  | { readonly kind: "orbit"; readonly pointerId: number; last: { x: number; y: number } };

function canvasFraction(event: PointerEvent<HTMLCanvasElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

const VIEW_BUTTONS: ReadonlyArray<{ readonly view: DeviceViewName; readonly label: string }> = [
  { view: "front", label: "Front" },
  { view: "right", label: "Side" },
  { view: "back", label: "Back" },
];

export function DeviceView3D(props: DeviceView3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<DeviceViewer3d | null>(null);
  const moduleRef = useRef<Awaited<ReturnType<typeof loadScene3d>> | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The values the mount effect reads when the module arrives; later changes
  // are pushed into the viewer by the effects below.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const { source, frameListenerRef, framePointRef } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const decode = source.current;
    if (!canvas || !host || !decode) return;
    let disposed = false;
    let trackpad: { cancel: () => void; dispose: () => void } | null = null;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      viewerRef.current?.resize(rect.width, rect.height, window.devicePixelRatio);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const cancelGesture = () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      trackpad?.cancel();
      if (gesture) viewerRef.current?.setInteractionActive(false, gesture.kind);
    };
    window.addEventListener("blur", cancelGesture);

    void loadScene3d()
      .then((module) => {
        if (disposed) return;
        const current = latest.current;
        const viewer = module.createDeviceViewer3d({
          canvas,
          source: decode,
          body: module.deviceBodySpec(current.kind, current.aspect, current.name),
          turn: current.turn,
          onUnavailable: (reason) => latest.current.onUnavailable(reason),
        });
        moduleRef.current = module;
        viewerRef.current = viewer;
        frameListenerRef.current = viewer.frameUpdated;
        framePointRef.current = (clientX, clientY) => {
          const rect = canvas.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          return viewer.framePoint(
            (clientX - rect.left) / rect.width,
            (clientY - rect.top) / rect.height,
          );
        };
        trackpad = module.bindDeviceTrackpad(canvas, {
          canNavigate: () => gestureRef.current === null,
          orbit: viewer.orbit,
          orbitEnd: () => viewer.setInteractionActive(false, "orbit"),
          zoomBy: viewer.zoomBy,
        });
        resize();
        // Draw what the decode canvas already holds: a still screen sends no new frame.
        viewer.frameUpdated();
        setLoaded(true);
      })
      .catch(() => {
        if (!disposed) latest.current.onUnavailable("The 3D view could not load.");
      });

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("blur", cancelGesture);
      trackpad?.dispose();
      gestureRef.current = null;
      frameListenerRef.current = null;
      framePointRef.current = null;
      viewerRef.current?.dispose();
      viewerRef.current = null;
      moduleRef.current = null;
    };
  }, [source, frameListenerRef, framePointRef]);

  // The body follows the device: a new kind or screen aspect builds a new
  // body; an orientation change turns the one there.
  const { kind, aspect, name } = props;
  const { angle, uvTurns } = props.turn;
  useEffect(() => {
    const module = moduleRef.current;
    if (!loaded || !module) return;
    viewerRef.current?.setBody(module.deviceBodySpec(kind, aspect, name), { angle, uvTurns });
  }, [loaded, kind, aspect, name, angle, uvTurns]);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const viewer = viewerRef.current;
    if (!viewer || !event.isPrimary || event.button !== 0 || gestureRef.current) return;
    const point = canvasFraction(event);
    // Alt-drag turns the device even over its screen.
    if (!event.altKey && viewer.framePoint(point.x, point.y)) {
      gestureRef.current = { kind: "touch", pointerId: event.pointerId };
      viewer.setInteractionActive(true, "touch");
      props.touch.onPointerDown(event);
      return;
    }
    event.preventDefault();
    event.currentTarget.focus();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already-released pointer cannot be captured.
    }
    gestureRef.current = { kind: "orbit", pointerId: event.pointerId, last: point };
    viewer.setInteractionActive(true, "orbit");
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "touch") {
      props.touch.onPointerMove(event);
      return;
    }
    const point = canvasFraction(event);
    viewerRef.current?.orbit(point.x - gesture.last.x, point.y - gesture.last.y);
    gesture.last = point;
  };
  const end =
    (forward: PointerHandler | null): PointerHandler =>
    (event) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (gesture.kind === "touch") forward?.(event);
      viewerRef.current?.setInteractionActive(false, gesture.kind);
    };
  const onPointerUp = end(props.touch.onPointerUp);
  const onPointerCancel = end(props.touch.onPointerCancel);
  const onLostPointerCapture = end(props.touch.onLostPointerCapture);

  return (
    <div ref={hostRef} className="absolute inset-0" data-device-view-3d>
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[7%] left-1/2 h-6 w-2/5 -translate-x-1/2 rounded-full bg-black/20 blur-2xl dark:bg-black/60"
      />
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label={`${props.label}, 3D view. Drag the screen to interact; drag outside it or swipe with two fingers to turn the device.`}
        className="absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
        onKeyDown={props.onKeyDown}
        onKeyUp={props.onKeyUp}
        onPaste={props.onPaste}
      />
      {loaded ? (
        <div
          role="group"
          aria-label="3D view"
          className="absolute top-2 left-2 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/80 p-0.5 shadow-xs backdrop-blur-sm"
        >
          {VIEW_BUTTONS.map(({ view, label }) => (
            <Button
              key={view}
              size="xs"
              variant="ghost"
              aria-label={`${label} view`}
              onClick={() => viewerRef.current?.showView(view)}
            >
              {label}
            </Button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          <Button size="xs" variant="ghost" onClick={() => viewerRef.current?.restore()}>
            Restore 3D view
          </Button>
        </div>
      ) : null}
    </div>
  );
}
