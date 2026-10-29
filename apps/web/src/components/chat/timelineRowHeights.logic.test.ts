import {
  composeOutgoingPrompt,
  createBrowserElementReference,
  createFileReference,
} from "@ryco/client-runtime/state/composer";
import { MessageId, TurnId } from "@ryco/contracts";
import { htmlRenderFrameHeight } from "@ryco/shared/htmlRender";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  createTimelineRowHeightMemory,
  estimateMarkdownHeight,
  estimateTimelineRowHeight,
  isLiveTimelineRow,
  isRememberableTimelineRow,
  timelineRowHeightSignature,
  timelineRowLayoutKey,
  type TimelineRowLayout,
} from "./timelineRowHeights.logic";

const LAYOUT: TimelineRowLayout = {
  rowWidthPx: 768,
  remPx: 16,
  typographyKey: "sans|mono|16px",
  tier: "desktop",
};
const AT = "2026-10-01T00:00:00.000Z";
const TURN = TurnId.make("turn-1");

type Row<K extends MessagesTimelineRow["kind"]> = Extract<MessagesTimelineRow, { kind: K }>;

function message(
  role: "user" | "assistant",
  text: string,
  overrides: Partial<Row<"message">> = {},
  streaming = false,
): Row<"message"> {
  return {
    kind: "message",
    id: `${role}-row`,
    createdAt: AT,
    message: {
      id: MessageId.make(`${role}-1`),
      role,
      text,
      createdAt: AT,
      streaming,
      turnId: TURN,
    },
    durationStart: AT,
    showAssistantCopyButton: role === "assistant",
    ...overrides,
  };
}

function workEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "entry-1",
    createdAt: AT,
    label: "Ran command",
    tone: "tool",
    completed: true,
    ...overrides,
  };
}

function work(entries: WorkLogEntry[]): Row<"work"> {
  return { kind: "work", id: "work-row", createdAt: AT, groupedEntries: entries };
}

function chapter(overrides: Partial<Row<"chapter">> = {}): Row<"chapter"> {
  return {
    kind: "chapter",
    id: "chapter-row",
    createdAt: AT,
    turnId: TURN,
    message: {
      id: MessageId.make("chapter-message"),
      role: "assistant",
      text: "Looking into it.",
      createdAt: AT,
      streaming: false,
    },
    entries: [workEntry(), workEntry({ id: "entry-2" })],
    status: "done",
    expanded: false,
    stepsExpanded: false,
    isFirstInTurn: true,
    isLastInTurn: false,
    startedAt: AT,
    endedAt: AT,
    ...overrides,
  };
}

const htmlRender = { title: "Report", height: 480, heights: [[760, 900]] as const };

/** One row of every kind (exhaustive by construction: a new kind fails the type check). */
function everyKind(): Record<MessagesTimelineRow["kind"], MessagesTimelineRow> {
  return {
    message: message("assistant", "Hello there."),
    work: work([workEntry()]),
    "turn-fold": {
      kind: "turn-fold",
      id: "fold",
      createdAt: AT,
      turnId: TURN,
      foldId: "fold",
      status: "settled",
      durationStart: AT,
      label: "Worked for 3s",
      expanded: false,
    },
    "work-toggle": {
      kind: "work-toggle",
      id: "toggle",
      createdAt: AT,
      groupId: "group",
      hiddenCount: 4,
      expanded: false,
      onlyToolEntries: true,
      summary: null,
    },
    "proposed-plan": {
      kind: "proposed-plan",
      id: "plan",
      createdAt: AT,
      proposedPlan: {
        id: "plan-1" as never,
        turnId: TURN,
        planMarkdown: "# Plan\n\n- one\n- two",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: AT,
        updatedAt: AT,
      },
    },
    "context-compaction": {
      kind: "context-compaction",
      id: "compaction",
      createdAt: AT,
      marker: { id: "c", activityId: "a", createdAt: AT, label: "Context compacted", turnId: null },
    },
    "context-handoff": {
      kind: "context-handoff",
      id: "handoff",
      createdAt: AT,
      marker: {} as Row<"context-handoff">["marker"],
    },
    "fork-origin": {
      kind: "fork-origin",
      id: "fork",
      createdAt: AT,
      marker: {} as Row<"fork-origin">["marker"],
    },
    "user-input-exchange": {
      kind: "user-input-exchange",
      id: "exchange",
      createdAt: AT,
      exchange: {
        id: "exchange",
        activityId: "a",
        requestActivityId: "r",
        createdAt: AT,
        turnId: TURN,
        cancelled: false,
        questions: [
          {
            id: "q1",
            header: "Scope",
            question: "Which files should I touch?",
            options: ["Only the parser", "Everything"],
            answer: "Only the parser",
          },
        ],
      },
    },
    chapter: chapter(),
    "html-render": {
      kind: "html-render",
      id: "page",
      createdAt: AT,
      messageId: MessageId.make("page-message"),
      attachment: {
        type: "file",
        id: "page-file",
        name: "report.html",
        mimeType: "text/html",
        sizeBytes: 10,
      },
      htmlRender,
    },
    working: { kind: "working", id: "working", createdAt: AT },
  };
}

