/** `TerminalWriteInput.data` holds at most this many UTF-16 code units. */
export const MAX_TERMINAL_WRITE_CODE_UNITS = 65_536;

/** The longest prefix of `data` within `limit` code units that does not split a surrogate pair. */
function takeWriteChunk(data: string, limit: number): string {
  if (data.length <= limit) return data;
  let end = limit;
  const last = data.charCodeAt(end - 1);
  // A high surrogate at the cut belongs with the next code unit.
  if (end > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return data.slice(0, end);
}

export interface TerminalInputCoalescer {
  /** Queues typed input; it leaves at once when no write is unanswered. */
  readonly push: (data: string) => void;
  /** Input queued behind an unanswered write, not yet sent. */
  readonly pendingLength: () => number;
}

/**
 * Sends one terminal's typed input in order with at most one write unanswered: input typed while
 * a write is in flight joins the next write, sent when the answer arrives. A key typed after a
 * pause leaves at once; fast typing over a slow link (a Hub relay, a phone) costs one request per
 * round trip instead of one per key. A failed write is reported and the queue carries on, as
 * separate writes did.
 */
export function createTerminalInputCoalescer(input: {
  readonly send: (data: string) => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
  readonly maxWriteCodeUnits?: number;
}): TerminalInputCoalescer {
  const limit = Math.max(2, Math.trunc(input.maxWriteCodeUnits ?? MAX_TERMINAL_WRITE_CODE_UNITS));
  let pending = "";
  let inFlight = false;

  const pump = () => {
    if (inFlight || pending.length === 0) return;
    const data = takeWriteChunk(pending, limit);
    pending = pending.slice(data.length);
    inFlight = true;
    let sent: Promise<unknown>;
    try {
      sent = input.send(data);
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent
      .catch((error: unknown) => input.onError?.(error))
      .finally(() => {
        inFlight = false;
        pump();
      });
  };

  return {
    push: (data) => {
      if (data.length === 0) return;
      pending += data;
      pump();
    },
    pendingLength: () => pending.length,
  };
}
