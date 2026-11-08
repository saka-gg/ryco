import { describe, expect, it } from "vite-plus/test";

import type { InboxSection, InboxThreadRow, InboxThreadState } from "../inbox/inboxModel";
import {
  buildChatsFilterChips,
  buildChatsSections,
  chatsAttentionOf,
  chatsShelfStartsOpen,
} from "./chatsListModel";

function row(key: string, state: InboxThreadState, extra: Partial<InboxThreadRow> = {}) {
  return { key, state, ...extra } as InboxThreadRow;
}

const SECTIONS: InboxSection[] = [
  { key: "pinned", title: "Pinned", rows: [row("pin-working", "working", { pinned: true })] },
  {
    key: "active",
    title: "Active",
    rows: [
      row("approve", "needs-input"),
      row("running", "working"),
      row("idle", "idle"),
      row("woke", "idle", { woke: true }),
      row("failed", "error"),
    ],
  },
  { key: "snoozed", title: "Snoozed", rows: [row("later", "idle")] },
  { key: "settled", title: "Settled", rows: [row("old", "settled")] },
  { key: "hidden", title: "Hidden", rows: [row("gone", "idle")] },
];

const keys = (sections: ReadonlyArray<InboxSection>) =>
  sections.map((section) => [section.key, section.title, section.rows.map((r) => r.key)]);

describe("chatsAttentionOf", () => {
  it("puts requests, failures, limits, unknown delivery and woken threads on the person", () => {
    for (const state of ["needs-input", "delivery-unknown", "error", "limited"] as const) {
      expect(chatsAttentionOf(row("a", state))).toBe("needs-you");
    }
    expect(chatsAttentionOf(row("a", "idle", { woke: true }))).toBe("needs-you");
  });

  it("counts running and starting work as working, the rest as recent", () => {
    expect(chatsAttentionOf(row("a", "working"))).toBe("working");
    expect(chatsAttentionOf(row("a", "connecting"))).toBe("working");
    for (const state of ["idle", "offline", "reconnecting"] as const) {
      expect(chatsAttentionOf(row("a", state))).toBe("recent");
    }
  });
});

describe("buildChatsSections", () => {
  it("lists everything by attention under All, pins first and settled as Done", () => {
    expect(keys(buildChatsSections(SECTIONS, "all"))).toEqual([
      ["pinned", "Pinned", ["pin-working"]],
      ["needs-you", "Needs you", ["approve", "woke", "failed"]],
      ["working", "Working", ["running"]],
      ["recent", "Recent", ["idle"]],
      ["snoozed", "Snoozed", ["later"]],
      ["settled", "Done", ["old"]],
      ["hidden", "Hidden", ["gone"]],
    ]);
  });

  it("filters to one attention, pinned rows included first", () => {
    expect(keys(buildChatsSections(SECTIONS, "working"))).toEqual([
      ["working", "Working", ["pin-working", "running"]],
    ]);
    expect(keys(buildChatsSections(SECTIONS, "needs-you"))).toEqual([
      ["needs-you", "Needs you", ["approve", "woke", "failed"]],
    ]);
  });

  it("lists settled threads under Done, and nothing for By project", () => {
    expect(keys(buildChatsSections(SECTIONS, "done"))).toEqual([["settled", "Done", ["old"]]]);
    expect(buildChatsSections(SECTIONS, "by-project")).toEqual([]);
  });

  it("leaves out empty sections", () => {
    expect(buildChatsSections([], "all")).toEqual([]);
    expect(buildChatsSections([], "needs-you")).toEqual([]);
    expect(buildChatsSections([], "done")).toEqual([]);
  });
});

describe("buildChatsFilterChips", () => {
  it("counts what needs the person and what works, and marks the selected chip", () => {
    expect(
      buildChatsFilterChips(SECTIONS, "working").map((chip) => [
        chip.label,
        chip.count,
        chip.selected,
        chip.accessibilityLabel,
      ]),
    ).toEqual([
      ["All", null, false, "All"],
      ["Needs you", 3, false, "Needs you, 3"],
      ["Working", 2, true, "Working, 2"],
      ["Done", null, false, "Done"],
      ["By project", null, false, "By project"],
    ]);
  });

  it("hides a zero count", () => {
    const chips = buildChatsFilterChips([], "all");
    expect(chips.find((chip) => chip.filter === "needs-you")?.count).toBeNull();
  });
});

describe("chatsShelfStartsOpen", () => {
  it("opens the settled shelf only under Done", () => {
    expect(chatsShelfStartsOpen("done").settled).toBe(true);
    expect(chatsShelfStartsOpen("all").settled).toBe(false);
  });
});
