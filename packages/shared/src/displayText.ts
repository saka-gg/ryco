/**
 * One line of untrusted text that Ryco shows or quotes (forge check names and comments, local
 * server page titles and process names).
 *
 * @module displayText
 */
import { truncateUnicodeSafe } from "./String.ts";

// C0 and C1 controls, line and paragraph separators, and bidirectional overrides,
// isolates and marks (which can make text read differently from what it is).
const UNSAFE_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
// Zero-width characters, invisible operators, the byte order mark and Unicode tags:
// text the chat shows as nothing at all but a model can still read.
const INVISIBLE_CHARACTERS = /[\u200b-\u200d\u2060-\u2064\ufeff\u{e0000}-\u{e007f}]/gu;

/**
 * The one sanitiser for untrusted text: invisible characters go, control characters, line
 * breaks and direction overrides become spaces, whitespace collapses and the result is cut to
 * `maxChars` (never inside a surrogate pair). One line means such text can never start a line of
 * its own, so it cannot pose as Ryco's framing.
 */
export function sanitizeDisplayText(value: string | null | undefined, maxChars: number): string {
  if (!value) return "";
  const text = value
    .replaceAll(INVISIBLE_CHARACTERS, "")
    .replaceAll(UNSAFE_CHARACTERS, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length <= maxChars ? text : `${truncateUnicodeSafe(text, maxChars - 3).trimEnd()}...`;
}
