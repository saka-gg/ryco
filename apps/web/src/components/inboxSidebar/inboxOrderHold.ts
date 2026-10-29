/**
 * Holding the inbox's order while the user aims at it: rows keep the places
 * they had when the hold began, but show their live data. A thread that
 * finishes keeps its row in Active now under the Completed glyph until the hold
 * ends, and the list then glides to its live order.
 *
 * Pinning, settling and snoozing are the user's own moves and never wait for a
 * hold: a row whose lifecycle changed takes its live place at once, like a new
 * row.
 */
import type {
  InboxSidebarModel,
  InboxSidebarRow,
  InboxSidebarSection,
  InboxSidebarSectionKey,
  InboxSidebarStatusFilter,
} from "./inboxSidebarModel";

/** The order the inbox showed when a hold began. */
export interface InboxOrderSnapshot {
  /** The filters and settings it was captured under; changing them starts a new hold. */
  readonly holdKey: string;
  readonly sections: ReadonlyArray<{
    readonly key: InboxSidebarSectionKey;
    readonly title: InboxSidebarSection["title"];
    readonly rowKeys: ReadonlyArray<string>;
  }>;
  /** Each host's delegated children, in order. */
  readonly childKeysByHostKey: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Each row's pin, settle and snooze state when the hold began. */
  readonly lifecycleByKey: ReadonlyMap<string, string>;
}

/** `buildInboxSidebarModel`'s section order, for a section the hold did not show. */
const SECTION_RANK: Readonly<Record<InboxSidebarSectionKey, number>> = {
  pinned: 0,
  focus: 1,
  active: 2,
  "needs-input": 3,
  recent: 4,
  snoozed: 5,
  settled: 6,
};

function lifecycleSignature(row: InboxSidebarRow): string {
  return `${row.pinned}|${row.settled}|${row.snoozedUntil ?? ""}`;
}

function sameItems(left: ReadonlyArray<object>, right: ReadonlyArray<object>): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function captureInboxOrder(model: InboxSidebarModel, holdKey: string): InboxOrderSnapshot {
  const childKeysByHostKey = new Map<string, ReadonlyArray<string>>();
  const lifecycleByKey = new Map<string, string>();
  for (const section of model.sections) {
    for (const row of section.rows) {
      lifecycleByKey.set(row.key, lifecycleSignature(row));
      if (row.delegatedChildren.length === 0) continue;
      childKeysByHostKey.set(
        row.key,
        row.delegatedChildren.map((child) => child.key),
      );
      for (const child of row.delegatedChildren) {
        lifecycleByKey.set(child.key, lifecycleSignature(child));
      }
    }
  }
  return {
    holdKey,
    sections: model.sections.map((section) => ({
      key: section.key,
      title: section.title,
      rowKeys: section.rows.map((row) => row.key),
    })),
    childKeysByHostKey,
    lifecycleByKey,
  };
}

/**
 * The live model in the snapshot's order. A held row stays in its held section
 * at its held place; every other row (new, unfolded from a host, with a
 * changed lifecycle, or entering the section `status` shows from one it hides)
 * goes to its live section at its live index. A host's delegated children are
 * held the same way. Returns `live` itself when the hold changes nothing.
 */
export function applyInboxOrderHold(
  live: InboxSidebarModel,
  snapshot: InboxOrderSnapshot,
  status: InboxSidebarStatusFilter,
): InboxSidebarModel {
  const liveRowByKey = new Map<string, InboxSidebarRow>();
  const liveSectionByKey = new Map<string, InboxSidebarSectionKey>();
  for (const section of live.sections) {
    for (const row of section.rows) {
      liveRowByKey.set(row.key, row);
      liveSectionByKey.set(row.key, section.key);
    }
  }
  const placed = new Map<
    InboxSidebarSectionKey,
    { title: InboxSidebarSection["title"]; rows: InboxSidebarRow[] }
  >();
  const heldKeys = new Set<string>();
  for (const section of snapshot.sections) {
    // Held in a section the filter hides, a row entering the shown one would
    // not show at all. One that leaves the shown section keeps its place.
    const rows = heldRows(snapshot, section.rowKeys, liveRowByKey).filter(
      (row) => section.key === status || liveSectionByKey.get(row.key) !== status,
    );
    for (const row of rows) heldKeys.add(row.key);
    placed.set(section.key, { title: section.title, rows });
  }
  for (const section of live.sections) {
    const rows = placed.get(section.key)?.rows ?? [];
    placed.set(section.key, { title: section.title, rows });
    insertAtLiveIndex(rows, section.rows, heldKeys);
  }

  const sections = [...placed]
    .filter(([, section]) => section.rows.length > 0)
    .toSorted(([left], [right]) => SECTION_RANK[left] - SECTION_RANK[right])
    .map(([key, { title, rows }]): InboxSidebarSection => {
      const shown = rows.map((row) => holdDelegatedChildren(snapshot, row));
      const liveSection = live.sections.find((section) => section.key === key);
      return liveSection !== undefined && sameItems(liveSection.rows, shown)
        ? liveSection
        : { key, title, rows: shown };
    });
  return sameItems(sections, live.sections) ? live : { ...live, sections };
}

/** The live rows of `keys`, in that order, whose lifecycle did not change. */
function heldRows(
  snapshot: InboxOrderSnapshot,
  keys: ReadonlyArray<string>,
  liveRowByKey: ReadonlyMap<string, InboxSidebarRow>,
): InboxSidebarRow[] {
  return keys.flatMap((key) => {
    const row = liveRowByKey.get(key);
    return row !== undefined && snapshot.lifecycleByKey.get(key) === lifecycleSignature(row)
      ? [row]
      : [];
  });
}

function holdDelegatedChildren(
  snapshot: InboxOrderSnapshot,
  row: InboxSidebarRow,
): InboxSidebarRow {
  const childKeys = snapshot.childKeysByHostKey.get(row.key);
  if (childKeys === undefined || row.delegatedChildren.length === 0) return row;
  const children = heldRows(
    snapshot,
    childKeys,
    new Map(row.delegatedChildren.map((child) => [child.key, child])),
  );
  insertAtLiveIndex(children, row.delegatedChildren, new Set(children.map((child) => child.key)));
  return sameItems(children, row.delegatedChildren) ? row : { ...row, delegatedChildren: children };
}

/** Adds each live row the hold did not keep at its live index, clamped. */
function insertAtLiveIndex(
  rows: InboxSidebarRow[],
  liveRows: ReadonlyArray<InboxSidebarRow>,
  heldKeys: ReadonlySet<string>,
): void {
  liveRows.forEach((row, index) => {
    if (!heldKeys.has(row.key)) rows.splice(Math.min(index, rows.length), 0, row);
  });
}
