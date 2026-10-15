/**
 * Byte- and line-bounded terminal scrollback.
 *
 * The retained history is a plain string, so every append used to re-run a
 * whole-history `split`/`join` (one line-cap pass per PTY chunk). This module
 * keeps a running byte count instead and trims from the head only when a
 * budget is exceeded, so the steady-state cost of an output chunk is
 * proportional to the chunk, not to the retained history.
 *
 * Byte accounting is a deterministic UTF-8 estimate computed arithmetically
 * per code unit. It is self-consistent (the same counter decrements what it
 * incremented) and only ever over-counts lone or paired surrogates, matching
 * the conservative direction a memory bound needs.
 */

export interface HistoryBufferState {
  readonly history: string;
  readonly approxBytes: number;
  /** Number of newline characters; segments = newlines + partial tail. */
  readonly newlineCount: number;
}

export interface HistoryBufferLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

export const emptyHistoryBufferState = (): HistoryBufferState => ({
  history: "",
  approxBytes: 0,
  newlineCount: 0,
});

/** The module's UTF-8 byte estimate (see the module note), for callers sizing history text. */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
      continue;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      // Surrogates: accounting each half as a 3-byte replacement sequence
      // only ever over-counts, which is what a memory bound needs.
      bytes += 3;
      continue;
    }
    bytes += codeUnit < 0x800 ? 2 : 3;
  }
  return bytes;
};

export const countNewlines = (text: string): number => {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
};

const effectiveLines = (state: HistoryBufferState): number => {
  const hasPartialTail = state.history.length > 0 && !state.history.endsWith("\n");
  return state.newlineCount + (hasPartialTail ? 1 : 0);
};

/**
 * Drop the history head until the retained bytes fit `maxBytes`. Single pass:
 * walk past the excess bytes, then extend to the next line boundary when one
 * exists so the retained tail starts on a fresh line. Returns null when the
 * history is already within budget or nothing can be dropped.
 */
const dropHeadToByteBudget = (
  state: HistoryBufferState,
  maxBytes: number,
): HistoryBufferState | null => {
  const excessBytes = state.approxBytes - maxBytes;
  if (excessBytes <= 0) {
    return null;
  }
  let index = 0;
  let dropped = 0;
  while (index < state.history.length && dropped < excessBytes) {
    dropped += utf8ByteLength(state.history[index] ?? "");
    index += 1;
  }
  // Extend the cut to the next line boundary so the retained tail starts on
  // a fresh line, keeping the byte ledger exact for the bytes actually
  // removed.
  // A cut already at a line boundary must not discard another line.
  // Never retain the low half of a surrogate pair.
  if (
    index > 0 &&
    state.history.charCodeAt(index - 1) >= 0xd800 &&
    state.history.charCodeAt(index - 1) <= 0xdbff &&
    state.history.charCodeAt(index) >= 0xdc00 &&
    state.history.charCodeAt(index) <= 0xdfff
  ) {
    dropped += 3;
    index += 1;
  }
  const nextNewline = state.history[index - 1] === "\n" ? -1 : state.history.indexOf("\n", index);
  if (nextNewline !== -1) {
    while (index <= nextNewline) {
      dropped += utf8ByteLength(state.history[index] ?? "");
      index += 1;
    }
  }
  if (index <= 0) {
    return null;
  }
  return {
    history: state.history.slice(index),
    approxBytes: Math.max(0, state.approxBytes - dropped),
    newlineCount: Math.max(0, state.newlineCount - countNewlines(state.history.slice(0, index))),
  };
};

/** Drop `linesToDrop` whole head lines in a single pass. */
const dropHeadLines = (
  state: HistoryBufferState,
  linesToDrop: number,
): HistoryBufferState | null => {
  if (linesToDrop <= 0) {
    return null;
  }
  let index = 0;
  let droppedLines = 0;
  while (droppedLines < linesToDrop && index < state.history.length) {
    const newlineIndex = state.history.indexOf("\n", index);
    if (newlineIndex === -1) {
      break;
    }
    index = newlineIndex + 1;
    droppedLines += 1;
  }
  if (droppedLines === 0) {
    return null;
  }
  return {
    history: state.history.slice(index),
    approxBytes: Math.max(0, state.approxBytes - utf8ByteLength(state.history.slice(0, index))),
    newlineCount: Math.max(0, state.newlineCount - droppedLines),
  };
};

const enforceLimits = (
  state: HistoryBufferState,
  limits: HistoryBufferLimits,
): HistoryBufferState => {
  let next = state;
  while (next.approxBytes > limits.maxBytes) {
    const trimmed = dropHeadToByteBudget(next, limits.maxBytes);
    if (trimmed === null) {
      break;
    }
    next = trimmed;
  }
  while (effectiveLines(next) > limits.maxLines) {
    const trimmed = dropHeadLines(next, effectiveLines(next) - limits.maxLines);
    if (trimmed === null) {
      break;
    }
    next = trimmed;
  }
  return next;
};

/**
 * Append one sanitized output chunk and re-enforce both budgets. Appends under
 * budget cost one linear scan of the chunk (bytes + newline count); the
 * retained history is only touched when a budget overflows, and each trim
 * removes at least the excess, so cost stays amortized against chunk size.
 */
export const appendTerminalHistoryChunk = (
  state: HistoryBufferState,
  chunk: string,
  limits: HistoryBufferLimits,
): HistoryBufferState => {
  if (chunk.length === 0) {
    return state;
  }
  const appended = {
    history: `${state.history}${chunk}`,
    approxBytes: state.approxBytes + utf8ByteLength(chunk),
    newlineCount: state.newlineCount + countNewlines(chunk),
  };
  if (appended.approxBytes <= limits.maxBytes && effectiveLines(appended) <= limits.maxLines) {
    return appended;
  }
  return enforceLimits(appended, limits);
};

/** Re-derive counts for history loaded from disk, enforcing both budgets. */
export const historyBufferStateFrom = (
  history: string,
  limits: HistoryBufferLimits,
): HistoryBufferState => {
  if (history.length === 0) {
    return emptyHistoryBufferState();
  }
  return enforceLimits(
    {
      history,
      approxBytes: utf8ByteLength(history),
      newlineCount: countNewlines(history),
    },
    limits,
  );
};
