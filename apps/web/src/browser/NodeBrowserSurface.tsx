import type { NodeBrowserFrameStop } from "@ryco/client-runtime/connection/nodeBrowserFrameSource";
import {
  buttonOf,
  createClickCounter,
  createNodeBrowserInputQueue,
  historyDeltaOf,
  keyInput,
  letterboxPoint,
  NODE_BROWSER_INPUT_SENTINEL,
  NODE_BROWSER_MAX_VIEWPORT,
  NODE_BROWSER_MIN_VIEWPORT,
  NODE_BROWSER_RESIZE_THROTTLE_MS,
  NODE_BROWSER_TAP_SLOP_PX,
  nodeBrowserModifiers,
  pressedButtonOf,
  textInputs,
  wheelPixels,
  type NodeBrowserInputQueue,
  type NodeBrowserMouseButton,
} from "@ryco/client-runtime/nodeBrowser/viewerInput";
import type { NodeBrowserInputEvent, NodeBrowserTab } from "@ryco/contracts/node-browser";
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { Button } from "../components/ui/button";
import { createNodeBrowserPainter } from "./nodeBrowserPainter";
import type { NodeBrowserViewerClient } from "./useBrowserMode";

const BACKSPACE = { key: "Backspace", code: "Backspace", keyCode: 8 } as const;
const DELETE = { key: "Delete", code: "Delete", keyCode: 46 } as const;

interface TouchGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

const isAccessRefusal = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "AuthRpcError";

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const stopMessage = (stop: NodeBrowserFrameStop) =>
  stop.reason === "gone"
    ? "This tab is closed."
    : stop.reason === "forbidden"
      ? "Only operators of this node can watch its browser tabs."
      : stop.reason === "unavailable"
        ? "The node's browser is not available right now."
        : "The node refused the connection to this tab.";

/**
 * One node browser tab, streamed: frames painted onto a canvas, scaled to fit,
 * and the person's mouse, wheel, touch and keys sent back in page
 * coordinates. Typing goes through a hidden text field, so composition
 * (accents, CJK input) and paste arrive as text. The page's size follows the
 * panel's. T3 Code's viewer (`ServerBrowserSurface.tsx`), over Ryco's frame
 * socket and input RPC.
 */
