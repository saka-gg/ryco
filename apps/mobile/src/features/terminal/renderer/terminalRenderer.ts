/**
 * The contained terminal renderer: xterm.js inside the terminal WebView.
 *
 * This is the entry `scripts/build-terminal-renderer.mts` bundles into the
 * generated `terminal-renderer.html`; the app never imports it. It owns
 * presentation only. Terminal bytes arrive through the validated bridge, go
 * to xterm's `write` and nowhere else, and input leaves the same way. There is
 * no socket, storage, link handling, title export or clipboard access here.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  createTerminalReplayGate,
  type TerminalReplayGate,
} from "@ryco/client-runtime/state/terminal/replayGate";

import {
  decodeNativeTerminalMessage,
  encodeRendererTerminalMessage,
  MAX_RENDERER_ORDINARY_BYTES,
  MAX_TERMINAL_SELECTION_BYTES,
  TERMINAL_RENDERER_VERSION,
  utf8ByteLength,
  type NativeTerminalMessage,
  type RendererTerminalMessage,
} from "../terminalBridgeProtocol";

interface RendererTerminal {
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  readonly host: HTMLDivElement;
  readonly replayGate: TerminalReplayGate;
  bracketedPaste: boolean;
}

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

const ANSI_COLOR_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const terminals = new Map<string, RendererTerminal>();
const rootElement = document.getElementById("terminal-root");
if (!(rootElement instanceof HTMLDivElement)) throw new Error("terminal-root-missing");
const root: HTMLDivElement = rootElement;

let activeTerminalId: string | null = null;
let writable = false;
let fontSize = 12;
let theme: ITheme = {
  background: "#0b0c0f",
  foreground: "#d9dde5",
  cursor: "#5eead4",
  cursorAccent: "#0b0c0f",
  selectionBackground: "#2f5f5a99",
};

function post(message: RendererTerminalMessage): void {
  window.ReactNativeWebView?.postMessage(encodeRendererTerminalMessage(message));
}

function rendererTheme(colors: Readonly<Record<string, string>>): ITheme {
  const next: ITheme = {
    background: colors.background ?? theme.background,
    foreground: colors.foreground ?? theme.foreground,
    cursor: colors.cursor ?? theme.cursor,
    cursorAccent: colors["cursor-accent"] ?? theme.cursorAccent,
    selectionBackground: colors.selection ?? theme.selectionBackground,
  };
  for (const key of ANSI_COLOR_KEYS) {
    const wireKey = key.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
    const value = colors[wireKey];
    if (value) next[key] = value;
  }
  return next;
}

/**
 * The software keyboard types into xterm's hidden textarea. Shell input is not
 * prose: autocorrect, capitalisation, predictive text and spellcheck would all
 * rewrite what the user typed before it reached the shell.
 */
function disableTextAssistance(textarea: HTMLTextAreaElement | undefined): void {
  if (!textarea) return;
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "none");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("enterkeyhint", "send");
}

/** Tell native when the program turns bracketed paste mode on or off. */
function reportModes(terminalId: string, renderer: RendererTerminal, force = false): void {
  const bracketedPaste = renderer.terminal.modes.bracketedPasteMode;
  if (!force && bracketedPaste === renderer.bracketedPaste) return;
  renderer.bracketedPaste = bracketedPaste;
  post({ type: "modes", terminalId, bracketedPaste });
}

function ensureTerminal(terminalId: string): RendererTerminal {
  const existing = terminals.get(terminalId);
  if (existing) return existing;

  const host = document.createElement("div");
  host.className = "terminal-host";
  host.dataset.active = "false";
  root.append(host);

  const terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: writable,
    disableStdin: !writable,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize,
    lineHeight: 1.2,
    logLevel: "off",
    scrollback: 5_000,
    theme,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host);
  disableTextAssistance(terminal.textarea);
  const replayGate = createTerminalReplayGate(terminal);
  const created: RendererTerminal = { terminal, fitAddon, host, replayGate, bracketedPaste: false };

  terminal.onData((data) => {
    if (!writable || activeTerminalId !== terminalId) return;
    // Replies to replayed history were answered when it was live.
    if (replayGate.dropsData(data)) return;
    if (utf8ByteLength(data) > MAX_RENDERER_ORDINARY_BYTES) return;
    post({ type: "input", terminalId, data });
  });
  terminal.onResize(({ cols, rows }) => post({ type: "resize", terminalId, cols, rows }));

  terminals.set(terminalId, created);
  return created;
}

