/**
 * How a viewer's input (`NodeBrowserInputEvent`, `@ryco/contracts/node-browser`) becomes Chrome
 * DevTools Protocol commands: the node browser's own tabs (apps/server nodeBrowserRuntime) and a
 * desktop tab handed to the user and viewed remotely (apps/desktop browserHandoffs) send the same
 * commands. Pure: the caller sends them and keeps the pressed-key state.
 *
 * @module nodeBrowserInputCdp
 */
import type { NodeBrowserInputEvent } from "@ryco/contracts/node-browser";

/** One CDP command. */
export interface NodeBrowserCdpCommand {
  readonly method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";
  readonly params: Record<string, unknown>;
}

/** Keys and buttons a viewer holds down, so `release` (or a lost viewer) can let go of them. */
export interface NodeBrowserPressedState {
  readonly pressedKeys: Map<string, { readonly key: string; readonly code: string }>;
  readonly pressedButtons: Map<string, { readonly x: number; readonly y: number }>;
}

export const makeNodeBrowserPressedState = (): NodeBrowserPressedState => ({
  pressedKeys: new Map(),
  pressedButtons: new Map(),
});

/** Copy, cut, select all, undo and redo for Ctrl or Cmd shortcuts, as Chrome's editor names them. */
export const editingCommand = (key: string, modifiers: number) => {
  const modifier = modifiers & 0b0111;
  if (modifier !== 2 && modifier !== 4) return null;
  const lower = key.toLowerCase();
  const command =
    lower === "c"
      ? "copy"
      : lower === "x"
        ? "cut"
        : modifier !== 4
          ? null
          : lower === "a"
            ? "selectAll"
            : lower === "z"
              ? modifiers & 8
                ? "redo"
                : "undo"
              : null;
  return command ? { commands: [command] } : null;
};

/** A mouse move with no button held, which a later one replaces. */
const isHover = (event: NodeBrowserInputEvent) =>
  event.type === "mouse" && event.action === "move" && event.buttons === 0;

/** Drops hovers a later hover in the same batch replaces, so clicks never wait behind them. */
export const coalesceInput = (events: ReadonlyArray<NodeBrowserInputEvent>) =>
  events.filter(
    (event, index) => !(isHover(event) && events[index + 1] && isHover(events[index + 1]!)),
  );

/**
 * Keys that, with Ctrl or Cmd, are app-level chords in a desktop browser shell: close tab or
 * window (W, F4), quit (Q), reload (R), new window or tab (N, T), address bar (L), find (F, G),
 * settings (,), zoom (= + - _ 0), history ([ ]), tab and window switching (Tab, `), hide and
 * minimize (H, M). Copy, cut, select all, undo, redo and text formatting pass.
 */
const APP_CHORD_KEYS = new Set([
  "w",
  "f4",
  "q",
  "r",
  "n",
  "t",
  "l",
  "f",
  "g",
  ",",
  "=",
  "+",
  "-",
  "_",
  "0",
  "[",
  "]",
  "tab",
  "`",
  "h",
  "m",
]);
/** With Ctrl or Cmd and also Shift or Alt: the devtools (I, J, C). */
const APP_DEVTOOLS_KEYS = new Set(["i", "j", "c"]);
/** Keys that are app-level on their own: find next, address bar, reload, fullscreen, devtools. */
const APP_SOLO_KEYS = new Set([
  "f3",
  "f5",
  "f6",
  "f11",
  "f12",
  "browserback",
  "browserforward",
  "browserrefresh",
]);
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

/**
 * Whether a remote key event is an app-level chord of the desktop shell rather than typing, for
 * a desktop tab handed off to a remote user (`apps/desktop/src/computerUse/browserHandoffs.ts`):
 * those are dropped, so a remote Ctrl/Cmd+W, Q or R can never close, quit or reload anything,
 * whichever system the desktop runs (Electron routes unhandled keys to menu accelerators on
 * Windows and Linux). Ctrl and Cmd count the same: the viewer's system may differ from the
 * desktop's. Alt+Left/Right (history) and Alt+F4 count too, and pasting by key (see below).
 * Plain typing, Shift, arrows and copy, cut, select all, undo and redo pass; copy and cut write
 * the desktop's clipboard, where the remote viewer's own copy cannot reach (the viewer keeps
 * its clipboard to itself).
 */
