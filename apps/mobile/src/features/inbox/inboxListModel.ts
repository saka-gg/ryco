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
  | { readonly kind: "thread"; readonly key: string; readonly row: InboxThreadRow }
  | { readonly kind: "show-more"; readonly key: string; readonly remaining: number };

export const MOBILE_SETTLED_PAGE_SIZE = 20;

export function flattenInboxSections(input: {
  readonly sections: ReadonlyArray<InboxSection>;
  readonly settledOpen: boolean;
  readonly snoozedOpen?: boolean;
  readonly settledVisibleCount: number;
}): ReadonlyArray<InboxListItem> {
  return input.sections.flatMap((section): ReadonlyArray<InboxListItem> => {
    const expanded =
      section.key === "snoozed"
        ? input.snoozedOpen === true
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
      ...(expanded
        ? visibleRows.map((row) => ({ kind: "thread" as const, key: row.key, row }))
        : []),
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
