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
  /** The sent message offers "Edit from here". */
  readonly editable?: true;
  /** The reply offers "Undo file changes" for its turn's files. */
  readonly undoable?: true;
  /** The message a link opened this thread at, highlighted briefly. */
  readonly highlighted?: true;
  /** The proposed plan that can be implemented now (Implement, Implement in a new chat). */
  readonly planActionable?: true;
};

export interface ThreadListRowFlags {
  readonly forkableMessageIds: ReadonlySet<MessageId>;
  /** Sent messages the thread can be rewound to before right now. */
  readonly editableMessageIds?: ReadonlySet<MessageId> | undefined;
  /** Replies whose turn's file changes can be undone right now. */
  readonly undoableMessageIds?: ReadonlySet<MessageId> | undefined;
  readonly highlightedMessageId: MessageId | null;
  /** The plan the thread's settled latest turn proposed and nobody implemented yet. */
  readonly actionablePlanId?: string | null;
}

function planIdOfRow(row: ThreadTimelineRow): string | null {
  return row.kind === "entry" && row.entry.kind === "proposed-plan"
    ? row.entry.proposedPlan.id
    : null;
}

function messageIdOfRow(row: ThreadTimelineRow): MessageId | null {
  return row.kind === "entry" && row.entry.kind === "message" ? row.entry.message.id : null;
}

/**
 * The feed list's first-frame estimate of a row's height, before any row is measured. Legend List
 * 3 has no per-row estimate (`getEstimatedItemSize` went with v3): it learns one average per item
 * type (`threadListRowType`) from the rows it measured and uses that for the rows it has not.
 * This only seeds the first frame. From the rows' styles at the default text size: a collapsed
 * work fold is 36 pt (`min-h-8` plus `my-0.5`), a one- to three-line sent message 60 to 110 pt
 * (`py-2` around a `py-2.5` bubble of 24 pt lines), a reply typically 150 to 400 pt. A turn of
 * a message, one or two folds and a reply averages close to 100 pt.
 */
export const THREAD_LIST_ESTIMATED_ROW_SIZE = 100;

/**
 * A row's kind for the feed list (`getItemType`): rows of a kind share a measured average size,
 * so an unmeasured fold (36 pt) is not placed as if it were a reply (hundreds of points) when an
 * older page loads above the reader, and recycled containers go to rows of their own kind. An
 * open fold is its own kind: its height depends on its steps, not on the closed ones.
 */
export function threadListRowType(row: ThreadTimelineRow): string {
  if (row.kind === "activity-fold") return row.expanded ? "fold-open" : "fold";
  const entry = row.entry;
  if (entry.kind === "message") return entry.message.role === "user" ? "sent" : "reply";
  return entry.kind;
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

/**
 * The reply a row's "Fork from here" forks from (and "Undo file changes" undoes the turn of):
 * its own message, or the reply it stands in for.
 */
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
      const messageId = messageIdOfRow(row);
      const editable = messageId !== null && flags.editableMessageIds?.has(messageId) === true;
      const undoable =
        forkMessageId !== null && flags.undoableMessageIds?.has(forkMessageId) === true;
      const highlighted = timelineRowShowsMessage(messagesOfRow(row), flags.highlightedMessageId);
      const planId = planIdOfRow(row);
      const planActionable = planId !== null && (flags.actionablePlanId ?? null) === planId;
      if (!forkable && !editable && !undoable && !highlighted && !planActionable) return row;
      const kept = annotated.get(row);
      if (
        kept &&
        (kept.forkable === true) === forkable &&
        (kept.editable === true) === editable &&
        (kept.undoable === true) === undoable &&
        (kept.highlighted === true) === highlighted &&
        (kept.planActionable === true) === planActionable
      ) {
        return kept;
      }
      const next: ThreadListRow = {
        ...row,
        ...(forkable ? { forkable: true as const } : {}),
        ...(editable ? { editable: true as const } : {}),
        ...(undoable ? { undoable: true as const } : {}),
        ...(highlighted ? { highlighted: true as const } : {}),
        ...(planActionable ? { planActionable: true as const } : {}),
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
