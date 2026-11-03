/**
 * viewerInput - What a node browser viewer turns a person's input into, on
 * any platform: page coordinates of a letterboxed frame, wheel deltas, click
 * counts, key and text events, and the queue that sends them to the node in
 * order. The numbers are T3 Code's (`ServerBrowserSurface.tsx`).
 *
 * @module viewerInput
 */
import {
  NODE_BROWSER_INPUT_BATCH_LIMIT,
  NODE_BROWSER_TEXT_LIMIT,
  type NodeBrowserInputEvent,
} from "@ryco/contracts/node-browser";

/** A wheel line, for wheels that scroll by lines. */
export const NODE_BROWSER_WHEEL_LINE_PX = 16;
/** A second press within this long and this close counts as a double click. */
export const NODE_BROWSER_MULTI_CLICK_MS = 500;
export const NODE_BROWSER_MULTI_CLICK_SLOP_PX = 4;
/** A touch that moves farther than this pans instead of tapping. */
export const NODE_BROWSER_TAP_SLOP_PX = 8;
/** Size changes reach the node at most this often. */
export const NODE_BROWSER_RESIZE_THROTTLE_MS = 150;
/** The node renders pages between these sizes, in CSS pixels. */
export const NODE_BROWSER_MIN_VIEWPORT = { width: 320, height: 240 } as const;
export const NODE_BROWSER_MAX_VIEWPORT = { width: 3840, height: 2160 } as const;
/** Kept in the hidden text field so a phone keyboard always has something to delete. */
export const NODE_BROWSER_INPUT_SENTINEL = "​";

const WHEEL_DELTA_LIMIT = 10_000;

export type NodeBrowserMouseButton = "none" | "left" | "middle" | "right";
type MouseInput = Extract<NodeBrowserInputEvent, { readonly type: "mouse" }>;
type WheelInput = Extract<NodeBrowserInputEvent, { readonly type: "wheel" }>;

/** Modifier bits: alt 1, ctrl 2, meta 4, shift 8. */
export const nodeBrowserModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export const buttonOf = (button: number): NodeBrowserMouseButton =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

export const pressedButtonOf = (buttons: number): NodeBrowserMouseButton =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

/** Mouse thumb buttons: 3 is Back, 4 is Forward. */
export const historyDeltaOf = (button: number): -1 | 1 | null =>
  button === 3 ? -1 : button === 4 ? 1 : null;

export interface PagePoint {
  readonly x: number;
  readonly y: number;
  /** Page CSS pixels per screen pixel. */
  readonly scale: number;
}

/**
 * Where a point on screen lands on the page, for a frame drawn centered and
 * scaled to fit (`object-fit: contain`) in `box`. `frame` is the image's own
 * size and `viewport` the page's CSS size. Outside the page it is `null`,
 * unless `clamp` pins it to the nearest edge (a drag that left the frame).
 */
export function letterboxPoint(input: {
  readonly box: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly frame: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly clientX: number;
  readonly clientY: number;
  readonly clamp: boolean;
}): PagePoint | null {
  const { box, frame, viewport } = input;
  if (!(frame.width > 0 && frame.height > 0)) return null;
  const fit = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * fit;
  const height = frame.height * fit;
  if (!(width > 0 && height > 0)) return null;
  const scale = viewport.width / width;
  const x = (input.clientX - box.left - (box.width - width) / 2) * scale;
  const y = (input.clientY - box.top - (box.height - height) / 2) * (viewport.height / height);
  const inside = x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
  if (!inside && !input.clamp) return null;
  return {
    x: Math.min(Math.max(x, 0), viewport.width),
    y: Math.min(Math.max(y, 0), viewport.height),
    scale,
  };
}

/** A wheel delta in pixels: lines are 16 px, pages the viewport's height. */
export const wheelPixels = (delta: number, deltaMode: number, viewportHeight: number) =>
  delta * (deltaMode === 1 ? NODE_BROWSER_WHEEL_LINE_PX : deltaMode === 2 ? viewportHeight : 1);

/** Counts consecutive presses of one button within the multi-click time and distance. */
export function createClickCounter() {
  let last: {
    readonly button: NodeBrowserMouseButton;
    readonly time: number;
    readonly x: number;
    readonly y: number;
    readonly count: number;
  } | null = null;
  return {
    count: (button: NodeBrowserMouseButton, x: number, y: number, time: number) => {
      const count =
        last &&
        last.button === button &&
        time - last.time < NODE_BROWSER_MULTI_CLICK_MS &&
        Math.hypot(x - last.x, y - last.y) < NODE_BROWSER_MULTI_CLICK_SLOP_PX
          ? Math.min(last.count + 1, 3)
          : 1;
      last = { button, time, x, y, count };
      return count;
    },
    reset: () => {
      last = null;
    },
  };
}

