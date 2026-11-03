import { BRACKETED_PASTE_END, encodeTerminalPaste } from "@ryco/shared/terminalPaste";

/** `TerminalWriteInput.data` holds at most this many UTF-16 code units. */
export const MAX_TERMINAL_WRITE_CODE_UNITS = 65_536;

export type TerminalAccessoryKey =
  | "arrow-left"
  | "arrow-up"
  | "arrow-down"
  | "arrow-right"
  | "escape"
  | "tab"
  | "pipe"
  | "slash"
  | "hyphen";

const ACCESSORY_SEQUENCE: Record<TerminalAccessoryKey, string> = {
  "arrow-left": "\u001b[D",
  "arrow-up": "\u001b[A",
  "arrow-down": "\u001b[B",
  "arrow-right": "\u001b[C",
  escape: "\u001b",
  tab: "\t",
  pipe: "|",
  slash: "/",
  hyphen: "-",
};

export function terminalAccessorySequence(key: TerminalAccessoryKey): string {
  return ACCESSORY_SEQUENCE[key];
}

/**
 * The accessory row, in order. Arrows lead: history recall and cursor movement
 * are what a phone keyboard lacks most. Ctrl is a one-shot modifier the row
 * inserts after Esc.
 */
export const TERMINAL_ACCESSORY_ROW: ReadonlyArray<
  | {
      readonly kind: "key";
      readonly key: TerminalAccessoryKey;
      readonly label: string;
      readonly name: string;
    }
  | { readonly kind: "control"; readonly label: string; readonly name: string }
> = [
  { kind: "key", key: "arrow-left", label: "←", name: "Left arrow" },
  { kind: "key", key: "arrow-up", label: "↑", name: "Up arrow" },
  { kind: "key", key: "arrow-down", label: "↓", name: "Down arrow" },
  { kind: "key", key: "arrow-right", label: "→", name: "Right arrow" },
  { kind: "key", key: "escape", label: "Esc", name: "Escape" },
  { kind: "control", label: "Ctrl", name: "Control" },
  { kind: "key", key: "tab", label: "Tab", name: "Tab" },
  { kind: "key", key: "pipe", label: "|", name: "Pipe" },
  { kind: "key", key: "slash", label: "/", name: "Slash" },
  { kind: "key", key: "hyphen", label: "-", name: "Hyphen" },
];

/** The control code a one-shot Ctrl turns the next key into, or `null` when none applies. */
export function terminalControlSequence(key: string): string | null {
  const characters = [...key];
  const codePoint = characters[0];
  if (!codePoint || characters.length !== 1) return null;
  const upper = codePoint.toUpperCase();
  if (/^[A-Z]$/u.test(upper)) return String.fromCharCode(upper.charCodeAt(0) & 0x1f);
  if (codePoint === " " || codePoint === "@") return "\u0000";
  if (codePoint === "[") return "\u001b";
  if (codePoint === "\\") return "\u001c";
  if (codePoint === "]") return "\u001d";
  if (codePoint === "^") return "\u001e";
  if (codePoint === "_") return "\u001f";
  if (codePoint === "?") return "\u007f";
  return null;
}

/** Split without separating a UTF-16 surrogate pair. */
export function chunkTerminalInput(
  input: string,
  maxCodeUnits = MAX_TERMINAL_WRITE_CODE_UNITS,
): readonly string[] {
  const limit = Math.max(1, Math.trunc(maxCodeUnits));
  const chunks: string[] = [];
  let current = "";
  for (const character of input) {
    if (current.length > 0 && current.length + character.length > limit) {
      chunks.push(current);
      current = "";
    }
    if (character.length > limit) {
      // The only JavaScript character wider than one code unit is a surrogate
      // pair. A one-code-unit test limit cannot represent it without splitting,
      // so retain it as one safe chunk rather than emit malformed UTF-16.
      chunks.push(character);
      continue;
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export interface TerminalPastePlan {
  /** Writes in order, each within the `terminal.write` limit. */
  readonly chunks: readonly string[];
  /**
   * What to send if the paste stops after its first chunk but before its last:
   * the closing marker of a bracketed paste, so the shell does not keep reading
   * later keystrokes as pasted text. `null` for a plain paste.
   */
  readonly closeSequence: string | null;
}

/** A clipboard paste as ordered `terminal.write` chunks for the terminal's current paste mode. */
export function planTerminalPaste(
  text: string,
  bracketedPaste: boolean,
  maxCodeUnits = MAX_TERMINAL_WRITE_CODE_UNITS,
): TerminalPastePlan {
  if (text.length === 0) return { chunks: [], closeSequence: null };
  return {
    chunks: chunkTerminalInput(encodeTerminalPaste(text, bracketedPaste), maxCodeUnits),
    closeSequence: bracketedPaste ? BRACKETED_PASTE_END : null,
  };
}
