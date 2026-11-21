/**
 * Key names an agent can press in a terminal ("Enter", "Ctrl+C", "Up" ...) and the bytes a real
 * terminal sends for them.
 *
 * @module terminal/agent/keys
 */

const NAMED: Readonly<Record<string, string>> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  "shift+tab": "\u001b[Z",
  escape: "\u001b",
  esc: "\u001b",
  backspace: "\u007f",
  delete: "\u001b[3~",
  del: "\u001b[3~",
  insert: "\u001b[2~",
  space: " ",
  home: "\u001b[H",
  end: "\u001b[F",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  f1: "\u001bOP",
  f2: "\u001bOQ",
  f3: "\u001bOR",
  f4: "\u001bOS",
  f5: "\u001b[15~",
  f6: "\u001b[17~",
  f7: "\u001b[18~",
  f8: "\u001b[19~",
  f9: "\u001b[20~",
  f10: "\u001b[21~",
  f11: "\u001b[23~",
  f12: "\u001b[24~",
};

const ARROWS: Readonly<Record<string, string>> = { up: "A", down: "B", right: "C", left: "D" };

/** Control characters reachable as Ctrl+<char> besides letters. */
const CTRL_SYMBOLS: Readonly<Record<string, string>> = {
  "@": "\u0000",
  space: "\u0000",
  "[": "\u001b",
  "\\": "\u001c",
  "]": "\u001d",
  "^": "\u001e",
  _: "\u001f",
  "?": "\u007f",
};

export const KEY_HELP =
  "Enter, Tab, Shift+Tab, Escape, Backspace, Delete, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F12, Ctrl+<letter> (Ctrl+C interrupts, Ctrl+D ends input), Alt+<key>, or a single character";

export class KeyError extends Error {}

export interface EncodedKey {
  readonly bytes: string;
  /** Types a character into the program (a single character, Space): refused at secret prompts. */
  readonly printable: boolean;
}

/**
 * Translates key names into bytes. `applicationCursor` is the terminal's DECCKM mode (full-screen
 * programs switch arrows to SS3 sequences). Throws {@link KeyError} for an unknown name.
 */
export function encodeKeys(
  keys: ReadonlyArray<string>,
  options: { readonly applicationCursor?: boolean } = {},
): ReadonlyArray<EncodedKey> {
  return keys.map((key) => encodeKey(key, options.applicationCursor ?? false));
}

function encodeKey(raw: string, applicationCursor: boolean): EncodedKey {
  if ([...raw].length === 1) return { bytes: raw, printable: raw >= " " && raw !== "\u007f" };
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/^control\+/, "ctrl+")
    .replace(/^(option|meta)\+/, "alt+");
  if (name === "space") return { bytes: " ", printable: true };
  const named = NAMED[name];
  if (named !== undefined) return { bytes: named, printable: false };
  const arrow = ARROWS[name];
  if (arrow !== undefined) {
    return { bytes: (applicationCursor ? "\u001bO" : "\u001b[") + arrow, printable: false };
  }
  // "ctrl+c", "ctrl+shift+c" (same byte), "^C"
  const ctrl = /^(?:ctrl\+(?:shift\+)?|\^)(.+)$/.exec(name);
  if (ctrl) {
    const target = ctrl[1]!;
    if (/^[a-z]$/.test(target)) {
      return { bytes: String.fromCharCode(target.charCodeAt(0) - 96), printable: false };
    }
    const symbol = CTRL_SYMBOLS[target];
    if (symbol !== undefined) return { bytes: symbol, printable: false };
    const ctrlArrow = ARROWS[target];
    if (ctrlArrow !== undefined) return { bytes: `\u001b[1;5${ctrlArrow}`, printable: false };
  }
  const alt = /^alt\+(.+)$/.exec(name);
  if (alt) {
    const target = alt[1]!;
    if (target.length === 1) return { bytes: `\u001b${raw.trim().slice(-1)}`, printable: false };
    const altArrow = ARROWS[target];
    if (altArrow !== undefined) return { bytes: `\u001b[1;3${altArrow}`, printable: false };
    const altNamed = NAMED[target];
    if (altNamed !== undefined) return { bytes: `\u001b${altNamed}`, printable: false };
  }
  throw new KeyError(`Unknown key "${raw}". Use one of: ${KEY_HELP}.`);
}

/** What was sent, for results ("y" + Enter). Never repeats long text. */
export function describeInput(
  text: string | undefined,
  keys: ReadonlyArray<string> | undefined,
): string {
  const parts: Array<string> = [];
  if (text)
    parts.push(text.length > 60 ? `${text.length} characters of text` : JSON.stringify(text));
  if (keys !== undefined && keys.length > 0) parts.push(keys.join(", "));
  return parts.join(" + ") || "nothing";
}
