/**
 * latin1Output - Keeps the server bundle's source text in Latin-1.
 *
 * V8 stores a script's source as a one-byte string only when every character
 * is Latin-1; a single em dash anywhere doubles the in-heap size of the whole
 * multi-megabyte chunk. This rolldown plugin rewrites every character above
 * U+00FF as an escape sequence wherever that preserves meaning: string and
 * untagged template literals, regular expressions, identifiers and comments.
 * Tagged template quasis are left untouched, because a tag can observe the raw
 * text, and so is a character that is already part of a backslash escape.
 *
 * @module latin1Output
 */

/** The ESTree shape this transform relies on: nodes with UTF-16 `start`/`end`. */
interface EstreeNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

export interface Latin1EscapeResult {
  readonly code: string;
  /** Characters above U+00FF left as-is: in tagged templates or after a backslash. */
  readonly preserved: number;
}

const isNode = (value: unknown): value is EstreeNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { start?: unknown }).start === "number" &&
  typeof (value as { end?: unknown }).end === "number";

function collectRanges(program: unknown): {
  readonly tagged: Array<Range>;
  readonly identifiers: Array<Range>;
  readonly literals: Array<Range>;
} {
  const tagged: Array<Range> = [];
  const identifiers: Array<Range> = [];
  const literals: Array<Range> = [];
  const stack: Array<unknown> = [program];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (!isNode(value)) continue;
    if (value.type === "TaggedTemplateExpression") {
      const quasi = (value as unknown as { readonly quasi?: { readonly quasis?: unknown } }).quasi;
      for (const element of Array.isArray(quasi?.quasis) ? quasi.quasis : []) {
        if (isNode(element)) tagged.push({ start: element.start, end: element.end });
      }
    } else if (value.type.endsWith("Identifier")) {
      identifiers.push({ start: value.start, end: value.end });
    } else if (value.type === "Literal" || value.type === "TemplateElement") {
      literals.push({ start: value.start, end: value.end });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "type" && typeof child === "object" && child !== null) stack.push(child);
    }
  }
  const byStart = (left: Range, right: Range) => left.start - right.start;
  return {
    tagged: tagged.toSorted(byStart),
    identifiers: identifiers.toSorted(byStart),
    literals: literals.toSorted(byStart),
  };
}

/** Whether `offset` lies in one of the (start-sorted, possibly nested) ranges. */
function makeRangeCursor(ranges: ReadonlyArray<Range>) {
  let index = 0;
  let coveredUntil = -1;
  return (offset: number): boolean => {
    while (index < ranges.length && ranges[index]!.start <= offset) {
      coveredUntil = Math.max(coveredUntil, ranges[index]!.end);
      index += 1;
    }
    return offset < coveredUntil;
  };
}

const hex4 = (codeUnit: number) => codeUnit.toString(16).toUpperCase().padStart(4, "0");

/** Whether the character at `offset` follows an odd number of backslashes. */
function isEscaped(code: string, offset: number): boolean {
  let backslashes = 0;
  while (offset - backslashes - 1 >= 0 && code.charCodeAt(offset - backslashes - 1) === 0x5c) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Escapes every character above U+00FF in `code`, a parsed JavaScript module.
 * Astral characters become surrogate-pair escapes (valid in strings, templates
 * and regular expressions with or without the `u` flag), or `\u{...}` inside
 * identifiers, where surrogate escapes are not allowed.
 */
export function escapeNonLatin1(
  code: string,
  parse: (code: string) => unknown,
): Latin1EscapeResult | null {
  let first = 0;
  while (first < code.length && code.charCodeAt(first) <= 0xff) first += 1;
  if (first === code.length) return null;
  const { tagged, identifiers, literals } = collectRanges(parse(code));
  const inTaggedTemplate = makeRangeCursor(tagged);
  const inIdentifier = makeRangeCursor(identifiers);
  const inLiteral = makeRangeCursor(literals);
  const parts: Array<string> = [];
  let preserved = 0;
  let copiedUntil = 0;
  for (let offset = first; offset < code.length; offset += 1) {
    const codeUnit = code.charCodeAt(offset);
    if (codeUnit <= 0xff) continue;
    const codePoint = code.codePointAt(offset)!;
    const width = codePoint > 0xffff ? 2 : 1;
    // A tag can read the raw text, and inside a string, template or regular
    // expression a character after an odd run of backslashes is part of an
    // escape (`\—` is an identity escape, `\<U+2028>` a line continuation) that
    // an inserted `\u` sequence would change. Comments are always safe.
    if (inTaggedTemplate(offset) || (inLiteral(offset) && isEscaped(code, offset))) {
      preserved += 1;
      offset += width - 1;
      continue;
    }
    parts.push(code.slice(copiedUntil, offset));
    if (width === 1) {
      parts.push(`\\u${hex4(codeUnit)}`);
    } else if (inIdentifier(offset)) {
      parts.push(`\\u{${codePoint.toString(16).toUpperCase()}}`);
    } else {
      parts.push(`\\u${hex4(codeUnit)}\\u${hex4(code.charCodeAt(offset + 1))}`);
    }
    offset += width - 1;
    copiedUntil = offset + 1;
  }
  parts.push(code.slice(copiedUntil));
  return { code: parts.join(""), preserved };
}

/**
 * The rolldown plugin. Rewrites the final chunks in `generateBundle`, after
 * every `renderChunk` transform (tsdown's own included) has run; chunks that
 * are already Latin-1 are left untouched.
 */
export function latin1OutputPlugin() {
  return {
    name: "ryco:latin1-output",
    generateBundle(
      this: { readonly parse: (code: string) => unknown; readonly warn: (message: string) => void },
      _outputOptions: unknown,
      bundle: Record<string, { type: string; fileName: string; code?: string }>,
    ) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || typeof output.code !== "string") continue;
        const result = escapeNonLatin1(output.code, (source) => this.parse(source));
        if (result === null) continue;
        if (result.preserved > 0) {
          this.warn(
            `${output.fileName}: ${result.preserved} non-Latin-1 characters in tagged templates or escapes were kept; V8 stores this chunk as a two-byte string.`,
          );
        }
        output.code = result.code;
      }
    },
  };
}
