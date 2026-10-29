/**
 * The "next thread that needs you" walk over the live inbox. It loads on the
 * first press, outside the shell's bundle.
 *
 * The walk covers every machine and ignores the inbox's filters, and each
 * delegated child is its own row, so a sub-agent that asks for an approval is
 * the stop, not its host. Rows keep the states their glyphs show: a row on an
 * offline or not-yet-current machine is never a stop.
 */
import {
  isDelegatedThreadLineage,
  resolveThreadAttentionReason,
  stepThreadAttention,
  type ThreadAttentionCandidate,
  type ThreadAttentionWalk,
} from "@ryco/client-runtime/state/threads";

import { isCompletionUnseen } from "../Sidebar.logic";
import { buildInboxSidebarModel, type BuildInboxSidebarInput } from "./inboxSidebarModel";

export interface InboxAttentionInput extends Omit<
  BuildInboxSidebarInput,
  "filters" | "activeThreadKey" | "nestDelegated"
> {
  /** When the user last opened each thread, by thread key. */
  readonly lastVisitedAtByKey: Readonly<Record<string, string>>;
}

/** The last press: where it went, and whether the route has yet to get there. */
export interface InboxAttentionPress {
  readonly walk: ThreadAttentionWalk;
  readonly navigating: boolean;
}

export function buildInboxAttentionCandidates(
  input: InboxAttentionInput,
): ThreadAttentionCandidate[] {
  const { lastVisitedAtByKey, ...inbox } = input;
  const model = buildInboxSidebarModel({
    ...inbox,
    filters: { query: "", environmentId: null, status: "all" },
    nestDelegated: false,
  });
  const candidates: ThreadAttentionCandidate[] = [];
  for (const section of model.sections) {
    if (section.key === "settled" || section.key === "snoozed") continue;
    for (const [index, row] of section.rows.entries()) {
      const reason = resolveThreadAttentionReason({
        state: row.placementState,
        attention: row.attention,
        resting: row.settled || row.snoozedUntil !== null,
        unseen: isCompletionUnseen(row.latestTurnCompletedAt, lastVisitedAtByKey[row.key]),
        delegated: isDelegatedThreadLineage(row.lineage),
      });
      if (reason === null) continue;
      candidates.push({
        key: row.key,
        reason,
        focusIndex: section.key === "focus" ? index : null,
        recencyMs: Date.parse(row.updatedAt),
      });
    }
  }
  return candidates;
}

/**
 * Where a press goes from the routed thread, or null when no other thread
 * needs the user. Until the route reaches the last press's target, the walk
 * goes on from that target, so quick presses never open the same thread twice.
 */
export function stepInboxAttention(
  input: InboxAttentionInput,
  press: {
    readonly routeThreadKey: string | null;
    readonly direction: "previous" | "next";
    readonly previous: InboxAttentionPress | null;
  },
): ThreadAttentionWalk | null {
  const { previous } = press;
  return stepThreadAttention({
    candidates: buildInboxAttentionCandidates(input),
    currentKey: previous?.navigating ? previous.walk.targetKey : press.routeThreadKey,
    direction: press.direction,
    previous: previous?.walk ?? null,
  });
}
