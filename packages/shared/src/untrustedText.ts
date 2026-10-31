/**
 * Sanitisers for text from outside the node that Ryco quotes to an agent or a person: a forge's
 * check names and comments (`@ryco/shared/pullRequestWatch`), a watched command's output
 * (`@ryco/shared/commandWatch`), a local dev server's page title and process name. They remove what lets text read differently from what it is.
 * They do not make text trustworthy: messages still frame it as data, never as instructions.
 *
 * @module untrustedText
 */
import { truncateUnicodeSafe } from "./String.ts";

// C0 and C1 controls, line and paragraph separators, and bidirectional overrides,
// isolates and marks (which can make text read differently from what it is).
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- C0 and C1 controls are what it replaces
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
// The same, but keeping tabs and line feeds (a multi-line block).
const UNSAFE_BLOCK_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- C0 and C1 controls are what it replaces
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
// Zero-width characters, invisible operators, the byte order mark and Unicode tags:
// text the chat shows as nothing at all but a model can still read.
const INVISIBLE_CHARACTERS = /[\u200b-\u200d\u2060-\u2064\ufeff\u{e0000}-\u{e007f}]/gu;
// Terminal escape sequences (colours, cursor moves, titles and links): CSI and OSC.
// eslint-disable-next-line no-control-regex -- terminal escapes start with ESC, which it removes
const TERMINAL_ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu;

/**
 * One line of untrusted text: invisible characters go, control characters, line breaks and
 * direction overrides become spaces, whitespace collapses and the result is cut to `maxChars`
 * (never inside a surrogate pair). One line means the text can never start a line of its own,
 * so it cannot pose as Ryco's framing.
 */
export function sanitizeUntrustedLine(value: string | null | undefined, maxChars: number): string {
  if (!value) return "";
  const text = value
    .replaceAll(INVISIBLE_CHARACTERS, "")
    .replaceAll(UNSAFE_CHARACTERS, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length <= maxChars ? text : `${truncateUnicodeSafe(text, maxChars - 3).trimEnd()}...`;
}

/**
 * A multi-line block of untrusted text (a command's output): line breaks and tabs stay;
 * terminal escapes and invisible characters go; every other control, separator and direction
 * character becomes a space. Callers fence the block (see `markdownFenceFor`).
 */
export function sanitizeUntrustedBlock(value: string): string {
  return value
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(TERMINAL_ESCAPES, "")
    .replaceAll(INVISIBLE_CHARACTERS, "")
    .replaceAll(UNSAFE_BLOCK_CHARACTERS, " ");
}

/** A backtick fence longer than any backtick run in `text`, so the text cannot close it. */
export function markdownFenceFor(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}