/**
 * A key press as the node takes it, or `null` for one it must not see:
 * composition, paste (the clipboard arrives as text) and Shift+Escape, which
 * leaves the page. Printable keys without Ctrl or Meta carry their text, and
 * Enter carries "\r" so forms submit and text areas break lines.
 */
export function keyInput(
  action: "down" | "up",
  event: {
    readonly key: string;
    readonly code: string;
    readonly keyCode: number;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly isComposing: boolean;
  },
): NodeBrowserInputEvent | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.key === "Process" ||
    event.key === "Unidentified"
  ) {
    return null;
  }
  const shortcut = event.ctrlKey || event.metaKey;
  if (shortcut && event.key.toLowerCase() === "v") return null;
  if (event.shiftKey && event.key === "Insert") return null;
  if (event.shiftKey && event.key === "Escape") return null;
  const text = shortcut
    ? undefined
    : [...event.key].length === 1
      ? event.key
      : event.key === "Enter"
        ? "\r"
        : undefined;
  return {
    type: "key",
    action,
    key: event.key.slice(0, 32),
    code: event.code.slice(0, 32),
    ...(event.keyCode > 0 && event.keyCode <= 255 ? { keyCode: event.keyCode } : {}),
    ...(action === "down" && text !== undefined ? { text } : {}),
    modifiers: nodeBrowserModifiers(event),
  };
}

/** Text as input events, split to the node's limit per event. */
export function textInputs(text: string): ReadonlyArray<NodeBrowserInputEvent> {
  const events: Array<NodeBrowserInputEvent> = [];
  for (let start = 0; start < text.length; start += NODE_BROWSER_TEXT_LIMIT) {
    events.push({ type: "text", text: text.slice(start, start + NODE_BROWSER_TEXT_LIMIT) });
  }
  return events;
}

const isHover = (event: NodeBrowserInputEvent): event is MouseInput =>
  event.type === "mouse" && event.action === "move";

const clampDelta = (value: number) =>
  Math.min(Math.max(value, -WHEEL_DELTA_LIMIT), WHEEL_DELTA_LIMIT);

/**
 * Sends a viewer's input to the node in order, one call at a time: what
 * arrives while a call is out goes in the next one, so the node applies it in
 * the order it happened. Mouse moves and wheel turns are coalesced to one per
 * animation frame (`schedule`); anything else goes out at once, after them.
 */
export function createNodeBrowserInputQueue(options: {
  readonly send: (events: ReadonlyArray<NodeBrowserInputEvent>) => Promise<unknown>;
  readonly schedule: (flush: () => void) => () => void;
  readonly onError?: (error: unknown) => void;
}) {
  let queued: Array<NodeBrowserInputEvent> = [];
  let move: MouseInput | null = null;
  let wheel: WheelInput | null = null;
  let cancelFrame: (() => void) | null = null;
  let sending = false;
  let stopped = false;

  const takeCoalesced = () => {
    cancelFrame?.();
    cancelFrame = null;
    if (move) queued.push(move);
    if (wheel) queued.push(wheel);
    move = null;
    wheel = null;
  };

  const drain = () => {
    if (sending || stopped || queued.length === 0) return;
    const batch = queued.slice(0, NODE_BROWSER_INPUT_BATCH_LIMIT);
    queued = queued.slice(batch.length);
    sending = true;
    options
      .send(batch)
      .catch((error: unknown) => {
        if (!stopped) options.onError?.(error);
      })
      .finally(() => {
        sending = false;
        drain();
      });
  };

  const scheduleFlush = () => {
    cancelFrame ??= options.schedule(() => {
      cancelFrame = null;
      takeCoalesced();
      drain();
    });
  };

  return {
    push: (event: NodeBrowserInputEvent) => {
      if (stopped) return;
      if (isHover(event)) {
        move = event;
        scheduleFlush();
        return;
      }
      if (event.type === "wheel") {
        wheel = {
          ...event,
          deltaX: clampDelta((wheel?.deltaX ?? 0) + event.deltaX),
          deltaY: clampDelta((wheel?.deltaY ?? 0) + event.deltaY),
        };
        scheduleFlush();
        return;
      }
      takeCoalesced();
      queued.push(event);
      drain();
    },
    /** Sends the coalesced move and wheel now, as before a press. */
    flush: () => {
      takeCoalesced();
      drain();
    },
    /** Drops what was not sent yet, and sends nothing more. */
    stop: () => {
      stopped = true;
      cancelFrame?.();
      cancelFrame = null;
      queued = [];
      move = null;
      wheel = null;
    },
  };
}

export type NodeBrowserInputQueue = ReturnType<typeof createNodeBrowserInputQueue>;
