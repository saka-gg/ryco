/**
 * Command palette search and result ordering, shared by the web palette and the
 * native mobile one so both find and rank the same results for the same query.
 *
 * Items are anything that carries search terms. Each client keeps its own
 * presentation (icons, rows, what an item does) next to these fields, which is
 * why everything here is generic over the item type.
 */

export interface CommandPaletteSearchItem {
  /** Fields in priority order: a match in an earlier field ranks the item higher. */
  readonly searchTerms: ReadonlyArray<string>;
  /** IDs that find the item when the query is an ID or ID fragment; such matches list last. */
  readonly idSearchTerms?: ReadonlyArray<string>;
}

export interface CommandPaletteSearchGroup<TItem> {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<TItem>;
}

/** A group searched only while typing, listed after the browse groups. */
export interface CommandPaletteTypedSearchGroup<TItem> extends CommandPaletteSearchGroup<TItem> {
  /** Lists at most this many of the group's best matches. */
  readonly limit?: number;
}

/** The group a leading `>` narrows the palette to. */
export const COMMAND_PALETTE_ACTIONS_GROUP = "actions";
/** Shown while the query is empty, and replaced by the typed search groups once it is not. */
export const COMMAND_PALETTE_RECENT_THREADS_GROUP = "recent-threads";
/** A query starting with this shows actions only. */
export const COMMAND_PALETTE_ACTIONS_PREFIX = ">";
/** How many recent threads the empty palette lists. */
export const COMMAND_PALETTE_RECENT_THREAD_LIMIT = 12;

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when the query asks for actions only (it starts with `>`). */
export function isCommandPaletteActionsQuery(query: string): boolean {
  return query.startsWith(COMMAND_PALETTE_ACTIONS_PREFIX);
}

/** The groups an empty palette shows: actions, then recent threads. Empty groups are left out. */
export function buildCommandPaletteRootGroups<TItem>(input: {
  readonly actionItems: ReadonlyArray<TItem>;
  readonly recentThreadItems: ReadonlyArray<TItem>;
}): CommandPaletteSearchGroup<TItem>[] {
  const groups: CommandPaletteSearchGroup<TItem>[] = [];
  if (input.actionItems.length > 0) {
    groups.push({
      value: COMMAND_PALETTE_ACTIONS_GROUP,
      label: "Actions",
      items: input.actionItems,
    });
  }
  if (input.recentThreadItems.length > 0) {
    groups.push({
      value: COMMAND_PALETTE_RECENT_THREADS_GROUP,
      label: "Recent Threads",
      items: input.recentThreadItems,
    });
  }
  return groups;
}

function rankSearchFieldMatch(field: string, normalizedQuery: string): number {
  const normalizedField = normalizeSearchText(field);
  if (normalizedField.length === 0 || !normalizedField.includes(normalizedQuery)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  return 1;
}

function rankCommandPaletteItemMatch(item: CommandPaletteSearchItem, normalizedQuery: string) {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }

  return 0;
}

const ID_FRAGMENT_MIN_LENGTH = 6;
/** Below every search term match, including one that spans two terms (rank 0). */
const ID_ONLY_MATCH_RANK = -1;

/**
 * Matches the whole ID, or a fragment of at least six characters that contains
 * a digit. Thread IDs come in several shapes (UUIDs, `thread-…`, `fork-…`,
 * `import-…`), so the digit rule, not a format, keeps words like "face",
 * "decade" or "thread" from listing every thread.
 */
function createIdSearchMatcher(normalizedQuery: string): (id: string) => boolean {
  const fragmentQuery =
    normalizedQuery.length >= ID_FRAGMENT_MIN_LENGTH && /\d/.test(normalizedQuery);
  return (id) => {
    const normalizedId = id.toLowerCase();
    return (
      normalizedId === normalizedQuery || (fragmentQuery && normalizedId.includes(normalizedQuery))
    );
  };
}

/**
 * The groups a query shows, each with its matching items ranked.
 *
 * An empty query shows `activeGroups` unchanged. A query matches an item when
 * its search terms, joined, contain the whole normalized query; an item whose
 * earlier term contains it ranks higher, and an exact or prefix match beats a
 * match inside a term. Ties keep the order the client gave. A leading `>` keeps
 * only the actions group. Outside a submenu, typing replaces recent threads
 * with `searchGroups`.
 */