export function NodeBrowserSurface({
  client,
  tab,
}: {
  readonly client: NodeBrowserViewerClient;
  readonly tab: NodeBrowserTab;
}) {
  const tabId = tab.id;
  const crashed = tab.state === "crashed";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const viewportRef = useRef<Size | null>(null);
  const sizeRef = useRef<Size | null>(null);
  const queueRef = useRef<NodeBrowserInputQueue | null>(null);
  const refusedRef = useRef(false);
  const hasFrameRef = useRef(false);
  const keySentRef = useRef(false);
  const mouseButtonsRef = useRef(0);
  const mouseClicksRef = useRef<Record<NodeBrowserMouseButton, number>>({
    left: 1,
    middle: 1,
    right: 1,
    none: 1,
  });
  const touchRef = useRef<TouchGesture | null>(null);
  const [clicks] = useState(createClickCounter);
  const [cap, setCap] = useState<Size | null>(null);
  const [stop, setStop] = useState<NodeBrowserFrameStop | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [refused, setRefused] = useState(false);

  // Input goes to the node in order, one call at a time; a refusal ends it.
  useEffect(() => {
    const queue = createNodeBrowserInputQueue({
      send: (events) => client.input({ tabId, events }),
      schedule: (flush) => {
        const frame = requestAnimationFrame(flush);
        return () => cancelAnimationFrame(frame);
      },
      onError: (error) => {
        if (!isAccessRefusal(error)) return;
        refusedRef.current = true;
        setRefused(true);
        queue.stop();
      },
    });
    queueRef.current = queue;
    return () => {
      queue.stop();
      if (queueRef.current === queue) queueRef.current = null;
    };
  }, [client, tabId]);

  const send = (event: NodeBrowserInputEvent) => {
    if (!refusedRef.current) queueRef.current?.push(event);
  };
  const flushInput = () => queueRef.current?.flush();

  /** Where a point on screen is on the page; null outside it, or before a frame came. */
  const pagePoint = (clientX: number, clientY: number, clampToPage: boolean) => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || !hasFrameRef.current || refusedRef.current) return null;
    return letterboxPoint({
      box: canvas.getBoundingClientRect(),
      frame: { width: canvas.width, height: canvas.height },
      viewport,
      clientX,
      clientY,
      clamp: clampToPage,
    });
  };

  // The page follows the panel's size; frames are asked for at its device size, growing only,
  // since a larger frame needs a new stream.
  useEffect(() => {
    const element = canvasRef.current?.parentElement;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const growCap = () => {
      capTimer = null;
      const size = sizeRef.current;
      if (!size) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.min(Math.round(size.width * ratio), NODE_BROWSER_MAX_VIEWPORT.width);
      const height = Math.min(Math.round(size.height * ratio), NODE_BROWSER_MAX_VIEWPORT.height);
      setCap((current) =>
        current !== null && current.width >= width && current.height >= height
          ? current
          : {
              width: Math.max(width, current?.width ?? 0),
              height: Math.max(height, current?.height ?? 0),
            },
      );
    };
    const measure = () => {
      timer = null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      const previous = sizeRef.current;
      if (previous?.width === size.width && previous.height === size.height) return;
      sizeRef.current = size;
      void client
        .command({
          type: "resize",
          tabId,
          width: clamp(
            size.width,
            NODE_BROWSER_MIN_VIEWPORT.width,
            NODE_BROWSER_MAX_VIEWPORT.width,
          ),
          height: clamp(
            size.height,
            NODE_BROWSER_MIN_VIEWPORT.height,
            NODE_BROWSER_MAX_VIEWPORT.height,
          ),
        })
        .catch(() => undefined);
      if (capTimer !== null) clearTimeout(capTimer);
      capTimer = setTimeout(growCap, previous === null ? 0 : NODE_BROWSER_RESIZE_THROTTLE_MS * 2);
    };
    const observer = new ResizeObserver(() => {
      if (timer !== null) return;
      timer = setTimeout(measure, sizeRef.current === null ? 0 : NODE_BROWSER_RESIZE_THROTTLE_MS);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      if (capTimer !== null) clearTimeout(capTimer);
    };
  }, [client, tabId]);

  // The stream: a crashed page has none until it is reloaded.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !cap || crashed || stop !== null) return;
    const painter = createNodeBrowserPainter(canvas, () => {
      if (hasFrameRef.current) return;
      hasFrameRef.current = true;
      setHasFrame(true);
    });
    const source = client.openFrameSource(
      { tabId, maxWidth: cap.width, maxHeight: cap.height },
      {
        onFrame: (frame) => {
          viewportRef.current = { width: frame.cssWidth, height: frame.cssHeight };
          painter.paint(frame.jpeg);
        },
        onStop: setStop,
      },
    );
    return () => {
      painter.stop();
      source.close();
    };
    // Clearing `stop` (Reconnect) opens a new stream.
  }, [cap, client, crashed, stop, tabId]);

  // Registered natively: React's wheel listener is passive and cannot keep the panel from scrolling.
  const onWheel = useEffectEvent((event: WheelEvent) => {
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    event.preventDefault();
    const height = viewportRef.current?.height ?? 0;
    send({
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: wheelPixels(event.deltaX, event.deltaMode, height),
      deltaY: wheelPixels(event.deltaY, event.deltaMode, height),
      modifiers: nodeBrowserModifiers(event),
    });
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const listener = (event: WheelEvent) => onWheel(event);
    canvas.addEventListener("wheel", listener, { passive: false });
    return () => canvas.removeEventListener("wheel", listener);
  }, []);

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    // Thumb buttons move this tab's history in handleMouseUp, never the page.
    if (historyDeltaOf(event.button) !== null) return;
    const { type, pointerId, clientX, clientY } = event;
    const cancelled = type === "pointercancel";
    const touch = touchRef.current;
    if (cancelled && touch?.pointerId === pointerId) {
      touchRef.current = null;
      return;
    }
    if (event.pointerType === "touch" && !cancelled) {
      const point = pagePoint(clientX, clientY, type === "pointermove");
      if (type === "pointerdown") {
        if (!event.isPrimary) return;
        touchRef.current = {
          pointerId,
          startX: clientX,
          startY: clientY,
          lastX: clientX,
          lastY: clientY,
          panning: false,
        };
        return;
      }
      if (!touch || touch.pointerId !== pointerId) return;
      if (type === "pointermove") {
        if (
          !touch.panning &&
          Math.hypot(clientX - touch.startX, clientY - touch.startY) < NODE_BROWSER_TAP_SLOP_PX
        ) {
          return;
        }
        // A pan scrolls the page.
        touch.panning = true;
        if (point) {
          send({
            type: "wheel",
            x: point.x,
            y: point.y,
            deltaX: (touch.lastX - clientX) * point.scale,
            deltaY: (touch.lastY - clientY) * point.scale,
            modifiers: 0,
          });
        }
        touch.lastX = clientX;
        touch.lastY = clientY;
        return;
      }
      touchRef.current = null;
      if (touch.panning || !point) return;
      // A tap clicks.
      flushInput();
      const clickCount = clicks.count("left", clientX, clientY, event.timeStamp);
      const at = { x: point.x, y: point.y, modifiers: 0 };
      send({ type: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
      send({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
      send({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
      return;
    }
    const previous = mouseButtonsRef.current;
    if ((cancelled || type === "pointerup") && previous === 0) return;
    if (cancelled || type === "pointerup") {
      mouseButtonsRef.current = cancelled ? 0 : event.buttons & 7;
    }
    const point = pagePoint(
      clientX,
      clientY,
      type !== "pointerdown" &&
        (cancelled || type === "pointerup" || previous !== 0 || event.buttons !== 0),
    );
    if (!point) return;
    const at = { x: point.x, y: point.y, modifiers: nodeBrowserModifiers(event) };
    const mouse = (action: "down" | "up", button: NodeBrowserMouseButton, buttons: number) => {
      if (action === "down") {
        mouseClicksRef.current[button] = clicks.count(button, clientX, clientY, event.timeStamp);
      }
      send({
        type: "mouse",
        action,
        ...at,
        button,
        buttons,
        clickCount: mouseClicksRef.current[button],
      });
    };
    if (type === "pointerdown") {
      inputRef.current?.focus({ preventScroll: true });
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch {
        // A pointer the browser does not track (a synthetic one) has nothing to capture.
      }
      flushInput();
      mouseButtonsRef.current = event.buttons & 7;
      mouse("down", buttonOf(event.button), event.buttons & 7);
    } else if (type === "pointerup") {
      flushInput();
      mouse("up", buttonOf(event.button), event.buttons & 7);
    } else {
      // Chords arrive as moves. Cancelling lets go of every held button.
      const next = cancelled ? 0 : event.buttons & 7;
      const changed = previous ^ next;
      if (previous !== 0 && changed !== 0) {
        flushInput();
        let buttons = previous;
        for (const bit of [1, 2, 4]) {
          if (!(changed & bit)) continue;
          buttons ^= bit;
          mouse(next & bit ? "down" : "up", pressedButtonOf(bit), buttons);
        }
        mouseButtonsRef.current = next;
      }
      if (cancelled) return;
      send({
        type: "mouse",
        action: "move",
        ...at,
        button: pressedButtonOf(event.buttons),
        buttons: event.buttons & 7,
        clickCount: 0,
      });
    }
  };

  // Chromium runs a thumb button's back or forward on mouseup in this document, which would move
  // the app's router. Cancel it and move the tab's history instead, as the toolbar does.
  const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    const delta = historyDeltaOf(event.button);
    if (delta === null) return;
    event.preventDefault();
    void client.command({ type: "history", tabId, delta }).catch(() => undefined);
  };

  const resetInput = (textarea: HTMLTextAreaElement) => {
    keySentRef.current = false;
    textarea.value = NODE_BROWSER_INPUT_SENTINEL;
    textarea.setSelectionRange(
      NODE_BROWSER_INPUT_SENTINEL.length,
      NODE_BROWSER_INPUT_SENTINEL.length,
    );
  };

  const sendKeyPress = (key: typeof BACKSPACE | typeof DELETE) => {
    send({ type: "key", action: "down", ...key, modifiers: 0 });
    send({ type: "key", action: "up", ...key, modifiers: 0 });
  };

  const handleKey = (action: "down" | "up", event: KeyboardEvent<HTMLTextAreaElement>) => {
    keySentRef.current = false;
    if (event.key === "Escape" && event.shiftKey) {
      // Shift+Escape leaves the page.
      event.preventDefault();
      event.stopPropagation();
      if (action === "down") event.currentTarget.blur();
      return;
    }
    const input = keyInput(action, {
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (!input || refusedRef.current) return;
    send(input);
    const shortcut = event.ctrlKey || event.metaKey;
    // Some Android keyboards edit the field even when keydown is prevented.
    keySentRef.current =
      action === "down" &&
      !shortcut &&
      (input.type === "key" && input.text !== undefined
        ? true
        : event.key === "Backspace" || event.key === "Delete");
    if (shortcut) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (native instanceof InputEvent && native.isComposing) return;
    const textarea = event.currentTarget;
    const inputType = native instanceof InputEvent ? native.inputType : "";
    if (keySentRef.current) keySentRef.current = false;
    else if (inputType === "deleteContentBackward") sendKeyPress(BACKSPACE);
    else if (inputType === "deleteContentForward") sendKeyPress(DELETE);
    else for (const input of textInputs(textarea.value.replace(/^​/u, ""))) send(input);
    resetInput(textarea);
  };

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-muted/30"
      data-node-browser-surface={tabId}
      onMouseUp={handleMouseUp}
    >
      <canvas
        ref={canvasRef}
        aria-label={tab.title || "Node browser page"}
        className="block size-full touch-none object-contain"
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        onPointerUp={handlePointer}
        onPointerCancel={handlePointer}
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      />
      {/* Pinned top-left so focusing it never scrolls; 16px keeps iOS from zooming in. */}
      <textarea
        ref={inputRef}
        aria-label="Browser page"
        aria-description="Press Shift+Escape to leave the browser page."
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={refused || crashed}
        defaultValue={NODE_BROWSER_INPUT_SENTINEL}
        className="sr-only top-0 left-0 text-base"
        onFocus={(event) => resetInput(event.currentTarget)}
        onKeyDown={(event) => handleKey("down", event)}
        onKeyUp={(event) => handleKey("up", event)}
        onInput={handleInput}
        onCompositionEnd={(event) => {
          for (const input of textInputs(event.data.replace(/^​/u, ""))) send(input);
          resetInput(event.currentTarget);
        }}
        // Keep the sentinel off the clipboard.
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
        onPaste={(event) => {
          event.preventDefault();
          for (const input of textInputs(event.clipboardData.getData("text/plain"))) send(input);
        }}
      />
      {!hasFrame && !crashed && stop === null ? (
        <p
          role="status"
          className="absolute inset-x-0 top-3 text-center text-xs text-muted-foreground"
        >
          Connecting to the node's browser…
        </p>
      ) : null}
      {refused ? (
        <p
          role="status"
          className="absolute inset-x-2 bottom-2 rounded bg-background/90 p-2 text-xs"
        >
          This node no longer takes your input on its browser tabs.
        </p>
      ) : null}
      {crashed || stop !== null ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-4 text-center">
          <p role="alert" className="max-w-sm text-sm text-muted-foreground">
            {crashed ? "This page crashed." : stopMessage(stop!)}
          </p>
          {crashed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void client.command({ type: "reload", tabId }).catch(() => undefined)}
            >
              Reload
            </Button>
          ) : stop?.reason === "refused" || stop?.reason === "unavailable" ? (
            <Button variant="outline" size="sm" onClick={() => setStop(null)}>
              Reconnect
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