function paragraphs(count: number, words = 30): string {
  return Array.from({ length: count }, (_, index) =>
    Array.from({ length: words }, (_, word) => `word${(index + word) % 9}`).join(" "),
  ).join("\n\n");
}

describe("estimateTimelineRowHeight", () => {
  it("returns a finite integer height of at least 24 px for every row kind", () => {
    for (const [kind, row] of Object.entries(everyKind())) {
      for (const layout of [LAYOUT, { ...LAYOUT, tier: "phone" as const, rowWidthPx: 320 }]) {
        const height = estimateTimelineRowHeight(row, layout);
        expect(Number.isFinite(height), kind).toBe(true);
        expect(height, kind).toBeGreaterThanOrEqual(24);
        expect(height, kind).toBeLessThanOrEqual(1_000_000);
        expect(Number.isInteger(height), kind).toBe(true);
      }
    }
  });

  it("grows with the text", () => {
    let previous = 0;
    for (const count of [1, 2, 4, 8, 16]) {
      const height = estimateTimelineRowHeight(message("assistant", paragraphs(count)), LAYOUT);
      expect(height).toBeGreaterThan(previous);
      previous = height;
    }
  });

  it("sizes a fenced block by its lines", () => {
    const code = Array.from({ length: 40 }, (_, line) => `const x${line} = ${line};`).join("\n");
    const height = estimateMarkdownHeight(`\`\`\`ts\n${code}\n\`\`\``, 760, 16);
    // 40 lines of 0.75rem x 1.375, 0.8rem padding top and bottom, 1px borders.
    expect(height).toBeCloseTo(40 * 12 * 1.375 + 1.6 * 16 + 2, 0);
  });

  it("adds the terminal insert button only to shell blocks when asked", () => {
    const shell = "```bash\nbun run test\n```";
    const plain = estimateMarkdownHeight(shell, 760, 16);
    expect(estimateMarkdownHeight(shell, 760, 16, { terminalInsertion: true })).toBeGreaterThan(
      plain,
    );
    const ts = "```ts\nconst a = 1;\n```";
    expect(estimateMarkdownHeight(ts, 760, 16, { terminalInsertion: true })).toBe(
      estimateMarkdownHeight(ts, 760, 16),
    );
  });

  it("lays the same text out taller in a user bubble than in a reply", () => {
    const text = paragraphs(1, 120);
    expect(estimateTimelineRowHeight(message("user", text), LAYOUT)).toBeGreaterThan(
      estimateTimelineRowHeight(message("assistant", text), LAYOUT),
    );
  });

  it("scales prose with the root font size", () => {
    const text = paragraphs(6);
    const at16 = estimateMarkdownHeight(text, 760, 16);
    const at20 = estimateMarkdownHeight(text, 760 * 1.25, 20);
    expect(at20 / at16).toBeCloseTo(1.25, 1);
  });

  it("counts lists, headings, quotes and tables", () => {
    const prose = estimateMarkdownHeight("Intro line.", 760, 16);
    expect(estimateMarkdownHeight("Intro line.\n\n## Heading\n\nBody.", 760, 16)).toBeGreaterThan(
      estimateMarkdownHeight("Intro line.\n\nBody.", 760, 16),
    );
    const list = estimateMarkdownHeight("- one\n- two\n- three", 760, 16);
    expect(list).toBeGreaterThan(3 * prose);
    const loose = estimateMarkdownHeight("- one\n\n- two\n\n- three", 760, 16);
    expect(loose).toBeGreaterThan(list);
    const table = estimateMarkdownHeight("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |", 760, 16);
    expect(table).toBeGreaterThan(3 * prose);
    expect(estimateMarkdownHeight("> quoted words", 760, 16)).toBeGreaterThan(0);
  });

  it("sizes tables with or without their outer pipes alike", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `row ${index} | value ${index}`);
    const piped = ["| Name | Value |", "| --- | --- |", ...rows.map((row) => `| ${row} |`)].join(
      "\n",
    );
    const bare = ["Name | Value", "--- | ---", ...rows].join("\n");
    const leadingOnly = ["| Name | Value", "| --- | ---", ...rows.map((row) => `| ${row}`)].join(
      "\n",
    );
    const pipedHeight = estimateMarkdownHeight(piped, 760, 16);
    // 30 padded rows, not a two-line paragraph.
    expect(pipedHeight).toBeGreaterThan(30 * 22);
    expect(estimateMarkdownHeight(bare, 760, 16)).toBeCloseTo(pipedHeight, -1);
    expect(estimateMarkdownHeight(leadingOnly, 760, 16)).toBeCloseTo(pipedHeight, -1);
    // A pipe in prose without a delimiter row below is not a table.
    expect(estimateMarkdownHeight("use a | b to pipe", 760, 16)).toBe(
      estimateMarkdownHeight("use a or b to pipe", 760, 16),
    );
  });

  it("returns quickly and finite for a 1 MB message (bounded sample)", () => {
    const huge = `${"lorem ipsum dolor sit amet ".repeat(40_000)}`;
    const started = performance.now();
    const height = estimateTimelineRowHeight(message("assistant", huge), LAYOUT);
    expect(performance.now() - started).toBeLessThan(50);
    // About 10,000 wrapped lines: far taller than any fixed cap would allow, and finite.
    expect(height).toBeGreaterThan(150_000);
    expect(height).toBeLessThan(400_000);
    const code = `\`\`\`\n${"x\n".repeat(400_000)}\`\`\``;
    expect(Number.isFinite(estimateTimelineRowHeight(message("user", code), LAYOUT))).toBe(true);
  });

  it("estimates a user message from its displayed text, not its context blocks", () => {
    const context = Array.from({ length: 200 }, (_, line) => `line ${line} of output`).join("\n");
    const withContext = `Why does this fail?\n\n<terminal_context>\n- Terminal 1 lines 1-200:\n${context
      .split("\n")
      .map((line, index) => `  ${index + 1} | ${line}`)
      .join("\n")}\n</terminal_context>`;
    const plain = estimateTimelineRowHeight(message("user", "Why does this fail?"), LAYOUT);
    const height = estimateTimelineRowHeight(message("user", withContext), LAYOUT);
    expect(height).toBeLessThan(plain + 60);
  });

  it("gives picked page elements the chip row file lines get", () => {
    const element = createBrowserElementReference({
      url: "http://localhost:3000/settings",
      pageTitle: "Settings",
      selector: "#save",
      tagName: "button",
      role: "button",
      name: "Save changes",
      text: "Save changes",
      box: { x: 10, y: 20, width: 120, height: 32 },
    })!;
    const file = createFileReference({
      path: "src/app.ts",
      lineStart: 3,
      lineEnd: 3,
      lines: ["const a = 1;"],
    })!;
    const height = (
      fileReferences: Parameters<typeof composeOutgoingPrompt>[0]["fileReferences"],
    ) =>
      estimateTimelineRowHeight(
        message("user", composeOutgoingPrompt({ prompt: "Restyle this", fileReferences })),
        LAYOUT,
      );
    const plain = height([]);
    const chipRow = (1.5 + 0.25) * LAYOUT.remPx;
    expect(height([file])).toBe(plain + chipRow);
    expect(height([element])).toBe(plain + chipRow);
    expect(height([element, file])).toBe(plain + chipRow);
    // The frozen phone tier keeps page elements as text, not chips.
    const phone = { ...LAYOUT, tier: "phone" as const };
    const sent = composeOutgoingPrompt({ prompt: "Restyle this", fileReferences: [element] });
    expect(estimateTimelineRowHeight(message("user", sent), phone)).toBeGreaterThan(
      estimateTimelineRowHeight(message("user", "Restyle this"), phone) + chipRow,
    );
  });

  it("sizes a page row from its measured frame height", () => {
    const row = everyKind()["html-render"];
    const frame = htmlRenderFrameHeight(htmlRender, LAYOUT.rowWidthPx - 8);
    // `pb-2` under the frame.
    expect(estimateTimelineRowHeight(row, LAYOUT)).toBe(Math.round(frame + 8));
  });

  it("sizes a folded chapter as one line and an open one by its content", () => {
    const folded = estimateTimelineRowHeight(chapter(), LAYOUT);
    expect(folded).toBeLessThan(40);
    expect(estimateTimelineRowHeight(chapter({ expanded: true }), LAYOUT)).toBeGreaterThan(
      folded + 2 * 30,
    );
  });
});