export function filterCommandPaletteGroups<TItem extends CommandPaletteSearchItem>(input: {
  readonly activeGroups: ReadonlyArray<CommandPaletteSearchGroup<TItem>>;
  readonly query: string;
  readonly isInSubmenu: boolean;
  readonly searchGroups: ReadonlyArray<CommandPaletteTypedSearchGroup<TItem>>;
}): CommandPaletteSearchGroup<TItem>[] {
  const isActionsFilter = isCommandPaletteActionsQuery(input.query);
  const searchQuery = isActionsFilter
    ? input.query.slice(COMMAND_PALETTE_ACTIONS_PREFIX.length)
    : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);

  if (normalizedQuery.length === 0) {
    if (isActionsFilter) {
      return input.activeGroups.filter((group) => group.value === COMMAND_PALETTE_ACTIONS_GROUP);
    }
    return [...input.activeGroups];
  }

  let baseGroups: ReadonlyArray<CommandPaletteTypedSearchGroup<TItem>> = input.activeGroups;
  if (isActionsFilter) {
    baseGroups = baseGroups.filter((group) => group.value === COMMAND_PALETTE_ACTIONS_GROUP);
  } else if (!input.isInSubmenu) {
    baseGroups = baseGroups.filter((group) => group.value !== COMMAND_PALETTE_RECENT_THREADS_GROUP);
  }

  const searchableGroups =
    !input.isInSubmenu && !isActionsFilter
      ? [...baseGroups, ...input.searchGroups.filter((group) => group.items.length > 0)]
      : [...baseGroups];

  const matchesId = createIdSearchMatcher(normalizedQuery);
  return searchableGroups.flatMap((group) => {
    const items = group.items
      .map((item, index) => {
        const haystack = normalizeSearchText(item.searchTerms.join(" "));
        if (!haystack.includes(normalizedQuery)) {
          return item.idSearchTerms?.some(matchesId)
            ? { item, index, rank: ID_ONLY_MATCH_RANK }
            : null;
        }

        return {
          item,
          index,
          rank: rankCommandPaletteItemMatch(item, normalizedQuery),
        };
      })
      .filter((entry): entry is { item: TItem; index: number; rank: number } => entry !== null)
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .slice(0, group.limit)
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

export interface CommandPaletteRowItem {
  readonly value: string;
  readonly disabled?: boolean;
}

export type CommandPaletteRow<TItem> =
  | {
      readonly kind: "label";
      readonly key: string;
      readonly label: string;
      readonly first: boolean;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: TItem;
      /** Position among enabled items, or null for disabled rows the keyboard skips. */
      readonly itemIndex: number | null;
    };

export interface CommandPaletteRows<TItem> {
  readonly rows: ReadonlyArray<CommandPaletteRow<TItem>>;
  /** The highlightable items in order: what arrow keys step through and numbers pick. */
  readonly itemValues: ReadonlyArray<string>;
  /** Maps a highlighted item's index back to its row, for scrolling it into view. */
  readonly rowIndexByItemIndex: ReadonlyArray<number>;
}

/**
 * Flattens groups into the rows a virtualized list renders: each group's label,
 * then its items. Disabled items get a row but no item index, as they are not
 * options the keyboard can reach.
 */
export function buildCommandPaletteRows<TItem extends CommandPaletteRowItem>(
  groups: ReadonlyArray<CommandPaletteSearchGroup<TItem>>,
): CommandPaletteRows<TItem> {
  const rows: CommandPaletteRow<TItem>[] = [];
  const itemValues: string[] = [];
  const rowIndexByItemIndex: number[] = [];
  for (const group of groups) {
    if (group.label) {
      rows.push({
        kind: "label",
        key: `group:${group.value}`,
        label: group.label,
        first: rows.length === 0,
      });
    }
    for (const item of group.items) {
      const itemIndex = item.disabled ? null : itemValues.length;
      if (itemIndex !== null) {
        itemValues.push(item.value);
        rowIndexByItemIndex.push(rows.length);
      }
      rows.push({ kind: "item", key: `${group.value}:${item.value}`, item, itemIndex });
    }
  }
  return { rows, itemValues, rowIndexByItemIndex };
}

/** The enabled item Enter should run for a highlight, whether or not its row is mounted. */
export function findHighlightedCommandPaletteItem<TItem extends CommandPaletteRowItem>(
  groups: ReadonlyArray<CommandPaletteSearchGroup<TItem>>,
  highlightedItemValue: string | null,
): TItem | null {
  if (highlightedItemValue === null) return null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.value === highlightedItemValue && !item.disabled) return item;
    }
  }
  return null;
}
