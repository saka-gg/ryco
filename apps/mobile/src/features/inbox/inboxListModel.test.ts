import { describe, expect, it } from "vite-plus/test";

import type { InboxSection, InboxThreadRow } from "./inboxModel";
import {
  flattenInboxSections,
  inboxThreadAtPosition,
  MOBILE_SETTLED_PAGE_SIZE,
} from "./inboxListModel";

function rows(count: number, prefix = "row"): InboxThreadRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${index}`,
  })) as InboxThreadRow[];
}

describe("mobile Inbox list", () => {
  const sections: InboxSection[] = [
    { key: "active", title: "Active", rows: rows(3) },
    { key: "settled", title: "Settled", rows: rows(45) },
  ];

  it("starts with only the settled shelf header", () => {
    const flattened = flattenInboxSections({
      sections,
      settledOpen: false,
      settledVisibleCount: MOBILE_SETTLED_PAGE_SIZE,
    });
    expect(flattened.filter((item) => item.kind === "thread")).toHaveLength(3);
    expect(flattened.find((item) => item.key === "section:active")).toMatchObject({
      expanded: true,
      count: 3,
    });
    expect(flattened.find((item) => item.key === "section:settled")).toMatchObject({
      expanded: false,
      count: 45,
    });
  });

  it("pages settled rows by twenty in one flattened list", () => {
    const firstPage = flattenInboxSections({
      sections,
      settledOpen: true,
      settledVisibleCount: MOBILE_SETTLED_PAGE_SIZE,
    });
    expect(firstPage.filter((item) => item.kind === "thread")).toHaveLength(23);
    expect(firstPage.at(-1)).toMatchObject({ kind: "show-more", remaining: 25 });
  });
});

describe("inboxThreadAtPosition", () => {
  // In the order `buildInboxSections` lists them.
  const sections: InboxSection[] = [
    { key: "active", title: "Active", rows: rows(3, "active") },
    { key: "snoozed", title: "Snoozed", rows: rows(4, "snoozed") },
    { key: "settled", title: "Settled", rows: rows(30, "settled") },
  ];
  const keyAt = (items: ReturnType<typeof flattenInboxSections>, position: number) =>
    inboxThreadAtPosition(items, position)?.key ?? null;

  it("numbers the shown thread rows, skipping headers and collapsed shelves", () => {
    const items = flattenInboxSections({
      sections,
      settledOpen: false,
      snoozedOpen: false,
      settledVisibleCount: MOBILE_SETTLED_PAGE_SIZE,
    });
    expect([0, 1, 2].map((position) => keyAt(items, position))).toEqual([
      "active-0",
      "active-1",
      "active-2",
    ]);
    // Only three rows show; the collapsed snoozed and settled rows are not reachable.
    expect(keyAt(items, 3)).toBeNull();
  });

  it("follows expanded shelves and the settled rows loaded so far", () => {
    const items = flattenInboxSections({
      sections,
      settledOpen: true,
      snoozedOpen: true,
      settledVisibleCount: 2,
    });
    expect(keyAt(items, 3)).toBe("snoozed-0");
    expect(keyAt(items, 6)).toBe("snoozed-3");
    expect(keyAt(items, 8)).toBe("settled-1");
    // The show-more row is not a thread, and unloaded settled rows do not count.
    expect(keyAt(items, 9)).toBeNull();
  });

  it("returns nothing for a negative position or an empty list", () => {
    expect(inboxThreadAtPosition([], 0)).toBeNull();
    expect(
      inboxThreadAtPosition(
        flattenInboxSections({ sections, settledOpen: false, settledVisibleCount: 20 }),
        -1,
      ),
    ).toBeNull();
  });
});

describe("mobile Inbox Hidden shelf", () => {
  const sections: InboxSection[] = [
    { key: "active", title: "Active", rows: rows(1) },
    { key: "hidden", title: "Hidden", rows: rows(2) },
  ];

  it("starts collapsed and opens on request", () => {
    const closed = flattenInboxSections({
      sections,
      settledOpen: true,
      settledVisibleCount: MOBILE_SETTLED_PAGE_SIZE,
    });
    expect(closed.find((item) => item.key === "section:hidden")).toMatchObject({
      expanded: false,
      count: 2,
    });
    expect(closed.filter((item) => item.kind === "thread")).toHaveLength(1);
    const open = flattenInboxSections({
      sections,
      settledOpen: false,
      hiddenOpen: true,
      settledVisibleCount: MOBILE_SETTLED_PAGE_SIZE,
    });
    expect(open.filter((item) => item.kind === "thread")).toHaveLength(3);
  });
});
