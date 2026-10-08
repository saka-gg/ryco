import type { TimelineEntry, WorkLogEntry } from "@ryco/client-runtime/state/session";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadTimelineRows,
  toggleFold,
  type ActivityFold,
  type TimelineEntryRow,
} from "./threadActivityFold";

const T0 = "2026-07-27T10:00:00.000Z";
const T12 = "2026-07-27T10:00:12.000Z";

function work(id: string, overrides: Partial<WorkLogEntry> = {}): TimelineEntry {
  return {
    kind: "work",
    id,
    createdAt: T0,
    entry: {
      id,
      createdAt: T0,
      label: "Tool call",
      tone: "tool",
      turnId: "turn-1",
      ...overrides,
    },
  } as unknown as TimelineEntry;
}

function message(
  id: string,
  overrides: Partial<{
    role: "user" | "assistant";
    text: string;
    turnId: string | null;
    streaming: boolean;
    attachments: ReadonlyArray<unknown>;
  }> = {},
): TimelineEntry {
  return {
    kind: "message",
    id,
    createdAt: T0,
    message: {
      id,
      role: "assistant",
      text: "Done.",
      turnId: "turn-1",
      streaming: false,
      createdAt: T0,
      ...overrides,
    },
  } as unknown as TimelineEntry;
}

function page(attachmentId: string) {
  return {
    type: "file",
    id: attachmentId,
    name: `${attachmentId}.html`,
    mimeType: "text/html",
    sizeBytes: 2048,
    htmlRender: { title: `Page ${attachmentId}`, height: 320 },
  };
}

/** The assistant message `ryco_html_render` publishes: a blank body and its pages. */
function render(id: string, ...attachmentIds: string[]): TimelineEntry {
  return message(id, { text: " ", attachments: attachmentIds.map(page) });
}

function build(
  entries: ReadonlyArray<TimelineEntry>,
  overrides: Partial<Parameters<typeof buildThreadTimelineRows>[0]> = {},
) {
  return buildThreadTimelineRows({
    entries,
    runningTurnId: null,
    expandedFoldIds: new Set(),
    now: T12,
    ...overrides,
  });
}

function folds(rows: ReturnType<typeof build>): ReadonlyArray<ActivityFold> {
  return rows.filter((row): row is ActivityFold => row.kind === "activity-fold");
}