describe("timelineRowHeightSignature", () => {
  it("is equal for structurally equal rows and memoized per row", () => {
    const row = message("assistant", "Same text.");
    expect(timelineRowHeightSignature(row)).toBe(
      timelineRowHeightSignature(message("assistant", "Same text.")),
    );
    expect(timelineRowHeightSignature(row)).toBe(timelineRowHeightSignature(row));
  });

  it("changes with what the height depends on", () => {
    const base = timelineRowHeightSignature(message("assistant", "Some text."));
    expect(timelineRowHeightSignature(message("assistant", "Some longer text."))).not.toBe(base);
    expect(timelineRowHeightSignature(message("assistant", "Some text.", {}, true))).not.toBe(base);
    expect(
      timelineRowHeightSignature(
        message("assistant", "Some text.", { showAssistantCopyButton: false }),
      ),
    ).not.toBe(base);
    const folded = chapter();
    expect(timelineRowHeightSignature({ ...folded, expanded: true })).not.toBe(
      timelineRowHeightSignature(folded),
    );
    expect(timelineRowHeightSignature({ ...folded, status: "active" })).not.toBe(
      timelineRowHeightSignature(folded),
    );
    const fold = everyKind()["turn-fold"] as Row<"turn-fold">;
    expect(timelineRowHeightSignature({ ...fold, expanded: true })).not.toBe(
      timelineRowHeightSignature(fold),
    );
  });
});

