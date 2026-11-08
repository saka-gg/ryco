import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { ThreadLineage } from "@ryco/contracts/orchestration";
import { describe, expect, it } from "vite-plus/test";

import { nestDelegatedInboxRows, summarizeDelegatedGroup } from "./inboxDelegationModel";
import type { InboxSection, InboxThreadRow, InboxThreadState } from "./inboxModel";

const ENV = "env" as EnvironmentId;

function lineage(parent: string, root = parent): ThreadLineage {
  return {
    parentThreadId: parent as ThreadId,
    rootThreadId: root as ThreadId,
    relationship: "delegated",
  };
}

function row(
  id: string,
  state: InboxThreadState,
  extra: Partial<InboxThreadRow> = {},
): InboxThreadRow {
  return {
    key: `${ENV}:${id}`,
    environmentId: ENV,
    threadId: id as ThreadId,
    title: id,
    state,
    pinned: false,
    updatedAt: "2026-11-08T10:00:00.000Z",
    lineage: null,
    ...extra,
  } as InboxThreadRow;
}

const keysOf = (sections: ReadonlyArray<InboxSection>) =>
  sections.map((section) => [
    section.key,
    section.rows.map((r) => [r.threadId, (r.delegatedChildren ?? []).map((c) => c.threadId)]),
  ]);

describe("nestDelegatedInboxRows", () => {
  it("folds delegated children under their parent, newest first", () => {
    const sections: InboxSection[] = [
      {
        key: "active",
        title: "Active",
        rows: [
          row("parent", "idle"),
          row("a", "working", { lineage: lineage("parent"), updatedAt: "2026-11-08T09:00:00Z" }),
          row("b", "idle", { lineage: lineage("parent"), updatedAt: "2026-11-08T11:00:00Z" }),
        ],
      },
    ];
    expect(keysOf(nestDelegatedInboxRows(sections, new Map()))).toEqual([
      ["active", [["parent", ["b", "a"]]]],
    ]);
  });

  it("keeps a child that needs the person at the top level", () => {
    const sections: InboxSection[] = [
      {
        key: "active",
        title: "Active",
        rows: [row("parent", "working"), row("ask", "needs-input", { lineage: lineage("parent") })],
      },
    ];
    expect(keysOf(nestDelegatedInboxRows(sections, new Map()))).toEqual([
      [
        "active",
        [
          ["parent", []],
          ["ask", []],
        ],
      ],
    ]);
  });

  it("flattens grandchildren to the topmost visible host, across a hidden middle", () => {
    const sections: InboxSection[] = [
      {
        key: "active",
        title: "Active",
        rows: [
          row("root", "idle"),
          row("grandchild", "working", { lineage: lineage("mid", "root") }),
        ],
      },
    ];
    const lineageByKey = new Map([[`${ENV}:mid`, lineage("root")]]);
    expect(keysOf(nestDelegatedInboxRows(sections, lineageByKey))).toEqual([
      ["active", [["root", ["grandchild"]]]],
    ]);
  });

  it("returns the sections unchanged when nothing nests", () => {
    const sections: InboxSection[] = [{ key: "active", title: "Active", rows: [row("x", "idle")] }];
    expect(nestDelegatedInboxRows(sections, new Map())).toBe(sections);
  });
});

describe("summarizeDelegatedGroup", () => {
  it("counts what the children need and leaves out zeros", () => {
    expect(
      summarizeDelegatedGroup([row("a", "working"), row("b", "working"), row("c", "settled")]).text,
    ).toBe("3 delegated · 2 working · 1 done");
    expect(summarizeDelegatedGroup([row("a", "needs-input")]).text).toBe(
      "1 delegated · 1 needs you",
    );
  });
});