describe("thread activity folds", () => {
  it("collapses consecutive work entries into one fold", () => {
    const rows = build([work("a"), work("b"), work("c")]);
    expect(rows).toHaveLength(1);
    expect(folds(rows)[0]?.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("splits a fold when a message interrupts the activity", () => {
    const rows = build([work("a"), message("m"), work("b")]);
    expect(rows.map((row) => row.kind)).toEqual(["activity-fold", "entry", "activity-fold"]);
    expect(folds(rows).map((fold) => fold.id)).toEqual(["fold:turn-1:a", "fold:turn-1:b"]);
  });

  it("never emits an empty fold", () => {
    expect(folds(build([message("m")]))).toHaveLength(0);
    expect(build([])).toEqual([]);
  });

  it("says Working… while the turn is running and measures to now", () => {
    const rows = build([work("a")], { runningTurnId: "turn-1" });
    expect(folds(rows)[0]?.status).toBe("running");
    expect(folds(rows)[0]?.label).toBe("Working…");
  });

  it("says how long a settled turn took", () => {
    const rows = build([work("a"), work("b", { createdAt: T12 })]);
    expect(folds(rows)[0]?.status).toBe("settled");
    expect(folds(rows)[0]?.label).toBe("Worked for 12s");
  });

  it("degrades to a bare Worked when timestamps are unusable", () => {
    const rows = build([work("a", { createdAt: "not-a-date" })]);
    expect(folds(rows)[0]?.label).toBe("Worked");
  });

  it("keeps the running fold open and settled folds closed by default", () => {
    expect(folds(build([work("a")], { runningTurnId: "turn-1" }))[0]?.expanded).toBe(true);
    expect(folds(build([work("a")]))[0]?.expanded).toBe(false);
  });

  it("promotes the tool's own title over the generic label", () => {
    const rows = build([work("a", { label: "Tool call", toolTitle: "Read file" })]);
    expect(folds(rows)[0]?.rows[0]?.heading).toBe("Read file");
    // ...and falls back to the label when there is no tool title.
    expect(folds(build([work("b")]))[0]?.rows[0]?.heading).toBe("Tool call");
  });

  it("surfaces the detail the old row threw away", () => {
    const rows = build([
      work("a", {
        detail: "src/App.tsx",
        command: "bun test\n--watch",
        output: "  2 passed  ",
        exitCode: 0,
        changedFiles: ["src/App.tsx"],
      }),
    ]);
    const row = folds(rows)[0]?.rows[0];
    expect(row?.detail).toBe("src/App.tsx");
    // Command preview is one line, whitespace-trimmed.
    expect(row?.command).toBe("bun test");
    expect(row?.output).toBe("2 passed");
    // Exit code 0 must survive — it is falsy but meaningful.
    expect(row?.exitCode).toBe(0);
    expect(row?.changedFiles).toEqual(["src/App.tsx"]);
  });

  it("skips blank lines when previewing a command", () => {
    expect(folds(build([work("a", { command: "\n\n  echo hi\nmore" })]))[0]?.rows[0]?.command).toBe(
      "echo hi",
    );
  });

  it("falls back to rawCommand when command is absent", () => {
    expect(folds(build([work("a", { rawCommand: "git status" })]))[0]?.rows[0]?.command).toBe(
      "git status",
    );
  });

  it("treats completed:false as still running and anything else as done", () => {
    expect(folds(build([work("a", { completed: false })]))[0]?.rows[0]?.completed).toBe(false);
    expect(folds(build([work("b", { completed: true })]))[0]?.rows[0]?.completed).toBe(true);
    // Absent means done — most settled entries never set it.
    expect(folds(build([work("c")]))[0]?.rows[0]?.completed).toBe(true);
  });
});

describe("thread feed HTML renders", () => {
  const ids = (rows: ReturnType<typeof build>) => rows.map((row) => row.id);
  const entryRow = (rows: ReturnType<typeof build>, id: string) =>
    rows.find((row): row is TimelineEntryRow => row.kind === "entry" && row.id === id);

  it("puts a reply the provider opened early below the turn's pages", () => {
    const rows = build([
      message("user", { role: "user", text: "Chart it", turnId: null }),
      message("reply", { text: "Bundle size by package." }),
      render("render", "a"),
    ]);
    expect(ids(rows)).toEqual(["user", "render", "reply"]);
  });

  it("drops a blank reply after a page, without splitting the activity around it", () => {
    const rows = build([
      message("user", { role: "user", text: "Chart it", turnId: null }),
      render("render", "a"),
      work("w1"),
      message("reply", { text: "" }),
      work("w2"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["entry", "entry", "activity-fold"]);
    expect(ids(rows).slice(0, 2)).toEqual(["user", "render"]);
    expect(folds(rows)[0]?.rows.map((row) => row.id)).toEqual(["w1", "w2"]);
  });

  it("keeps a blank reply that is still streaming, or that no page answered", () => {
    expect(
      ids(build([render("render", "a"), message("reply", { text: "", streaming: true })])),
    ).toEqual(["render", "reply"]);
    expect(ids(build([message("reply", { text: "" })]))).toEqual(["reply"]);
  });

  it("lists the turn's pages, in order, under its settled reply", () => {
    const rows = build([
      render("render-1", "a", "b"),
      render("render-2", "c"),
      message("reply", { text: "Here is the comparison." }),
    ]);
    expect(
      entryRow(rows, "reply")?.turnHtmlRenders?.map((entry) => [
        entry.messageId,
        entry.attachment.id,
        entry.htmlRender.title,
      ]),
    ).toEqual([
      ["render-1", "a", "Page a"],
      ["render-1", "b", "Page b"],
      ["render-2", "c", "Page c"],
    ]);
    // The pages themselves carry no list, and nor does a streaming reply.
    expect(entryRow(rows, "render-1")?.turnHtmlRenders).toBeUndefined();
    expect(
      entryRow(
        build([render("render", "a"), message("reply", { text: "Here", streaming: true })]),
        "reply",
      )?.turnHtmlRenders,
    ).toBeUndefined();
  });

  it("holds the list back until the turn ends, so it never lands on a message the turn moves past", () => {
    const user = message("user", { role: "user", text: "Chart it", turnId: null });
    // A finished message the agent wrote before publishing: while the turn
    // runs, it is the turn's latest reply until the next one starts.
    const early = message("early", { text: "Let me build a chart." });
    const published = [user, early, work("w1"), render("render", "a"), work("w2")];
    expect(entryRow(build(published, { runningTurnId: "turn-1" }), "early")?.turnHtmlRenders).toBe(
      undefined,
    );

    const replied = [...published, message("reply", { text: "Here it is." })];
    const running = build(replied, { runningTurnId: "turn-1" });
    expect(
      running.filter((row) => row.kind === "entry" && row.turnHtmlRenders !== undefined),
    ).toEqual([]);

    const settled = build(replied);
    expect(entryRow(settled, "reply")?.turnHtmlRenders).toHaveLength(1);
    expect(entryRow(settled, "early")?.turnHtmlRenders).toBeUndefined();
    // Another turn running leaves this turn's list where it is.
    expect(
      entryRow(build(replied, { runningTurnId: "turn-2" }), "reply")?.turnHtmlRenders,
    ).toHaveLength(1);
  });

  it("lists pages only under their own turn's reply", () => {
    const rows = build([
      render("render", "a"),
      message("reply", { text: "Here." }),
      message("user", { role: "user", text: "Thanks", turnId: null }),
      message("next", { text: "Anytime.", turnId: "turn-2" }),
    ]);
    expect(entryRow(rows, "reply")?.turnHtmlRenders).toHaveLength(1);
    expect(entryRow(rows, "next")?.turnHtmlRenders).toBeUndefined();
    expect(entryRow(rows, "user")?.turnHtmlRenders).toBeUndefined();
  });

  it("leaves a feed without pages exactly as it was", () => {
    const rows = build([message("user", { role: "user", turnId: null }), message("reply")]);
    expect(rows).toEqual([
      { kind: "entry", id: "user", entry: expect.anything() },
      { kind: "entry", id: "reply", entry: expect.anything() },
    ]);
  });
});

describe("toggleFold", () => {
  it("opens a collapsed fold", () => {
    const fold = folds(build([work("a")]))[0]!;
    const next = toggleFold(new Set(), fold);
    expect(folds(build([work("a")], { expandedFoldIds: next }))[0]?.expanded).toBe(true);
  });

  it("keeps a collapsed running fold collapsed across rebuilds", () => {
    // The bug this guards: a running fold defaults to open, so a plain
    // "expanded" set cannot represent "the user closed it" — it would spring
    // back open on the next timeline update.
    const running = folds(build([work("a")], { runningTurnId: "turn-1" }))[0]!;
    expect(running.expanded).toBe(true);

    const next = toggleFold(new Set(), running);
    const after = folds(build([work("a")], { runningTurnId: "turn-1", expandedFoldIds: next }))[0];
    expect(after?.expanded).toBe(false);
  });

  it("round-trips back to open", () => {
    const running = folds(build([work("a")], { runningTurnId: "turn-1" }))[0]!;
    const closed = toggleFold(new Set(), running);
    const reopened = toggleFold(
      closed,
      folds(build([work("a")], { runningTurnId: "turn-1", expandedFoldIds: closed }))[0]!,
    );
    expect(
      folds(build([work("a")], { runningTurnId: "turn-1", expandedFoldIds: reopened }))[0]
        ?.expanded,
    ).toBe(true);
  });
});
