import {
  delegatedTasksSummaryText,
  planDelegatedNesting,
  type DelegatedNestingItem,
  type DelegatedNestingUrgency,
} from "@ryco/client-runtime/state/threads";
import type { ThreadLineage } from "@ryco/contracts/orchestration";

import {
  buildChatsFilterChips,
  buildChatsSections,
  chatsAttentionOf,
  type ChatsFilter,
  type ChatsFilterChip,
} from "../home/chatsListModel";
import type { InboxSection, InboxThreadRow } from "./inboxModel";

// Delegated threads in Chats: a chat's delegated tasks fold under it instead
// of crowding the top level, by the shared nesting rule web's inbox uses
// (`planDelegatedNesting`). One phone rule on top: a child that needs the
// person stays at the top level, where Needs you lists it with its parent's
// name, instead of being reached only through its parent.

function urgencyOf(section: InboxSection["key"], row: InboxThreadRow): DelegatedNestingUrgency {
  switch (section) {
    case "snoozed":
      return "snoozed";
    case "settled":
      return "settled";
    case "hidden":
      return "hidden";
    default: {
      const attention = chatsAttentionOf(row);
      return attention === "needs-you"
        ? "needs-input"
        : attention === "working"
          ? "active"
          : "recent";
    }
  }
}

/**
 * Fold delegated children under their topmost visible host row, in every
 * section. `lineageByKey` lists every thread's lineage (archived and
 * filtered-out ones included), so a child whose middle ancestor is not listed
 * still finds its host. Rows keep their order; a host carries its children,
 * newest first, in `delegatedChildren`.
 */
export function nestDelegatedInboxRows(
  sections: ReadonlyArray<InboxSection>,
  lineageByKey: ReadonlyMap<string, ThreadLineage | null | undefined>,
): ReadonlyArray<InboxSection> {
  const items: DelegatedNestingItem[] = [];
  const rowByKey = new Map<string, InboxThreadRow>();
  for (const section of sections) {
    for (const row of section.rows) {
      rowByKey.set(row.key, row);
      items.push({
        key: row.key,
        environmentId: row.environmentId,
        threadId: row.threadId,
        lineage: row.lineage,
        // A pinned child stays where the person put it; one that needs them stays in sight.
        pinned: row.pinned || chatsAttentionOf(row) === "needs-you",
        urgency: urgencyOf(section.key, row),
      });
    }
  }
  const plan = planDelegatedNesting(items, { lineageByKey });
  if (plan.hostByChildKey.size === 0) return sections;
  return sections.flatMap((section) => {
    const rows = section.rows.flatMap((row) => {
      if (plan.hostByChildKey.has(row.key)) return [];
      const childKeys = plan.childKeysByHostKey.get(row.key);
      if (childKeys === undefined) return [row];
      const children = childKeys
        .flatMap((key) => {
          const child = rowByKey.get(key);
          return child ? [child] : [];
        })
        .toSorted(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
            left.key.localeCompare(right.key),
        );
      return [{ ...row, delegatedChildren: children }];
    });
    return rows.length > 0 ? [{ ...section, rows }] : [];
  });
}

export interface DelegatedGroupSummary {
  readonly total: number;
  readonly needsYou: number;
  readonly working: number;
  readonly done: number;
  /** "3 delegated · 2 working · 1 done": counts of zero are left out. */
  readonly text: string;
}

/** What a folded group says before it is opened. */
export function summarizeDelegatedGroup(
  children: ReadonlyArray<InboxThreadRow>,
): DelegatedGroupSummary {
  let needsYou = 0;
  let working = 0;
  let done = 0;
  for (const child of children) {
    const attention = child.state === "settled" ? "done" : chatsAttentionOf(child);
    if (attention === "needs-you") needsYou += 1;
    else if (attention === "working") working += 1;
    else done += 1;
  }
  // Worded by the shared rule, so a chat's context names its children's state alike.
  const text = delegatedTasksSummaryText(
    { working, needsYou, failed: 0, done, returned: 0, returning: 0 },
    children.length,
  );
  return { total: children.length, needsYou, working, done, text };
}

/**
 * What Chats shows for a chip: the chip's sections with delegated children folded, and the
 * chips' counts. Both read the unfolded rows, and the folding runs after the chip's filter: a
 * working child of a resting parent still counts under Working and is listed there (on its own,
 * since its parent is not), instead of disappearing under a parent the chip leaves out.
 */
export function buildChatsListing(
  sections: ReadonlyArray<InboxSection>,
  filter: ChatsFilter,
  lineageByKey: ReadonlyMap<string, ThreadLineage | null | undefined>,
): {
  readonly sections: ReadonlyArray<InboxSection>;
  readonly chips: ReadonlyArray<ChatsFilterChip>;
} {
  return {
    sections: nestDelegatedInboxRows(buildChatsSections(sections, filter), lineageByKey),
    chips: buildChatsFilterChips(sections, filter),
  };
}
