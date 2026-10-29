import { describe, expect, it } from "vite-plus/test";

import type { InboxSection, InboxThreadRow } from "./inboxModel";
import { flattenInboxSections, MOBILE_SETTLED_PAGE_SIZE } from "./inboxListModel";

function rows(count: number): InboxThreadRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `row-${index}`,
  })) as InboxThreadRow[];
}

describe("mobile Inbox list", () => {
  const sections: InboxSection[] = [
    { key: "focus", title: "Focus", rows: rows(1) },
    { key: "active", title: "Active", rows: rows(2) },
    { key: "settled", title: "Settled", rows: rows(45) },
  ];

  it("starts with only the settled shelf header", () => {
    const flattened = flattenInboxSections({
      sections,
      settledOpen: false,
      settledVisibleCount: MOBILE_SETTLED_PAGE_SIZE,
    });
    expect(flattened.filter((item) => item.kind === "thread")).toHaveLength(3);
    expect(flattened.find((item) => item.key === "section:focus")).toMatchObject({
      expanded: true,
      count: 1,
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
