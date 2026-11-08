import type { InboxSection, InboxThreadRow } from "../inbox/inboxModel";

// Chats, the first tab: the inbox's threads listed by what they need from the
// person, with status chips above the list. Pure, so the grouping and the
// chips' words and counts are testable without a renderer.

/** The status chips, in order. "By project" lists projects instead of threads. */
export const CHATS_FILTERS = ["all", "needs-you", "working", "done", "by-project"] as const;

export type ChatsFilter = (typeof CHATS_FILTERS)[number];

const CHATS_FILTER_LABELS: Readonly<Record<ChatsFilter, string>> = {
  all: "All",
  "needs-you": "Needs you",
  working: "Working",
  done: "Done",
  "by-project": "By project",
};

/** What an unsettled thread needs: an answer, time to work, or nothing right now. */
export type ChatsAttention = "needs-you" | "working" | "recent";

/**
 * An approval, question or plan waits on the person; so does a send whose
 * delivery is unknown, a failure, a usage limit, and a thread that woke from
 * its snooze unseen. Running work is Working; everything else is Recent.
 */
export function chatsAttentionOf(row: InboxThreadRow): ChatsAttention {
  switch (row.state) {
    case "needs-input":
    case "delivery-unknown":
    case "error":
    case "limited":
      return "needs-you";
    case "working":
    case "connecting":
      return "working";
    default:
      return row.woke === true ? "needs-you" : "recent";
  }
}

const ATTENTION_SECTIONS: ReadonlyArray<{
  readonly key: ChatsAttention;
  readonly title: "Needs you" | "Working" | "Recent";
}> = [
  { key: "needs-you", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "recent", title: "Recent" },
];

function sectionRows(
  sections: ReadonlyArray<InboxSection>,
  key: InboxSection["key"],
): ReadonlyArray<InboxThreadRow> {
  return sections.find((section) => section.key === key)?.rows ?? [];
}

/**
 * The sections Chats lists for a chip, from the inbox's sections
 * (`buildInboxSections`). All keeps Pinned first, splits Active by attention,
 * then Snoozed, Done (settled) and Hidden. Needs you and Working list one
 * section each, pinned rows first as they lead the inbox. Done lists the
 * settled threads. By project lists no threads.
 */
export function buildChatsSections(
  sections: ReadonlyArray<InboxSection>,
  filter: ChatsFilter,
): ReadonlyArray<InboxSection> {
  const pinned = sectionRows(sections, "pinned");
  const active = sectionRows(sections, "active");
  const settled = sectionRows(sections, "settled");
  const done: InboxSection | null =
    settled.length > 0 ? { key: "settled", title: "Done", rows: settled } : null;
  switch (filter) {
    case "by-project":
      return [];
    case "done":
      return done ? [done] : [];
    case "needs-you":
    case "working": {
      const rows = [...pinned, ...active].filter((row) => chatsAttentionOf(row) === filter);
      const title = filter === "needs-you" ? "Needs you" : "Working";
      return rows.length > 0 ? [{ key: filter, title, rows }] : [];
    }
    case "all": {
      const result: InboxSection[] = [];
      if (pinned.length > 0) result.push({ key: "pinned", title: "Pinned", rows: pinned });
      for (const { key, title } of ATTENTION_SECTIONS) {
        const rows = active.filter((row) => chatsAttentionOf(row) === key);
        if (rows.length > 0) result.push({ key, title, rows });
      }
      const snoozed = sectionRows(sections, "snoozed");
      if (snoozed.length > 0) result.push({ key: "snoozed", title: "Snoozed", rows: snoozed });
      if (done) result.push(done);
      const hidden = sectionRows(sections, "hidden");
      if (hidden.length > 0) result.push({ key: "hidden", title: "Hidden", rows: hidden });
      return result;
    }
  }
}

export interface ChatsFilterChip {
  readonly filter: ChatsFilter;
  readonly label: string;
  /** Shown beside the label; null when the chip carries no count. */
  readonly count: number | null;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
}

/**
 * The chips over the list. Needs you and Working count their threads (pinned
 * ones included) so the person sees at a glance what waits; a zero count is
 * left out rather than shown.
 */
export function buildChatsFilterChips(
  sections: ReadonlyArray<InboxSection>,
  selected: ChatsFilter,
): ReadonlyArray<ChatsFilterChip> {
  const unsettled = [...sectionRows(sections, "pinned"), ...sectionRows(sections, "active")];
  const counts: Partial<Record<ChatsFilter, number>> = {
    "needs-you": unsettled.filter((row) => chatsAttentionOf(row) === "needs-you").length,
    working: unsettled.filter((row) => chatsAttentionOf(row) === "working").length,
  };
  return CHATS_FILTERS.map((filter) => {
    const count = counts[filter];
    const shown = count !== undefined && count > 0 ? count : null;
    const label = CHATS_FILTER_LABELS[filter];
    return {
      filter,
      label,
      count: shown,
      selected: filter === selected,
      accessibilityLabel: shown === null ? label : `${label}, ${shown}`,
    };
  });
}

/** Which collapsible shelves start open: the Done chip shows its threads at once. */
export function chatsShelfStartsOpen(filter: ChatsFilter): { readonly settled: boolean } {
  return { settled: filter === "done" };
}
