// Live touch streaming follows t3code's device stream view (MIT): touches go
// out as begin/move/end while the pointer moves. See THIRD_PARTY_NOTICES.md.
import type { DevicePoint } from "@ryco/client-runtime/state/device/devicePoint";
import { useCallback, useEffect, useRef, type PointerEvent } from "react";

import type { DeviceLiveInputChannel } from "./useDeviceVideoStream";

/** Movement, in device points, below which a release without live input is a tap. */
const TAP_SLOP_POINTS = 8;

/**
 * The finger on the device for one pointer.
 *
 * `live` streams down, moves and up over the frame socket. Moves are
 * coalesced to one per animation frame (the display rate) and always carry
 * the newest position, so a fast pointer never queues a backlog of stale
 * positions. Without live input the gesture is sent on release instead, as
 * one tap or swipe over the RPC path.
 */
type Press =
  | {
      readonly kind: "live";
      readonly pointerId: number;
      last: DevicePoint;
      pending: DevicePoint | null;
      frame: number | null;
    }
  | {
      readonly kind: "release";
      readonly pointerId: number;
      readonly from: DevicePoint;
      readonly at: number;
      last: DevicePoint;
    };

function cancelFrame(press: Press): void {
  if (press.kind === "live" && press.frame !== null) {
    cancelAnimationFrame(press.frame);
    press.frame = null;
  }
}

export interface DeviceTouchFallback {
  readonly tap: (point: DevicePoint) => void;
  readonly swipe: (from: DevicePoint, to: DevicePoint, durationMs: number) => void;
}

/**
 * Pointer handlers for the device canvas.
 *
 * The touch ends, at the last point on the screen, when the pointer leaves
 * the screen, its capture is lost or cancelled, the window loses focus or the
 * page is hidden, so the device never keeps a finger down that the person has
 * lifted. A press that starts while live input is unavailable is sent on
 * release; one that is live when the channel drops is abandoned, and the
 * server lifts the finger as the socket closes.
 */
export function useDeviceTouchInput(options: {
  /** Where a client position lands on the device, or null off its screen. */
  readonly toDevicePoint: (clientX: number, clientY: number) => DevicePoint | null;
  readonly live: DeviceLiveInputChannel | null;
  readonly fallback: DeviceTouchFallback | null;
}) {
  const { toDevicePoint, live, fallback } = options;
  const pressRef = useRef<Press | null>(null);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  /** Lift the finger at `point` (live) and forget the press. */
  const endLive = useCallback((press: Extract<Press, { kind: "live" }>, point: DevicePoint) => {
    cancelFrame(press);
    if (pressRef.current === press) pressRef.current = null;
    liveRef.current?.send({ type: "device.touch", phase: "up", x: point.x, y: point.y });
  }, []);

  /** End whatever is pressed, where it last was. Releases sent on release are dropped. */
  const abandon = useCallback(() => {
    const press = pressRef.current;
    if (!press) return;
    if (press.kind === "live") endLive(press, press.pending ?? press.last);
    else pressRef.current = null;
  }, [endLive]);

  // A pointer that never comes back up must not hold the device's finger down.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") abandon();
    };
    window.addEventListener("blur", abandon);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", abandon);
      document.removeEventListener("visibilitychange", onHidden);
      abandon();
    };
  }, [abandon]);

  // The live channel went away mid-gesture: the server lifts the finger as
  // the socket closes, so only the local press is forgotten.
  useEffect(() => {
    if (live?.ready) return;
    const press = pressRef.current;
    if (press?.kind === "live") {
      cancelFrame(press);
      pressRef.current = null;
    }
  }, [live?.ready]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.currentTarget.focus();
      const point = toDevicePoint(event.clientX, event.clientY);
      if (!point) return;
      abandon();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic or already-released pointer cannot be captured.
      }
      const channel = liveRef.current;
      if (
        channel?.ready &&
        channel.send({ type: "device.touch", phase: "down", x: point.x, y: point.y })
      ) {
        pressRef.current = {
          kind: "live",
          pointerId: event.pointerId,
          last: point,
          pending: null,
          frame: null,
        };
        return;
      }
      if (!fallback) return;
      pressRef.current = {
        kind: "release",
        pointerId: event.pointerId,
        from: point,
        last: point,
        at: performance.now(),
      };
    },
    [abandon, fallback, toDevicePoint],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      const point = toDevicePoint(event.clientX, event.clientY);
      if (press.kind === "release") {
        if (point) press.last = point;
        return;
      }
      if (!point) {
        // Off the screen: the finger leaves the glass where it last was.
        endLive(press, press.pending ?? press.last);
        return;
      }
      press.pending = point;
      if (press.frame !== null) return;
      press.frame = requestAnimationFrame(() => {
        press.frame = null;
        if (pressRef.current !== press || !press.pending) return;
        const next = press.pending;
        press.pending = null;
        if (next.x === press.last.x && next.y === press.last.y) return;
        press.last = next;
        const sent = liveRef.current?.send({
          type: "device.touch",
          phase: "move",
          x: next.x,
          y: next.y,
        });
        if (!sent) {
          // The socket dropped; the server lifts the finger as it closes.
          pressRef.current = null;
        }
      });
    },
    [endLive, toDevicePoint],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      const point = toDevicePoint(event.clientX, event.clientY);
      if (press.kind === "live") {
        endLive(press, point ?? press.pending ?? press.last);
        return;
      }
      pressRef.current = null;
      const to = point ?? press.last;
      const distance = Math.hypot(to.x - press.from.x, to.y - press.from.y);
      if (distance <= TAP_SLOP_POINTS) fallback?.tap(to);
      else fallback?.swipe(press.from, to, Math.max(16, Math.round(performance.now() - press.at)));
    },
    [endLive, fallback, toDevicePoint],
  );

  const onPointerCancel = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (pressRef.current?.pointerId === event.pointerId) abandon();
    },
    [abandon],
  );

  // Capture can be lost without a pointerup (another element took it, or the
  // canvas left the document); a live finger must not stay down.
  const onLostPointerCapture = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const press = pressRef.current;
      if (press?.kind === "live" && press.pointerId === event.pointerId) abandon();
    },
    [abandon],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture };
}