export function isAppLevelChord(event: {
  readonly key: string;
  readonly code: string;
  readonly modifiers: number;
}): boolean {
  const key = event.key.toLowerCase();
  // A non-Latin layout's letter: the physical key decides (KeyW is W). Only letters: AltGr+Q
  // types "@" on a German layout (Ctrl+Alt, code KeyQ), and that is typing.
  const latin =
    /^\p{L}$/u.test(key) && !/^[a-z]$/u.test(key) && /^Key[A-Z]$/u.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : key;
  if (APP_SOLO_KEYS.has(key)) return true;
  // Paste, as text or not (Ctrl/Cmd+V, +Shift: the app's Paste as Text, Shift+Insert) would read
  // the desktop's own clipboard: off macOS, Chromium pastes it for such a key. Ryco's viewers never
  // send these keys (keyInput answers null) and send their own clipboard as text (onPaste); a
  // client that sends them anyway is ignored here.
  if (key === "insert" && event.modifiers & SHIFT) return true;
  if (event.modifiers & (CTRL | META)) {
    if (latin === "v") return true;
    if (APP_CHORD_KEYS.has(latin) || APP_CHORD_KEYS.has(key)) return true;
    return Boolean(event.modifiers & (SHIFT | ALT)) && APP_DEVTOOLS_KEYS.has(latin);
  }
  if (event.modifiers & ALT) return key === "arrowleft" || key === "arrowright" || key === "f4";
  return false;
}

/**
 * Remote input events a handed-off desktop tab never gets: app-level chords and key pastes
 * (`isAppLevelChord`), and middle-button presses, which open a link in a new tab (a tab the hand-off
 * does not cover). The back and forward buttons cannot arrive at all: the input schema has only
 * left, middle and right.
 */
export function isDroppedHandoffInput(event: NodeBrowserInputEvent): boolean {
  if (event.type === "key") return isAppLevelChord(event);
  if (event.type === "mouse") return event.action !== "move" && event.button === "middle";
  return false;
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** The commands that let go of every key and button still held; the state is cleared. */
export function releaseHeldCommands(state: NodeBrowserPressedState): NodeBrowserCdpCommand[] {
  const keys = [...state.pressedKeys.values()];
  const buttons = [...state.pressedButtons];
  state.pressedKeys.clear();
  state.pressedButtons.clear();
  return [
    ...keys.map(({ key, code }) => ({
      method: "Input.dispatchKeyEvent" as const,
      params: { type: "keyUp", key, code },
    })),
    ...buttons.map(([button, point]) => ({
      method: "Input.dispatchMouseEvent" as const,
      params: { type: "mouseReleased", button, ...point, buttons: 0, clickCount: 1 },
    })),
  ];
}

/**
 * The commands for one event, in CSS pixels of a `viewport`-sized page (points are clamped into
 * it). Updates `state` with what the event presses or lets go of.
 */
export function nodeBrowserInputCommands(
  event: NodeBrowserInputEvent,
  state: NodeBrowserPressedState,
  viewport: { readonly width: number; readonly height: number },
): NodeBrowserCdpCommand[] {
  switch (event.type) {
    case "mouse": {
      const x = clamp(event.x, viewport.width);
      const y = clamp(event.y, viewport.height);
      const type =
        event.action === "down"
          ? "mousePressed"
          : event.action === "up"
            ? "mouseReleased"
            : "mouseMoved";
      if (event.button !== "none") {
        if (event.action === "down") state.pressedButtons.set(event.button, { x, y });
        else if (event.action === "up") state.pressedButtons.delete(event.button);
      }
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type,
            x,
            y,
            button: event.button,
            buttons: event.buttons,
            clickCount: event.clickCount,
            modifiers: event.modifiers,
          },
        },
      ];
    }
    case "wheel":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: clamp(event.x, viewport.width),
            y: clamp(event.y, viewport.height),
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            modifiers: event.modifiers,
          },
        },
      ];
    case "key": {
      if (event.action === "up") {
        state.pressedKeys.delete(event.code || event.key);
        return [
          {
            method: "Input.dispatchKeyEvent",
            params: {
              type: "keyUp",
              key: event.key,
              code: event.code,
              modifiers: event.modifiers,
            },
          },
        ];
      }
      state.pressedKeys.set(event.code || event.key, { key: event.key, code: event.code });
      const text = event.text;
      return [
        {
          method: "Input.dispatchKeyEvent",
          params: {
            type: text ? "keyDown" : "rawKeyDown",
            key: event.key,
            code: event.code,
            modifiers: event.modifiers,
            ...(text ? { text, unmodifiedText: text } : {}),
            ...editingCommand(event.key, event.modifiers),
            windowsVirtualKeyCode:
              event.keyCode ?? (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0),
          },
        },
      ];
    }
    case "text":
      return [{ method: "Input.insertText", params: { text: event.text } }];
    case "release":
      return releaseHeldCommands(state);
  }
}
