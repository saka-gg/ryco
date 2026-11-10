import type { Thread } from "@ryco/client-runtime/state/threads";

import { sameRecordIgnoring } from "../../lib/recordEquality";

// The thread as the screen around the feed sees it: header, composer, sheets
// and cards. A streamed reply changes the thread on every delta, but only its
// messages' text and `updatedAt` move; everything the chrome reads stays. The
// chrome keeps the thread object it last rendered until something else
// changes, so a delta re-renders the feed (which subscribes to the live thread
// itself) and not the whole screen.

type ThreadValue = Thread | null | undefined;

/** Fields a streamed delta changes that the chrome does not read. */
const STREAMED_FIELDS: ReadonlySet<string> = new Set(["messages", "updatedAt"]);

/**
 * The messages as far as the chrome reads them: which there are, and whether the newest is
 * still streaming. A new message, older history, or a reply that settles changes this; the
 * text a delta appends does not.
 */
function sameMessageOutline(a: Thread["messages"], b: Thread["messages"]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const first = 0;
  const last = a.length - 1;
  return (
    a[first]!.id === b[first]!.id &&
    a[last]!.id === b[last]!.id &&
    a[last]!.streaming === b[last]!.streaming &&
    a[last]!.attachments === b[last]!.attachments
  );
}

export function sameThreadChrome(a: ThreadValue, b: ThreadValue): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameRecordIgnoring(a, b, STREAMED_FIELDS) && sameMessageOutline(a.messages, b.messages);
}

/** Fields of a thread's shell summary that move on every streamed delta. */
const SUMMARY_STREAMED_FIELDS: ReadonlySet<string> = new Set(["updatedAt"]);

/**
 * The same for the thread's shell summary (the row the inbox shows): the shell stream touches
 * its `updatedAt` while a reply streams, which nothing on the thread screen reads mid-turn.
 */
export function createThreadSummaryChromeSelector<T extends object>(): (
  summary: T | undefined,
) => T | undefined {
  let last: T | undefined;
  let initialized = false;
  return (summary) => {
    if (
      initialized &&
      (last === summary ||
        (last !== undefined &&
          summary !== undefined &&
          sameRecordIgnoring(last, summary, SUMMARY_STREAMED_FIELDS)))
    ) {
      return last;
    }
    initialized = true;
    last = summary;
    return summary;
  };
}

/**
 * A selector wrapper that returns the thread it returned before while the chrome would render
 * it the same (`sameThreadChrome`). One per screen instance.
 */
export function createThreadChromeSelector(): (thread: Thread | undefined) => Thread | undefined {
  let last: Thread | undefined;
  let initialized = false;
  return (thread) => {
    if (initialized && sameThreadChrome(last, thread)) return last;
    initialized = true;
    last = thread;
    return thread;
  };
}
