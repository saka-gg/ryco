import { summarizeDelegatedGroup } from "./inboxDelegationModel";
import type { InboxSection, InboxThreadRow } from "./inboxModel";

export type InboxListItem =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly sectionKey: InboxSection["key"];
      readonly title: string;
      readonly count: number;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly row: InboxThreadRow;
      /** A delegated child shown inside its open parent's group. */
      readonly nested?: boolean;
    }
  | {
      /** The folded line under a parent: "3 delegated · 2 working · 1 done". */
      readonly kind: "delegated-group";
      readonly key: string;
      readonly hostKey: string;
      readonly hostTitle: string;
      readonly summary: string;
      readonly count: number;
      readonly expanded: boolean;
    }
  | { readonly kind: "show-more"; readonly key: string; readonly remaining: number };

export const MOBILE_SETTLED_PAGE_SIZE = 20;

export function flattenInboxSections(input: {
  readonly sections: ReadonlyArray<InboxSection>;
  readonly settledOpen: boolean;
  readonly snoozedOpen?: boolean;
  /** The Hidden shelf starts collapsed, like Snoozed. */
  readonly hiddenOpen?: boolean;
  readonly settledVisibleCount: number;
  /** Parents whose delegated group is open; every group starts folded. */
  readonly openDelegatedHostKeys?: ReadonlySet<string>;
}): ReadonlyArray<InboxListItem> {
  const threadItems = (row: InboxThreadRow): ReadonlyArray<InboxListItem> => {
    const children = row.delegatedChildren ?? [];
    if (children.length === 0) return [{ kind: "thread", key: row.key, row }];
    const open = input.openDelegatedHostKeys?.has(row.key) === true;
    return [
      { kind: "thread", key: row.key, row },
      {
        kind: "delegated-group",
        key: `delegated:${row.key}`,
        hostKey: row.key,
        hostTitle: row.title,
        summary: summarizeDelegatedGroup(children).text,
        count: children.length,
        expanded: open,
      },
      ...(open
        ? children.map((child) => ({
            kind: "thread" as const,
            key: child.key,
            row: child,
            nested: true,
          }))
        : []),
    ];
  };
  return input.sections.flatMap((section): ReadonlyArray<InboxListItem> => {
    const expanded =
      section.key === "snoozed"
        ? input.snoozedOpen === true
        : section.key === "hidden"
          ? input.hiddenOpen === true
          : section.key !== "settled" || input.settledOpen;
    const visibleRows =
      section.key === "settled" ? section.rows.slice(0, input.settledVisibleCount) : section.rows;
    return [
      {
        kind: "section",
        key: `section:${section.key}`,
        sectionKey: section.key,
        title: section.title,
        count: section.rows.length,
        expanded,
      },
      ...(expanded ? visibleRows.flatMap(threadItems) : []),
      ...(section.key === "settled" && expanded && visibleRows.length < section.rows.length
        ? [
            {
              kind: "show-more" as const,
              key: "settled:show-more",
              remaining: section.rows.length - visibleRows.length,
            },
          ]
        : []),
    ];
  });
}

/**
 * The thread row at a zero-based position among the rows the list shows, or
 * null. Command-1 through Command-9 open these, so they follow what the user
 * sees: the current search and machine filter, section order, collapsed
 * sections (skipped) and the settled rows loaded so far.
 */
export function inboxThreadAtPosition(
  items: ReadonlyArray<InboxListItem>,
  position: number,
): InboxThreadRow | null {
  if (position < 0) return null;
  let remaining = position;
  for (const item of items) {
    if (item.kind !== "thread") continue;
    if (remaining === 0) return item.row;
    remaining -= 1;
  }
  return null;
}
