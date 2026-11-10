import type { TerminalEvent, TerminalRef } from "@ryco/contracts";

export const terminalSessionKey = (threadId: string, terminalId: string) =>
  JSON.stringify([threadId, terminalId]);

/**
 * The terminals one connection shows, from `terminal.open` with `attachOutput`, the `attached`
 * list of a scoped `subscribeTerminalEvents` and `terminal.detachOutput`. A scoped stream sends
 * `output` events only for these; session metadata still covers every terminal. One per
 * connection, so a reconnect starts empty and the client's new subscription names what it shows.
 */
export interface TerminalOutputAttachments {
  readonly attach: (ref: TerminalRef) => void;
  readonly detach: (ref: TerminalRef) => void;
  readonly includes: (event: Pick<TerminalEvent, "threadId" | "terminalId">) => boolean;
}

export function makeTerminalOutputAttachments(): TerminalOutputAttachments {
  const attached = new Set<string>();
  return {
    attach: (ref) => {
      attached.add(terminalSessionKey(ref.threadId, ref.terminalId));
    },
    detach: (ref) => {
      attached.delete(terminalSessionKey(ref.threadId, ref.terminalId));
    },
    includes: (event) => attached.has(terminalSessionKey(event.threadId, event.terminalId)),
  };
}

/**
 * Bytes a scoped subscriber may hold while its client is in the background. Past it the held
 * events are dropped and the subscription ends with the `slowConsumer` resync on return, the same
 * path a client that fell behind takes: it resubscribes and re-hydrates what it shows through
 * `terminal.open` with `sinceCursor`.
 */
export const TERMINAL_BACKGROUND_HOLD_MAX_BYTES = 1024 * 1024;

type HeldEntry =
  | { readonly kind: "event"; event: TerminalEvent }
  | {
      readonly kind: "output";
      readonly first: Extract<TerminalEvent, { type: "output" }>;
      last: Extract<TerminalEvent, { type: "output" }>;
      readonly parts: string[];
    };

/**
 * Holds a scoped subscriber's events while its client is in the background and gives them back in
 * order on return. Consecutive output of one terminal leaves as one event (the data joined, the
 * last cursor), and consecutive activity of one terminal keeps only the newest, so a noisy
 * terminal costs one message on return instead of one per read. Ordering within a terminal is
 * kept; terminals are independent, so merging may move a terminal's output ahead of another's.
 */
export function makeTerminalBackgroundHold(input: {
  readonly maxBytes?: number;
  readonly sizeOf: (event: TerminalEvent) => number;
}) {
  const maxBytes = input.maxBytes ?? TERMINAL_BACKGROUND_HOLD_MAX_BYTES;
  let entries: HeldEntry[] = [];
  const lastIndexByKey = new Map<string, number>();
  let bytes = 0;
  let overflowed = false;

  const reset = () => {
    entries = [];
    lastIndexByKey.clear();
    bytes = 0;
  };

  return {
    hold(event: TerminalEvent): void {
      if (overflowed) return;
      const key = terminalSessionKey(event.threadId, event.terminalId);
      const index = lastIndexByKey.get(key);
      const previous = index === undefined ? undefined : entries[index];
      bytes += input.sizeOf(event);
      if (
        previous?.kind === "output" &&
        event.type === "output" &&
        previous.last.cursor?.generation === event.cursor?.generation
      ) {
        previous.parts.push(event.data);
        previous.last = event;
      } else if (
        index !== undefined &&
        previous?.kind === "event" &&
        previous.event.type === "activity" &&
        event.type === "activity"
      ) {
        previous.event = event;
      } else {
        entries.push(
          event.type === "output"
            ? { kind: "output", first: event, last: event, parts: [event.data] }
            : { kind: "event", event },
        );
        lastIndexByKey.set(key, entries.length - 1);
      }
      if (bytes > maxBytes) {
        overflowed = true;
        reset();
      }
    },
    /** Ends the hold: the held events in order, or `null` when they outgrew the budget. */
    release(): ReadonlyArray<TerminalEvent> | null {
      if (overflowed) {
        overflowed = false;
        reset();
        return null;
      }
      const events = entries.map((entry): TerminalEvent => {
        if (entry.kind === "event") return entry.event;
        if (entry.parts.length === 1) return entry.first;
        return { ...entry.last, data: entry.parts.join("") };
      });
      reset();
      return events;
    },
  };
}
