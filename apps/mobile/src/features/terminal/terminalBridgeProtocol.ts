/**
 * The typed message bridge between the native terminal controller and the
 * contained xterm.js renderer. Both sides import this module (the renderer
 * bundles it), so the two decoders cannot drift. It is pure: no React Native,
 * DOM or network imports.
 *
 * Terminal bytes only ever travel as JSON string fields through WebView
 * messaging; they are never interpolated into executable JavaScript.
 */

/** Bumped whenever a message shape changes; a mismatched document is a renderer failure. */
export const TERMINAL_RENDERER_VERSION = "2";

/** Every write and input payload: the size of one `terminal.write` chunk and less. */
export const MAX_RENDERER_ORDINARY_BYTES = 64 * 1024;
/** The one deliberate buffer read, answered only to an explicit copy. */
export const MAX_TERMINAL_SELECTION_BYTES = 128 * 1024;
export const MAX_RENDERER_HISTORY_BYTES = 2 * 1024 * 1024;
/**
 * JSON escapes a control byte as six characters (`\u001b`) and passes every
 * other character through, so a payload bound times six (plus framing) bounds
 * the envelope that carries it.
 */
const JSON_ESCAPE_FACTOR = 6;
const ENVELOPE_FRAMING = 1024;
const MAX_RENDERER_TO_NATIVE_ENVELOPE =
  MAX_TERMINAL_SELECTION_BYTES * JSON_ESCAPE_FACTOR + ENVELOPE_FRAMING;
const MAX_NATIVE_TO_RENDERER_ENVELOPE =
  MAX_RENDERER_HISTORY_BYTES * JSON_ESCAPE_FACTOR + ENVELOPE_FRAMING;
export const MAX_TERMINAL_ID_LENGTH = 128;
export const TERMINAL_HISTORY_OMISSION_MARKER =
  "\r\n[terminal] Older output omitted on this device.\r\n";

export type NativeTerminalMessage =
  | {
      readonly type: "hydrate";
      readonly terminalId: string;
      /** Native's token for this hydration; echoed back by `hydrated`. */
      readonly hydration: number;
      readonly history: string;
    }
  | {
      readonly type: "write";
      readonly terminalId: string;
      readonly sequence: number;
      readonly data: string;
    }
  | { readonly type: "clear"; readonly terminalId: string }
  | { readonly type: "activate"; readonly terminalId: string }
  | { readonly type: "dispose"; readonly terminalId: string }
  | { readonly type: "focus"; readonly terminalId: string }
  | { readonly type: "blur" }
  | { readonly type: "requestSelection"; readonly terminalId: string }
  | {
      readonly type: "appearance";
      readonly fontSize: number;
      readonly colors: Readonly<Record<string, string>>;
    }
  | { readonly type: "connection"; readonly writable: boolean };

