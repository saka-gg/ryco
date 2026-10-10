/**
 * cdpFrameReader - Splits the preview browser's NUL-delimited CDP output into
 * messages, holding no more of any one message than Ryco may need.
 *
 * A page decides how large some events are (one `console.log` of a 300 MB
 * string arrives as one message), so a message past its limit is dropped
 * unread; only its start and end are kept, which name what it was.
 *
 * @module cdpFrameReader
 */

export type CdpFrame =
  | { readonly _tag: "Message"; readonly text: string }
  /** A message past its limit: its first and last characters only. */
  | { readonly _tag: "Oversized"; readonly head: string; readonly tail: string };

export interface CdpFrameLimits {
  /** Replies to Ryco's own commands, which start `{"id":`. */
  readonly maxReplyChars: number;
  /** Everything else: events, whose size a page may decide. */
  readonly maxEventChars: number;
}

// Enough for a message's id or method and first parameter, and its session.
const EDGE_CHARS = 256;

/** The last `count` characters across `parts`, without joining them all. */
const lastChars = (parts: ReadonlyArray<string>, count: number) => {
  let text = "";
  for (let index = parts.length - 1; index >= 0 && text.length < count; index -= 1) {
    text = parts[index]! + text;
  }
  return text.slice(-count);
};

export const makeCdpFrameReader = (limits: CdpFrameLimits) => {
  let parts: Array<string> = [];
  let length = 0;
  let head = "";
  let tail = "";
  let dropping = false;

  const append = (text: string) => {
    if (text === "") return;
    if (head.length < EDGE_CHARS) head += text.slice(0, EDGE_CHARS - head.length);
    length += text.length;
    if (dropping) {
      tail = (tail + text.slice(-EDGE_CHARS)).slice(-EDGE_CHARS);
      return;
    }
    parts.push(text);
    // The limit is only reached long after the head is complete.
    const limit = head.startsWith('{"id":') ? limits.maxReplyChars : limits.maxEventChars;
    if (length > limit) {
      dropping = true;
      tail = lastChars(parts, EDGE_CHARS);
      parts = [];
    }
  };

  const finish = (): CdpFrame => {
    const frame: CdpFrame = dropping
      ? { _tag: "Oversized", head, tail }
      : { _tag: "Message", text: parts.length === 1 ? parts[0]! : parts.join("") };
    parts = [];
    length = 0;
    head = "";
    tail = "";
    dropping = false;
    return frame;
  };

  return {
    /** Takes the next decoded chunk and returns every message it completes. */
    push: (text: string): ReadonlyArray<CdpFrame> => {
      const frames: Array<CdpFrame> = [];
      let start = 0;
      for (let end = text.indexOf("\0"); end !== -1; end = text.indexOf("\0", start)) {
        append(text.slice(start, end));
        frames.push(finish());
        start = end + 1;
      }
      if (start < text.length) append(text.slice(start));
      return frames;
    },
  };
};
