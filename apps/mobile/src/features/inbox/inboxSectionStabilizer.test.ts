import { describe, expect, it } from "vite-plus/test";

import type { InboxSection, InboxThreadRow } from "./inboxModel";
import { createInboxSectionStabilizer, stabilizeInboxSections } from "./inboxModel";
import {
  buildInboxRowMenuActions,
  resolveSnoozeMenuPresets,
  snoozeMenuPresetsFromKey,
  snoozeMenuPresetsKey,
} from "./inboxRowActions";

function row(key: string, overrides: Partial<InboxThreadRow> = {}): InboxThreadRow {
  return {
    key,
    environmentId: "node",
    threadId: key,
    title: `Task ${key}`,
    nodeLabel: "Node",
    projectLabel: "Project",
    project: null,
    isChat: false,
    isWorktree: false,
    worktreeLabel: "main",
    contextLabel: "Node · Project · main",
    state: "idle",
    statusLabel: "Idle",
    updatedAt: "2026-10-12T09:00:00.000Z",
    changeRequest: { kind: "pull-request", label: "#1", tone: "open", accessibilityLabel: "PR" },
    roleLabel: null,
    providerDriver: null,
    providerLabel: null,
    focus: { source: "pin", ranking: null },
    focusTitle: null,
    focusDetail: null,
    focusAiGenerated: false,
    attentionState: "active",
    canSettle: true,
    settlementBlocker: null,
    mutationEnabled: true,
    mutationBlocker: null,
    ...overrides,
  } as InboxThreadRow;
}

function active(rows: ReadonlyArray<InboxThreadRow>): InboxSection {
  return { key: "active", title: "Active", rows };
}

describe("inbox row identity across rebuilds", () => {
  it("keeps every object when a rebuild produced identical content", () => {
    const previous = [active([row("a"), row("b")])];
    // A fresh build: equal content, all-new objects (badges and focus included).
    const next = [active([row("a"), row("b")])];
    expect(stabilizeInboxSections(previous, next)).toBe(previous);
  });

  it("replaces only the rows whose content changed", () => {
    const previous = [active([row("a"), row("b")])];
    const next = [active([row("a"), row("b", { state: "working", statusLabel: "Working" })])];
    const stable = stabilizeInboxSections(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable[0]!.rows[0]).toBe(previous[0]!.rows[0]);
    expect(stable[0]!.rows[1]).toBe(next[0]!.rows[1]);
  });

  it("reuses a row that moved between sections", () => {
    const moved = row("a");
    const previous = [active([moved, row("b")])];
    const next: InboxSection[] = [
      { key: "focus", title: "Focus", rows: [row("a")] },
      active([row("b")]),
    ];
    const stable = stabilizeInboxSections(previous, next);

    expect(stable[0]!.rows[0]).toBe(moved);
    expect(stable[1]!.rows[0]).toBe(previous[0]!.rows[1]);
    expect(stable[1]).not.toBe(previous[0]);
  });

  it("detects a change nested in a badge", () => {
    const previous = [active([row("a")])];
    const next = [
      active([
        row("a", {
          changeRequest: {
            kind: "pull-request",
            label: "#1",
            tone: "merged",
            accessibilityLabel: "PR",
          },
        }),
      ]),
    ];
    expect(stabilizeInboxSections(previous, next)[0]!.rows[0]).toBe(next[0]!.rows[0]);
  });

  it("remembers the previous result per stabilizer", () => {
    const stabilize = createInboxSectionStabilizer();
    const first = stabilize([active([row("a")])]);
    expect(stabilize([active([row("a")])])).toBe(first);
  });
});

describe("inbox row menu", () => {
  it("rebuilds an identical preset list from its key", () => {
    const presets = resolveSnoozeMenuPresets(new Date(2026, 9, 12, 9, 0));
    expect(snoozeMenuPresetsFromKey(snoozeMenuPresetsKey(presets))).toEqual(presets);
    expect(presets.map((preset) => preset.id)).toContain("evening");
    expect(
      resolveSnoozeMenuPresets(new Date(2026, 9, 12, 19, 0)).map((preset) => preset.id),
    ).not.toContain("evening");
  });

  it("lists settle first, then the snooze presets, gated by the row", () => {
    const presets = [{ id: "hour", label: "In 1 hour" }];
    expect(buildInboxRowMenuActions(row("a", { canSnooze: false }), presets)).toEqual([
      { id: "settle", title: "Settle task", attributes: { disabled: false } },
      { id: "hour", title: "In 1 hour", attributes: { disabled: true } },
    ]);
    expect(
      buildInboxRowMenuActions(
        row("a", {
          attentionState: "settled",
          snoozedUntil: "2026-10-13T09:00:00.000Z",
          canUnsnooze: true,
        }),
        presets,
      ),
    ).toEqual([
      { id: "unsettle", title: "Move to Active", attributes: { disabled: false } },
      { id: "unsnooze", title: "Unsnooze", attributes: { disabled: false } },
    ]);
  });
});