function fitActiveTerminal(): void {
  if (!activeTerminalId) return;
  const active = terminals.get(activeTerminalId);
  if (!active) return;
  try {
    active.fitAddon.fit();
  } catch {
    post({ type: "fatal", code: "fit-failed" });
  }
}

function activateTerminal(terminalId: string): void {
  const active = ensureTerminal(terminalId);
  activeTerminalId = terminalId;
  for (const [id, renderer] of terminals) {
    renderer.host.dataset.active = String(id === terminalId);
  }
  requestAnimationFrame(() => {
    fitActiveTerminal();
    post({
      type: "resize",
      terminalId,
      cols: active.terminal.cols,
      rows: active.terminal.rows,
    });
  });
}

function handleMessage(message: NativeTerminalMessage): void {
  switch (message.type) {
    case "hydrate": {
      const renderer = ensureTerminal(message.terminalId);
      const { terminal, replayGate } = renderer;
      terminal.reset();
      replayGate.replay(() => {
        terminal.write("\u001bc");
        if (message.history.length > 0) terminal.write(message.history);
      });
      terminal.write("", () => {
        post({ type: "hydrated", terminalId: message.terminalId, hydration: message.hydration });
        reportModes(message.terminalId, renderer, true);
      });
      return;
    }
    case "write": {
      const renderer = ensureTerminal(message.terminalId);
      renderer.terminal.write(message.data, () => {
        post({ type: "written", terminalId: message.terminalId, sequence: message.sequence });
        reportModes(message.terminalId, renderer);
      });
      return;
    }
    case "clear": {
      const renderer = ensureTerminal(message.terminalId);
      renderer.terminal.clear();
      renderer.terminal.write("\u001bc", () => reportModes(message.terminalId, renderer));
      return;
    }
    case "activate":
      activateTerminal(message.terminalId);
      return;
    case "dispose": {
      const renderer = terminals.get(message.terminalId);
      renderer?.terminal.dispose();
      renderer?.host.remove();
      terminals.delete(message.terminalId);
      if (activeTerminalId === message.terminalId) activeTerminalId = null;
      return;
    }
    case "focus":
      if (writable) ensureTerminal(message.terminalId).terminal.focus();
      return;
    case "blur":
      for (const renderer of terminals.values()) renderer.terminal.blur();
      return;
    case "requestSelection": {
      const text = ensureTerminal(message.terminalId).terminal.getSelection();
      post({
        type: "selection",
        terminalId: message.terminalId,
        text: utf8ByteLength(text) <= MAX_TERMINAL_SELECTION_BYTES ? text : "",
      });
      return;
    }
    case "appearance":
      fontSize = message.fontSize;
      theme = rendererTheme(message.colors);
      for (const renderer of terminals.values()) {
        renderer.terminal.options.fontSize = fontSize;
        renderer.terminal.options.theme = theme;
      }
      requestAnimationFrame(fitActiveTerminal);
      return;
    case "connection":
      writable = message.writable;
      for (const renderer of terminals.values()) {
        renderer.terminal.options.disableStdin = !writable;
        renderer.terminal.options.cursorBlink = writable;
        if (!writable) renderer.terminal.blur();
      }
      return;
  }
}

function receive(event: MessageEvent<unknown>): void {
  const message = decodeNativeTerminalMessage(event.data);
  if (message) handleMessage(message);
}

window.addEventListener("message", receive);
// Android's WebView delivers native messages on the document.
document.addEventListener("message", receive as EventListener);
const resizeObserver = new ResizeObserver(() => requestAnimationFrame(fitActiveTerminal));
resizeObserver.observe(root);
post({ type: "ready", rendererVersion: TERMINAL_RENDERER_VERSION });