describe("isLiveTimelineRow / isRememberableTimelineRow", () => {
  it("treats streaming, running and working rows as live", () => {
    const kinds = everyKind();
    expect(isLiveTimelineRow(kinds.working)).toBe(true);
    expect(isLiveTimelineRow(message("assistant", "…", {}, true))).toBe(true);
    expect(isLiveTimelineRow(chapter({ status: "active" }))).toBe(true);
    expect(
      isLiveTimelineRow({ ...(kinds["turn-fold"] as Row<"turn-fold">), status: "running" }),
    ).toBe(true);
    expect(isLiveTimelineRow(work([workEntry(), workEntry({ id: "b", completed: false })]))).toBe(
      true,
    );
    for (const kind of [
      "message",
      "work",
      "turn-fold",
      "work-toggle",
      "proposed-plan",
      "chapter",
      "html-render",
      "context-compaction",
      "user-input-exchange",
    ] as const) {
      expect(isLiveTimelineRow(kinds[kind]), kind).toBe(false);
    }
  });

  it("never remembers rows whose expansion resets on remount", () => {
    const plan = everyKind()["proposed-plan"] as Row<"proposed-plan">;
    expect(isRememberableTimelineRow(plan)).toBe(true);
    const longPlan = {
      ...plan,
      proposedPlan: { ...plan.proposedPlan, planMarkdown: "- step\n".repeat(30) },
    };
    expect(isRememberableTimelineRow(longPlan)).toBe(false);
    const files = Array.from({ length: 7 }, (_, index) => ({ path: `src/f${index}.ts` }));
    const manyFiles = message("assistant", "Done.", {
      assistantTurnDiffSummary: { turnId: TURN, completedAt: AT, files },
    });
    expect(isRememberableTimelineRow(manyFiles)).toBe(false);
    expect(isRememberableTimelineRow(message("assistant", "…", {}, true))).toBe(false);
  });
});

