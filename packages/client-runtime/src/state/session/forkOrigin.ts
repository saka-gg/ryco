/**
 * The divider a forked thread shows after its inherited history: where it came from, how its
 * provider continues, and which files it works on. Decoded from the single `thread.forked`
 * provenance activity; the copy is shared so web and mobile say the same thing.
 */
import type {
  MessageId,
  OrchestrationThreadActivity,
  ThreadForkCheckout,
  ThreadForkHandoffReason,
  ThreadForkProviderContext,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import {
  inheritedItemIdPrefix,
  readThreadForkedActivity,
  threadIdOfForkedActivityId,
} from "@ryco/shared/threadFork";

export interface ForkOriginTimelineEntry {
  id: string;
  activityId: string;
  /** When the fork was created. The timeline places the divider by structure, not by this. */
  createdAt: string;
  /**
   * The id prefix of the history this fork inherited (`<forkThreadId>:inherited:`): the divider
   * follows every item with it and precedes every other item, whatever the clocks say.
   */
  inheritedItemIdPrefix?: string;
  sourceThreadId: ThreadId;
  /** The reply the inherited history ends at (inclusive), in the source thread. */
  sourceMessageId: MessageId;
  sourceTurnId: TurnId;
  /** The source's title when it was forked; it survives the source's deletion. */
  sourceTitle: string;
  inheritedMessageCount: number;
  providerContext: ThreadForkProviderContext;
  handoffReason?: ThreadForkHandoffReason;
  checkout: ThreadForkCheckout;
  notices: ReadonlyArray<string>;
}

// Store activity records are immutable and reused across derivations, so the divider keeps
// its identity (and its rendered row) while other activities change.
const entryByActivity = new WeakMap<OrchestrationThreadActivity, ForkOriginTimelineEntry>();

/** The fork-origin divider of a `thread.forked` activity; null for anything else. */
export function toForkOriginTimelineEntry(
  activity: OrchestrationThreadActivity,
): ForkOriginTimelineEntry | null {
  const cached = entryByActivity.get(activity);
  if (cached) return cached;
  const forked = readThreadForkedActivity(activity);
  if (!forked) return null;
  const forkThreadId = threadIdOfForkedActivityId(activity.id);
  const entry: ForkOriginTimelineEntry = {
    id: `fork-origin:${activity.id}`,
    activityId: activity.id,
    createdAt: activity.createdAt,
    ...(forkThreadId ? { inheritedItemIdPrefix: inheritedItemIdPrefix(forkThreadId) } : {}),
    sourceThreadId: forked.sourceThreadId,
    sourceMessageId: forked.sourceMessageId,
    sourceTurnId: forked.sourceTurnId,
    sourceTitle: forked.sourceTitle,
    inheritedMessageCount: forked.inheritedMessageCount,
    providerContext: forked.providerContext,
    ...(forked.handoffReason ? { handoffReason: forked.handoffReason } : {}),
    checkout: forked.checkout,
    notices: forked.notices,
  };
  entryByActivity.set(activity, entry);
  return entry;
}

/**
 * The source turn a fork's inherited history ends at, from its `thread.forked` activity; null
 * for a thread that is not a fork. Until the fork runs a turn of its own this is the latest turn
 * of everything it shows, so its inherited history renders as the source did when that turn was
 * the source's latest (earlier turns keep only their messages, as on the source).
 */
export function forkBoundaryTurnId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnId | null {
  for (const activity of activities) {
    const entry = toForkOriginTimelineEntry(activity);
    if (entry) return entry.sourceTurnId;
  }
  return null;
}

/** A fork timeline's inherited-history id prefix, from its divider; null for other threads. */
export function forkTimelineInheritedPrefix(
  forkOriginEntries: ReadonlyArray<Pick<ForkOriginTimelineEntry, "inheritedItemIdPrefix">>,
): string | null {
  for (const entry of forkOriginEntries) {
    if (entry.inheritedItemIdPrefix) return entry.inheritedItemIdPrefix;
  }
  return null;
}

/**
 * Where a timeline entry belongs on a fork: 0 its inherited history, 1 the fork-origin divider,
 * 2 everything of its own. Timelines order by these bands before time, because a fork's own
 * messages carry the sending client's clock: one running behind the node would otherwise sort
 * above the divider, among the inherited history. Every entry of a thread that is not a fork
 * (`inheritedPrefix` null) is band 0, so its order stays purely chronological.
 */
export function forkTimelineBand(
  entry: { readonly kind: string; readonly id: string },
  inheritedPrefix: string | null,
): 0 | 1 | 2 {
  if (inheritedPrefix === null) return 0;
  if (entry.kind === "fork-origin") return 1;
  return entry.id.startsWith(inheritedPrefix) ? 0 : 2;
}

const HANDOFF_REASON_COPY = {
  "provider-unsupported": "This provider can't copy its session.",
  "no-native-session": "The original thread had no provider session to copy.",
  "turn-not-in-native-session":
    "The original provider session no longer reaches back to this point.",
  "native-fork-failed": "The provider couldn't copy its session.",
  "native-fork-uncertain":
    "Ryco couldn't confirm the provider copied its session, so it doesn't use a copy.",
} as const satisfies Record<ThreadForkHandoffReason, string>;

export const FORK_ORIGIN_COPY = {
  forkedFrom: "Forked from",
  /** Shown instead of a link once the source thread is gone. */
  sourceUnavailable: "The original thread is no longer available.",
  native: "Continues an independent copy of the provider's session from this point.",
  /** Stays true after delivery: the divider is history, the handoff divider shows delivery. */
  handoff:
    "The fork's first message starts a fresh session that receives this conversation as context. Tool results and reasoning from before the fork aren't carried over.",
  /** A composer hint while `forkContextHandoffPending` (`@ryco/shared/threadFork`) holds. */
  handoffPending: "Your next message sends this conversation to a fresh session as context.",
  handoffReasons: HANDOFF_REASON_COPY,
  unchangedFiles: "Files weren't copied or rewound.",
  newChat: "New chat with an empty folder. Files from the original chat weren't copied.",
} as const;

/** `Forked from “<source title>”` */
export function forkOriginHeadline(entry: Pick<ForkOriginTimelineEntry, "sourceTitle">): string {
  return `${FORK_ORIGIN_COPY.forkedFrom} “${entry.sourceTitle}”`;
}

/** How the fork's provider continues, with why it could not copy the session natively. */
export function forkOriginProviderLine(
  entry: Pick<ForkOriginTimelineEntry, "providerContext" | "handoffReason">,
): string {
  if (entry.providerContext === "native") return FORK_ORIGIN_COPY.native;
  return entry.handoffReason
    ? `${HANDOFF_REASON_COPY[entry.handoffReason]} ${FORK_ORIGIN_COPY.handoff}`
    : FORK_ORIGIN_COPY.handoff;
}

/** Which files the fork works on, and how they relate to this point in the conversation. */
export function forkOriginCheckoutLine(entry: Pick<ForkOriginTimelineEntry, "checkout">): string {
  const { checkout } = entry;
  switch (checkout.kind) {
    case "current-checkout": {
      const shared = checkout.worktreePath
        ? `Shares the original's worktree${checkout.branch ? ` on ${checkout.branch}` : ""}.`
        : checkout.branch
          ? `Shares the original's checkout on ${checkout.branch}.`
          : "Shares the original's folder.";
      return `${shared} ${FORK_ORIGIN_COPY.unchangedFiles}`;
    }
    case "new-worktree":
      return checkout.start === "checkpoint"
        ? `New worktree on ${checkout.branch}, from this turn's saved checkpoint.`
        : `New worktree on ${checkout.branch}, from ${checkout.baseRef}. Files may differ from this point in the conversation.`;
    case "new-chat":
      return FORK_ORIGIN_COPY.newChat;
  }
}

/** The whole divider as sentences, for screen readers. */
export function forkOriginAccessibleLabel(entry: ForkOriginTimelineEntry): string {
  return [
    forkOriginHeadline(entry),
    forkOriginProviderLine(entry),
    forkOriginCheckoutLine(entry),
    ...entry.notices,
  ]
    .map((part) => part.replace(/\.+$/, ""))
    .join(". ");
}
