import { describe, expect, it, vi } from "vite-plus/test";

import type { InboxThreadRow } from "../inbox/inboxModel";
import { chatSearchResult, inboxRowsOf, messageSearchResult } from "./threadSearchModel";

const ROW = {
  key: "env:thread",
  title: "Fix login redirect loop",
  projectLabel: "web",
  statusLabel: "Needs input",
  state: "needs-input",
} as InboxThreadRow;

describe("thread search results", () => {
  it("describes a matched chat by project and status", () => {
    const open = vi.fn();
    const result = chatSearchResult({ row: ROW, age: "3d", open });
    expect(result).toMatchObject({
      key: "env:thread",
      scope: "chats",
      icon: "exclamationmark.bubble",
      title: "Fix login redirect loop",
      detail: "web · Needs input",
      trailing: "3d",
      accessibilityLabel: "Fix login redirect loop, web · Needs input, 3d",
    });
    result.open();
    expect(open).toHaveBeenCalledOnce();
  });

  it("carries the matched message as the snippet", () => {
    const result = messageSearchResult({
      row: { ...ROW, state: "idle" } as InboxThreadRow,
      snippet: "the redirect URI must match exactly",
      age: "1w",
      open: () => undefined,
    });
    expect(result).toMatchObject({
      scope: "messages",
      icon: "text.bubble",
      detail: "web",
      snippet: "the redirect URI must match exactly",
      trailing: "1w",
    });
  });

  it("names the delegating chat on a delegated task", () => {
    const child = { ...ROW, parentTitle: "Plan billing page" } as InboxThreadRow;
    expect(chatSearchResult({ row: child, age: "1h", open: () => undefined }).detail).toBe(
      "web · from Plan billing page · Needs input",
    );
  });

  it("flattens sections in list order", () => {
    const a = { key: "a" } as InboxThreadRow;
    const b = { key: "b" } as InboxThreadRow;
    expect(
      inboxRowsOf([
        { key: "pinned", title: "Pinned", rows: [a] },
        { key: "active", title: "Active", rows: [b] },
      ]).map((row) => row.key),
    ).toEqual(["a", "b"]);
  });
});