describe("createTimelineRowHeightMemory", () => {
  it("round-trips a height under the same signature only", () => {
    const memory = createTimelineRowHeightMemory();
    const bucket = memory.openBucket("thread", timelineRowLayoutKey(LAYOUT));
    memory.remember(bucket, "row", 123, "sig-a");
    expect(memory.read(bucket, "row", "sig-a")).toBe(123);
    expect(memory.read(bucket, "row", "sig-b")).toBeUndefined();
    expect(memory.read(bucket, "other", "sig-a")).toBeUndefined();
    expect(memory.stats()).toMatchObject({ rows: 1, writes: 1, hits: 1, misses: 2 });
    // Another layout of the same thread is another bucket.
    const wider = memory.openBucket("thread", timelineRowLayoutKey({ ...LAYOUT, rowWidthPx: 900 }));
    expect(memory.read(wider, "row", "sig-a")).toBeUndefined();
    expect(memory.openBucket("thread", timelineRowLayoutKey(LAYOUT))).toBe(bucket);
  });

  it("ignores heights that are not positive, finite and plausible", () => {
    const memory = createTimelineRowHeightMemory();
    const bucket = memory.openBucket("thread", "layout");
    for (const height of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000]) {
      memory.remember(bucket, "row", height, "sig");
    }
    expect(memory.read(bucket, "row", "sig")).toBeUndefined();
    expect(memory.stats()).toMatchObject({ writes: 0, buckets: 0 });
    // A long code dump measures past 20,000 px; what it measured is still the best layout.
    memory.remember(bucket, "row", 25_000, "sig");
    expect(memory.read(bucket, "row", "sig")).toBe(25_000);
  });

  it("stores a bucket only once a row is remembered in it", () => {
    const memory = createTimelineRowHeightMemory({ maxBuckets: 2 });
    memory.remember(memory.openBucket("kept", "layout"), "row", 10, "sig");
    // Widths a resize passes through open buckets that never store a row.
    for (let width = 500; width < 600; width += 1) memory.openBucket("resized", `${width}`);
    expect(memory.stats().buckets).toBe(1);
    expect(memory.read(memory.openBucket("kept", "layout"), "row", "sig")).toBe(10);
  });

  it("writes into the bucket another timeline opened after the caller's was evicted", () => {
    const memory = createTimelineRowHeightMemory({ maxBuckets: 1 });
    const stale = memory.remember(memory.openBucket("thread", "layout"), "a", 10, "sig");
    // Another thread evicts it; a second pane then opens the thread again and fills it.
    memory.remember(memory.openBucket("other", "layout"), "x", 10, "sig");
    const fresh = memory.remember(memory.openBucket("thread", "layout"), "b", 20, "sig");
    expect(fresh).not.toBe(stale);
    // The first pane still holds the evicted bucket: its write lands in the live one.
    expect(memory.remember(stale, "c", 30, "sig")).toBe(fresh);
    const live = memory.openBucket("thread", "layout");
    expect(live).toBe(fresh);
    expect(memory.read(live, "b", "sig")).toBe(20);
    expect(memory.read(live, "c", "sig")).toBe(30);
  });

  it("counts rewrites only for changed heights or signatures", () => {
    const memory = createTimelineRowHeightMemory();
    const bucket = memory.openBucket("thread", "layout");
    memory.remember(bucket, "row", 100, "sig");
    memory.remember(bucket, "row", 100, "sig");
    expect(memory.stats().rewrites).toBe(0);
    memory.remember(bucket, "row", 101, "sig");
    memory.remember(bucket, "row", 101, "sig-2");
    expect(memory.stats()).toMatchObject({ writes: 4, rewrites: 2, rows: 1 });
  });

  it("drops a bucket's least recently used rows past its cap", () => {
    const memory = createTimelineRowHeightMemory({ maxRowsPerBucket: 3 });
    const bucket = memory.openBucket("thread", "layout");
    for (const id of ["a", "b", "c"]) memory.remember(bucket, id, 50, "sig");
    // Reading "a" keeps it: "b" is now the least recently used.
    expect(memory.read(bucket, "a", "sig")).toBe(50);
    memory.remember(bucket, "d", 50, "sig");
    expect(memory.read(bucket, "b", "sig")).toBeUndefined();
    for (const id of ["a", "c", "d"]) expect(memory.read(bucket, id, "sig")).toBe(50);
    expect(memory.stats().rows).toBe(3);
  });

  it("evicts the least recently opened bucket past the row budget", () => {
    const memory = createTimelineRowHeightMemory({ maxRows: 4 });
    const first = memory.openBucket("one", "layout");
    memory.remember(first, "a", 10, "sig");
    memory.remember(first, "b", 10, "sig");
    const second = memory.openBucket("two", "layout");
    memory.remember(second, "a", 10, "sig");
    // Opening "one" again makes "two" the least recently used.
    expect(memory.openBucket("one", "layout")).toBe(first);
    const third = memory.openBucket("three", "layout");
    memory.remember(third, "a", 10, "sig");
    memory.remember(third, "b", 10, "sig");
    expect(memory.openBucket("two", "layout").rows.size).toBe(0);
    expect(memory.openBucket("one", "layout").rows.size).toBe(2);
  });

  it("keeps at most maxBuckets buckets", () => {
    const memory = createTimelineRowHeightMemory({ maxBuckets: 2 });
    for (const thread of ["a", "b", "c"]) {
      memory.remember(memory.openBucket(thread, "layout"), "row", 10, "sig");
    }
    expect(memory.stats().buckets).toBe(2);
    expect(memory.openBucket("a", "layout").rows.size).toBe(0);
  });

  it("clears everything", () => {
    const memory = createTimelineRowHeightMemory();
    memory.remember(memory.openBucket("a", "layout"), "row", 10, "sig");
    memory.noteCorrection();
    memory.clear();
    expect(memory.stats()).toEqual({
      buckets: 0,
      rows: 0,
      writes: 0,
      rewrites: 0,
      hits: 0,
      misses: 0,
      corrections: 0,
    });
  });
});
