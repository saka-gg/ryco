import {
  findTimelineMessageRowIndex,
  timelineRowShowsMessage,
  type TimelineRowMessages,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";

import type { ThreadTimelineRow } from "./threadActivityFold";

// How the thread screen's LegendList shows its rows beyond the timeline itself: per-row state
// that lives outside the timeline (fork eligibility, the message a link opened the thread at),
// anchoring the list to that message, and how a link opens another thread.

/** A timeline row with the per-row state the list renders from. */
export type ThreadListRow = ThreadTimelineRow & {
  /** The reply offers "Fork from here". */
  readonly forkable?: true;
  /** The message a link opened this thread at, highlighted briefly. */
  readonly highlighted?: true;
};

export interface ThreadListRowFlags {
  readonly forkableMessageIds: ReadonlySet<MessageId>;
  readonly highlightedMessageId: MessageId | null;
}

function messageIdOfRow(row: ThreadTimelineRow): MessageId | null {
  return row.kind === "entry" && row.entry.kind === "message" ? row.entry.message.id : null;
}

/**
 * The messages a row shows: its own, and the blank reply a page row stands in for (`forkReply`),
 * which renders no row of its own. A link to either lands on the row (the shared rule).
 */
function messagesOfRow(row: ThreadTimelineRow): TimelineRowMessages {
  return {
    messageId: messageIdOfRow(row),
    standsInFor: row.kind === "entry" ? (row.forkReply?.id ?? null) : null,
  };
}

/** The reply a row's "Fork from here" forks from: its own message, or the reply it stands in for. */
function forkMessageIdOfRow(row: ThreadTimelineRow): MessageId | null {
  return row.kind === "entry" && row.forkReply ? row.forkReply.id : messageIdOfRow(row);
}

/**
 * Puts per-row state onto the rows themselves. LegendList re-renders a mounted row only when its
 * item changes (it memoizes each row on the item and `extraData`, never on `renderItem`), so
 * state read from `renderItem`'s closure, such as fork eligibility flipping when the node becomes
 * ready, would never reach rows already on screen. Rows whose flags did not change keep their
 * identity, so a flip re-renders exactly the rows it affects. One annotator per list.
 */
export function createThreadListRowAnnotator(): (
  rows: ReadonlyArray<ThreadTimelineRow>,
  flags: ThreadListRowFlags,
) => ReadonlyArray<ThreadListRow> {
  const annotated = new WeakMap<ThreadTimelineRow, ThreadListRow>();
  return (rows, flags) =>
    rows.map((row): ThreadListRow => {
      const forkMessageId = forkMessageIdOfRow(row);
      const forkable = forkMessageId !== null && flags.forkableMessageIds.has(forkMessageId);
      const highlighted = timelineRowShowsMessage(messagesOfRow(row), flags.highlightedMessageId);
      if (!forkable && !highlighted) return row;
      const kept = annotated.get(row);
      if (
        kept &&
        (kept.forkable === true) === forkable &&
        (kept.highlighted === true) === highlighted
      ) {
        return kept;
      }
      const next: ThreadListRow = {
        ...row,
        ...(forkable ? { forkable: true as const } : {}),
        ...(highlighted ? { highlighted: true as const } : {}),
      };
      annotated.set(row, next);
      return next;
    });
}

/**
 * The list index of the row that shows a message (its own, or the page row standing in for a
 * blank reply), or -1 while it is not loaded.
 */
export function threadMessageRowIndex(
  rows: ReadonlyArray<ThreadTimelineRow>,
  messageId: MessageId,
): number {
  return findTimelineMessageRowIndex(rows, messageId, messagesOfRow);
}

export type ThreadMessageAnchorStep =
  | { readonly kind: "scroll"; readonly index: number }
  /** The message is not in the loaded window: load the history around it (once). */
  | { readonly kind: "load" }
  | { readonly kind: "wait" };

/**
 * What anchoring the list to `messageId` does next: scroll once its row is loaded, else load the
 * history around it once the thread's history window exists (and only once per anchor; a
 * message that never arrives leaves the list where it is).
 */
export function nextThreadMessageAnchorStep(input: {
  readonly rows: ReadonlyArray<ThreadTimelineRow>;
  readonly messageId: MessageId;
  readonly loadRequested: boolean;
  readonly historyReady: boolean;
}): ThreadMessageAnchorStep {
  const index = threadMessageRowIndex(input.rows, input.messageId);
  if (index >= 0) return { kind: "scroll", index };
  return input.historyReady && !input.loadRequested ? { kind: "load" } : { kind: "wait" };
}

/** The params of the Thread route; `messageId` opens it scrolled to that message. */
export interface ThreadRouteParams {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId?: MessageId;
}

interface NavigationStateLike {
  readonly index: number;
  readonly routes: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly params?: object | undefined;
  }>;
}

export type OpenThreadNavigation =
  /**
   * The thread is the previous screen: go back instead of stacking a second copy of it, after
   * pointing that screen at the message (`anchor`) when there is one.
   */
  | {
      readonly kind: "back";
      readonly anchor: {
        readonly routeKey: string;
        readonly params: { readonly messageId: MessageId };
      } | null;
    }
  /** Push, so Back returns here; `navigate` would reuse this screen and drop it from the stack. */
  | { readonly kind: "push"; readonly params: ThreadRouteParams };

/** How a link on a thread screen opens another thread of the same environment. */
export function resolveOpenThreadNavigation(input: {
  readonly state: NavigationStateLike | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId | null;
}): OpenThreadNavigation {
  const { state, environmentId, threadId, messageId } = input;
  const previous = state ? state.routes[state.index - 1] : undefined;
  const params = previous?.params as
    | { readonly environmentId?: unknown; readonly threadId?: unknown }
    | undefined;
  if (
    previous?.name === "Thread" &&
    params?.environmentId === environmentId &&
    params.threadId === threadId
  ) {
    return {
      kind: "back",
      anchor: messageId ? { routeKey: previous.key, params: { messageId } } : null,
    };
  }
  return {
    kind: "push",
    params: { environmentId, threadId, ...(messageId ? { messageId } : {}) },
  };
}