export type RendererTerminalMessage =
  | { readonly type: "ready"; readonly rendererVersion: string }
  | { readonly type: "hydrated"; readonly terminalId: string; readonly hydration: number }
  | { readonly type: "written"; readonly terminalId: string; readonly sequence: number }
  | { readonly type: "input"; readonly terminalId: string; readonly data: string }
  | {
      readonly type: "resize";
      readonly terminalId: string;
      readonly cols: number;
      readonly rows: number;
    }
  /** The program in the terminal turned bracketed paste mode on or off. */
  | { readonly type: "modes"; readonly terminalId: string; readonly bracketedPaste: boolean }
  | { readonly type: "selection"; readonly terminalId: string; readonly text: string }
  | { readonly type: "fatal"; readonly code: string };

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Split renderer writes by UTF-8 bytes without separating a Unicode code point. */
export function chunkTerminalBridgeData(
  input: string,
  maxBytes = MAX_RENDERER_ORDINARY_BYTES,
): readonly string[] {
  const limit = Math.max(1, Math.trunc(maxBytes));
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of input) {
    const characterBytes = utf8ByteLength(character);
    if (current.length > 0 && currentBytes + characterBytes > limit) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    if (characterBytes > limit) {
      chunks.push(character);
      continue;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Keep the newest complete-line tail without splitting a Unicode code point. */
export function boundTerminalHistory(
  history: string,
  maxBytes = MAX_RENDERER_HISTORY_BYTES,
): string {
  const limit = Math.max(
    utf8ByteLength(TERMINAL_HISTORY_OMISSION_MARKER) + 1,
    Math.trunc(maxBytes),
  );
  if (utf8ByteLength(history) <= limit) return history;

  const tailLimit = limit - utf8ByteLength(TERMINAL_HISTORY_OMISSION_MARKER);
  const reversed: string[] = [];
  let bytes = 0;
  for (let index = history.length; index > 0;) {
    const last = history.charCodeAt(index - 1);
    const width = last >= 0xdc00 && last <= 0xdfff && index >= 2 ? 2 : 1;
    const character = history.slice(index - width, index);
    const nextBytes = utf8ByteLength(character);
    if (bytes + nextBytes > tailLimit) break;
    reversed.push(character);
    bytes += nextBytes;
    index -= width;
  }
  let tail = reversed.reverse().join("");
  const firstLineBreak = tail.indexOf("\n");
  if (firstLineBreak >= 0 && firstLineBreak < tail.length - 1) {
    tail = tail.slice(firstLineBreak + 1);
  }
  return `${TERMINAL_HISTORY_OMISSION_MARKER}${tail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const allowed = new Set(required);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function isTerminalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TERMINAL_ID_LENGTH &&
    value === value.trim()
  );
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8ByteLength(value) <= maxBytes;
}

function isPositiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 6 && value <= 48;
}

function isColorTable(value: unknown): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([key, color]) =>
        /^[a-z][a-z0-9-]*$/u.test(key) &&
        typeof color === "string" &&
        /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color),
    )
  );
}

function parseEnvelope(raw: unknown, maxLength: number): Record<string, unknown> | null {
  // Length before parsing: the payload bounds below are checked on the parsed fields.
  if (typeof raw !== "string" || raw.length > maxLength) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(candidate) && typeof candidate.type === "string" ? candidate : null;
}

/** Native-side decoder: everything the renderer sends is untrusted. */
export function decodeRendererTerminalMessage(raw: unknown): RendererTerminalMessage | null {
  const candidate = parseEnvelope(raw, MAX_RENDERER_TO_NATIVE_ENVELOPE);
  if (candidate === null) return null;

  switch (candidate.type) {
    case "ready":
      return hasExactKeys(candidate, ["type", "rendererVersion"]) &&
        isBoundedString(candidate.rendererVersion, 64) &&
        candidate.rendererVersion.length > 0
        ? (candidate as RendererTerminalMessage)
        : null;
    case "hydrated":
      return hasExactKeys(candidate, ["type", "terminalId", "hydration"]) &&
        isTerminalId(candidate.terminalId) &&
        isSequence(candidate.hydration)
        ? (candidate as RendererTerminalMessage)
        : null;
    case "written":
      return hasExactKeys(candidate, ["type", "terminalId", "sequence"]) &&
        isTerminalId(candidate.terminalId) &&
        isSequence(candidate.sequence)
        ? (candidate as RendererTerminalMessage)
        : null;
    case "input":
      return hasExactKeys(candidate, ["type", "terminalId", "data"]) &&
        isTerminalId(candidate.terminalId) &&
        isBoundedString(candidate.data, MAX_RENDERER_ORDINARY_BYTES) &&
        candidate.data.length > 0
        ? (candidate as RendererTerminalMessage)
        : null;
    case "resize":
      return hasExactKeys(candidate, ["type", "terminalId", "cols", "rows"]) &&
        isTerminalId(candidate.terminalId) &&
        isPositiveInteger(candidate.cols, 1_000) &&
        isPositiveInteger(candidate.rows, 500)
        ? (candidate as RendererTerminalMessage)
        : null;
    case "modes":
      return hasExactKeys(candidate, ["type", "terminalId", "bracketedPaste"]) &&
        isTerminalId(candidate.terminalId) &&
        typeof candidate.bracketedPaste === "boolean"
        ? (candidate as RendererTerminalMessage)
        : null;
    case "selection":
      return hasExactKeys(candidate, ["type", "terminalId", "text"]) &&
        isTerminalId(candidate.terminalId) &&
        isBoundedString(candidate.text, MAX_TERMINAL_SELECTION_BYTES)
        ? (candidate as RendererTerminalMessage)
        : null;
    case "fatal":
      return hasExactKeys(candidate, ["type", "code"]) &&
        isBoundedString(candidate.code, 64) &&
        /^[a-z0-9._-]+$/u.test(candidate.code)
        ? (candidate as RendererTerminalMessage)
        : null;
    default:
      return null;
  }
}

/** Renderer-side decoder: the document trusts nothing it did not validate. */
export function decodeNativeTerminalMessage(raw: unknown): NativeTerminalMessage | null {
  const candidate = parseEnvelope(raw, MAX_NATIVE_TO_RENDERER_ENVELOPE);
  if (candidate === null) return null;
  const message = candidate as unknown as NativeTerminalMessage;
  switch (candidate.type) {
    case "hydrate":
      return hasExactKeys(candidate, ["type", "terminalId", "hydration", "history"]) &&
        nativeMessageIsValid(message)
        ? message
        : null;
    case "write":
      return hasExactKeys(candidate, ["type", "terminalId", "sequence", "data"]) &&
        nativeMessageIsValid(message)
        ? message
        : null;
    case "clear":
    case "activate":
    case "dispose":
    case "focus":
    case "requestSelection":
      return hasExactKeys(candidate, ["type", "terminalId"]) && nativeMessageIsValid(message)
        ? message
        : null;
    case "blur":
      return hasExactKeys(candidate, ["type"]) ? message : null;
    case "appearance":
      return hasExactKeys(candidate, ["type", "fontSize", "colors"]) &&
        nativeMessageIsValid(message)
        ? message
        : null;
    case "connection":
      return hasExactKeys(candidate, ["type", "writable"]) && nativeMessageIsValid(message)
        ? message
        : null;
    default:
      return null;
  }
}

function nativeMessageIsValid(message: NativeTerminalMessage): boolean {
  switch (message.type) {
    case "hydrate":
      return (
        isTerminalId(message.terminalId) &&
        isSequence(message.hydration) &&
        isBoundedString(message.history, MAX_RENDERER_HISTORY_BYTES)
      );
    case "write":
      return (
        isTerminalId(message.terminalId) &&
        isSequence(message.sequence) &&
        typeof message.data === "string" &&
        message.data.length > 0 &&
        isBoundedString(message.data, MAX_RENDERER_ORDINARY_BYTES)
      );
    case "clear":
    case "activate":
    case "dispose":
    case "focus":
    case "requestSelection":
      return isTerminalId(message.terminalId);
    case "blur":
      return true;
    case "appearance":
      return isFontSize(message.fontSize) && isColorTable(message.colors);
    case "connection":
      return typeof message.writable === "boolean";
  }
}

export function encodeNativeTerminalMessage(message: NativeTerminalMessage): string | null {
  if (!nativeMessageIsValid(message)) return null;
  return JSON.stringify(message);
}

export function encodeRendererTerminalMessage(message: RendererTerminalMessage): string {
  return JSON.stringify(message);
}
