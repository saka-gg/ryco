import "../../index.css";

// The real timeline (real LegendList, real CSS and fonts): row height estimates against what
// rows measure, and the remembered heights a thread opened again lays out at.

import { EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts";
import { appendTerminalContextsToPrompt } from "@ryco/client-runtime/state/composer";
import {
  createQuoteCitation,
  expandQuoteCitations,
  formatQuoteCitationHref,
} from "@ryco/shared/quoteCitations";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type RefObject } from "react";
import { page } from "vite-plus/test/browser";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";
import { render, renderHook } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import type { deriveTimelineEntries } from "../../session-logic";
import {
  applyAppearancePreferencesToDocument,
  resetAppearancePreference,
  setAppearancePreference,
} from "../../themes/appearancePreferences";
import { useTierOverrideStore } from "../../tierOverrideStore";
import { useUiStateStore } from "../../uiStateStore";
import { MessagesTimeline } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  createTimelineRowHeightMemory,
  estimateTimelineRowHeight,
  timelineRowHeightMemory,
  timelineRowLayoutKey,
  type TimelineRowLayout,
} from "./timelineRowHeights.logic";
import { useTimelineRowHeightHints } from "./useTimelineRowHeightHints";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const ENVIRONMENT = EnvironmentId.make("environment-local");
const NO_TURN_DIFFS = new Map();
const NO_REVERT_COUNTS = new Map();
const noop = () => {};

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) await nextFrame();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the timeline keeps every row measured while a reader scrolls through long replies with code lists tables and quoted passages so nothing jumps under the pointer anymore".split(
    " ",
  );

function sentence(random: () => number, words: number): string {
  const parts: string[] = [];
  for (let index = 0; index < words; index += 1) {
    parts.push(WORDS[Math.floor(random() * WORDS.length)]!);
  }
  const text = parts.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function codeBlock(random: () => number, lines: number, language: string): string {
  const body = Array.from(
    { length: lines },
    (_, line) => `const v${line} = run(${Math.floor(random() * 100)}, "${sentence(random, 2)}");`,
  ).join("\n");
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

function replyText(random: () => number): string {
  const blocks: string[] = [];
  const tail = random();
  const paragraphs =
    tail < 0.6
      ? 1 + Math.floor(random() * 4)
      : tail < 0.9
        ? 5 + Math.floor(random() * 8)
        : 14 + Math.floor(random() * 12);
  for (let paragraph = 0; paragraph < paragraphs; paragraph += 1) {
    const roll = random();
    if (roll < 0.08) {
      blocks.push(`## ${sentence(random, 3 + Math.floor(random() * 5))}`);
    } else if (roll < 0.18) {
      blocks.push(
        Array.from(
          { length: 2 + Math.floor(random() * 5) },
          () => `- ${sentence(random, 4 + Math.floor(random() * 18))}`,
        ).join("\n"),
      );
    } else if (roll < 0.22) {
      blocks.push(
        Array.from(
          { length: 2 + Math.floor(random() * 3) },
          (_, item) => `${item + 1}. ${sentence(random, 5 + Math.floor(random() * 12))}`,
        ).join("\n"),
      );
    } else if (roll < 0.25) {
      blocks.push(`> ${sentence(random, 10 + Math.floor(random() * 25))}`);
    } else if (roll < 0.28) {
      const rows = Array.from(
        { length: 2 + Math.floor(random() * 4) },
        () => `| ${sentence(random, 2)} | ${sentence(random, 1 + Math.floor(random() * 6))} |`,
      );
      blocks.push(["| Name | Notes |", "| --- | --- |", ...rows].join("\n"));
    } else {
      blocks.push(sentence(random, 8 + Math.floor(random() * 50)));
    }
  }
  const codeBlocks = random() < 0.5 ? 0 : 1 + Math.floor(random() * 2);
  for (let block = 0; block < codeBlocks; block += 1) {
    const position = Math.floor(random() * (blocks.length + 1));
    blocks.splice(
      position,
      0,
      codeBlock(random, 3 + Math.floor(random() * 30), random() < 0.3 ? "bash" : "ts"),
    );
  }
  return blocks.join("\n\n");
}

function userText(random: () => number, turn: number): string {
  const lines = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
    sentence(random, 4 + Math.floor(random() * 20)),
  ).join("\n");
  switch (turn % 9) {
    case 3:
      // A long unbroken token wraps anywhere.
      return `${lines}\n${"x".repeat(120 + Math.floor(random() * 200))}`;
    case 5:
      return appendTerminalContextsToPrompt(lines, [
        {
          terminalId: "terminal-1",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 120,
          text: Array.from({ length: 120 }, (_, line) => `output line ${line}`).join("\n"),
        },
      ]);
    case 7: {
      const citation = createQuoteCitation({
        source: { environmentId: ENVIRONMENT, threadId: ThreadId.make("quoted-thread") },
        messageId: MessageId.make("quoted-message"),
        selector: {
          exact: "keeps every row measured",
          prefix: "the timeline ",
          suffix: " while",
          start: 13,
          end: 37,
        },
      });
      return expandQuoteCitations(
        `${lines} [keeps every row](${formatQuoteCitationHref(citation)}) — why?`,
      );
    }
    default:
      return lines;
  }
}

const IMAGE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#888"/></svg>',
)}`;

/**
 * Turns of a user message, 0-3 settled tool calls and a reply; every few turns a plan, a
 * compaction marker, an answered question, an image, a terminal context or a quote.
 */
function buildThread(name: string, seed: number, turns: number): TimelineEntries {
  const random = mulberry32(seed);
  const entries: TimelineEntries = [];
  let second = 0;
  const at = () => new Date(Date.UTC(2026, 9, 1, 0, 0, second++)).toISOString();
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = TurnId.make(`${name}-turn-${turn}`);
    const userAt = at();
    entries.push({
      id: `${name}-user-${turn}`,
      kind: "message",
      createdAt: userAt,
      message: {
        id: MessageId.make(`${name}-user-${turn}`),
        role: "user",
        text: userText(random, turn),
        turnId,
        createdAt: userAt,
        completedAt: userAt,
        streaming: false,
        ...(turn % 11 === 4
          ? {
              attachments: [
                {
                  type: "image" as const,
                  id: `${name}-image-${turn}`,
                  name: "screenshot.png",
                  mimeType: "image/svg+xml",
                  sizeBytes: 1000,
                  previewUrl: IMAGE_URL,
                  width: 640,
                  height: 400,
                },
              ],
            }
          : {}),
      },
    });
    const workRows = Math.floor(random() * 4);
    // Every fourth turn's tool calls carry no turn, so they stay plain work rows.
    const looseWork = turn % 4 === 1;
    for (let work = 0; work < workRows; work += 1) {
      const workAt = at();
      const id = `${name}-work-${turn}-${work}`;
      const roll = random();
      entries.push({
        id,
        kind: "work",
        createdAt: workAt,
        entry:
          roll < 0.2
            ? {
                id,
                createdAt: workAt,
                label: "Edited files",
                completed: true,
                tone: "tool",
                itemType: "file_change",
                changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
                ...(looseWork ? {} : { turnId }),
              }
            : {
                id,
                createdAt: workAt,
                label: roll < 0.3 ? "Note" : "Ran command",
                command: `bun run test -- ${sentence(random, 2)}`,
                completed: true,
                tone: roll < 0.3 ? "info" : "tool",
                itemType: "command_execution",
                ...(looseWork ? {} : { turnId }),
              },
      });
    }
    if (turn % 10 === 6) {
      const exchangeAt = at();
      entries.push({
        id: `${name}-exchange-${turn}`,
        kind: "user-input-exchange",
        createdAt: exchangeAt,
        exchange: {
          id: `${name}-exchange-${turn}`,
          activityId: `${name}-exchange-${turn}`,
          requestActivityId: `${name}-exchange-request-${turn}`,
          createdAt: exchangeAt,
          turnId,
          cancelled: false,
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: sentence(random, 12),
              options: ["Only the parser", "Parser and tests", "Everything"],
              answer: "Parser and tests",
            },
          ],
        },
        workEntries: [],
      });
    }
    const replyAt = at();
    entries.push({
      id: `${name}-assistant-${turn}`,
      kind: "message",
      createdAt: replyAt,
      message: {
        id: MessageId.make(`${name}-assistant-${turn}`),
        role: "assistant",
        text: replyText(random),
        turnId,
        createdAt: replyAt,
        completedAt: replyAt,
        streaming: false,
      },
    });
    if (turn % 12 === 8) {
      const planAt = at();
      entries.push({
        id: `${name}-plan-${turn}`,
        kind: "proposed-plan",
        createdAt: planAt,
        proposedPlan: {
          id: `${name}-plan-${turn}` as never,
          turnId,
          planMarkdown: `# Plan\n\n${Array.from(
            { length: 3 + Math.floor(random() * 4) },
            () => `- ${sentence(random, 6 + Math.floor(random() * 10))}`,
          ).join("\n")}`,
          implementedAt: null,
          implementationThreadId: null,
          createdAt: planAt,
          updatedAt: planAt,
        },
      });
    }
    if (turn % 15 === 10) {
      const markerAt = at();
      entries.push({
        id: `${name}-compaction-${turn}`,
        kind: "context-compaction",
        createdAt: markerAt,
        marker: {
          id: `${name}-compaction-${turn}`,
          activityId: `${name}-compaction-${turn}`,
          createdAt: markerAt,
          label: "Context compacted",
          turnId,
        },
      });
    }
  }
  return entries;
}

function Timeline(props: {
  readonly threadKey: string;
  readonly entries: TimelineEntries;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly width: number;
  readonly height: number;
}) {
  return (
    <div style={{ width: props.width, height: props.height }}>
      <MessagesTimeline
        // ChatView remounts the timeline per thread the same way.
        key={props.threadKey}
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnId={null}
        activeTurnStartedAt={null}
        listRef={props.listRef}
        timelineEntries={props.entries}
        turnDiffSummaryByAssistantMessageId={NO_TURN_DIFFS}
        routeThreadKey={props.threadKey}
        onOpenTurnDiff={noop}
        revertTurnCountByUserMessageId={NO_REVERT_COUNTS}
        onRevertUserMessage={noop}
        onUndoTurn={noop}
        isRevertingCheckpoint={false}
        onImageExpand={noop}
        activeThreadEnvironmentId={ENVIRONMENT}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
        onIsAtEndChange={noop}
      />
    </div>
  );
}

function scrollNodeOf(listRef: RefObject<LegendListRef | null>): HTMLElement {
  const node = listRef.current?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) throw new Error("no scroll node");
  return node;
}

/** The list's item container, whose opacity LegendList holds at 0 until it reveals. */
function itemContainer(node: HTMLElement): HTMLElement | null {
  const content = node.firstElementChild;
  if (!content) return null;
  return (
    Array.from(content.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.style.opacity !== "",
    ) ?? null
  );
}

function isRevealed(node: HTMLElement): boolean {
  const container = itemContainer(node);
  if (!container || container.style.opacity === "0") return false;
  const viewport = node.getBoundingClientRect();
  for (const row of node.querySelectorAll<HTMLElement>("[data-timeline-root]")) {
    const box = row.getBoundingClientRect();
    if (box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom) return true;
  }
  return false;
}

async function waitForReveal(listRef: RefObject<LegendListRef | null>): Promise<HTMLElement> {
  for (let frame = 0; frame < 600; frame += 1) {
    await nextFrame();
    const node = listRef.current?.getScrollableNode?.();
    if (node instanceof HTMLElement && isRevealed(node)) return node;
  }
  throw new Error("transcript never became visible");
}

/** Scrolls from the end to the top so every row renders and the list measures it. */
async function measureEveryRow(listRef: RefObject<LegendListRef | null>): Promise<void> {
  const node = scrollNodeOf(listRef);
  for (let step = 0; step < 400; step += 1) {
    if (node.scrollTop <= 0) break;
    node.scrollTop = Math.max(0, node.scrollTop - node.clientHeight * 0.8);
    await frames(3);
  }
  await frames(6);
}

function currentLayout(listRef: RefObject<LegendListRef | null>): TimelineRowLayout {
  const node = scrollNodeOf(listRef);
  const row = node.querySelector<HTMLElement>("[data-timeline-root]");
  if (!row) throw new Error("no rendered row");
  return {
    rowWidthPx: row.getBoundingClientRect().width,
    remPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    typographyKey: "",
    tier: "desktop",
  };
}

function rowsOf(listRef: RefObject<LegendListRef | null>): ReadonlyArray<MessagesTimelineRow> {
  return (listRef.current?.getState?.().data ?? []) as ReadonlyArray<MessagesTimelineRow>;
}

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
};

async function setRootFontSize(size: "16px" | "18px") {
  if (size === "16px") resetAppearancePreference("fontSizeBase");
  else setAppearancePreference("fontSizeBase", size);
  applyAppearancePreferencesToDocument();
  await frames(2);
}

let threadCounter = 0;
const uniqueKey = (name: string) => `environment-local:row-heights-${name}-${threadCounter++}`;

/** Frames a list needs to measure rows it just rendered and move the ones below. */
const SETTLE_FRAMES = 8;

/**
 * Each rendered row starts where the row before it in the data ends (within a pixel): no
 * overlap, no gap. Only neighbours in the data are compared; the list may still hold a row it
 * is about to drop.
 */
function expectRowsLaidOutWithoutOverlap(
  node: HTMLElement,
  listRef: RefObject<LegendListRef | null>,
) {
  const state = listRef.current!.getState();
  const rows = [...node.querySelectorAll<HTMLElement>("[data-timeline-row-id]")]
    .map((element) => ({
      index: state.indexByKey(element.dataset.timelineRowId!) ?? -1,
      box: element.closest<HTMLElement>("[data-timeline-root]")!.getBoundingClientRect(),
    }))
    .filter((row) => row.index >= 0 && row.box.height > 0)
    .toSorted((left, right) => left.index - right.index);
  let neighbours = 0;
  for (let position = 1; position < rows.length; position += 1) {
    const previous = rows[position - 1]!;
    const row = rows[position]!;
    if (row.index !== previous.index + 1) continue;
    neighbours += 1;
    expect(
      Math.abs(row.box.top - previous.box.bottom),
      `rows ${previous.index}/${row.index}`,
    ).toBeLessThanOrEqual(1);
  }
  expect(neighbours).toBeGreaterThan(0);
}

/** Opens a thread, lets it settle and returns its list. */
async function openThread(input: {
  readonly threadKey: string;
  readonly entries: TimelineEntries;
  readonly width?: number;
  readonly height?: number;
}) {
  const listRef = createRef<LegendListRef>();
  const props = {
    threadKey: input.threadKey,
    entries: input.entries,
    listRef,
    width: input.width ?? 760,
    height: input.height ?? 900,
  };
  const screen = await render(<Timeline {...props} />);
  const node = await waitForReveal(listRef);
  await document.fonts.ready;
  await frames(10);
  return { screen, listRef, node, props };
}

function streamingThread(name: string): TimelineEntries {
  const entries = buildThread(name, 3, 12);
  const last = entries.at(-1)!;
  if (last.kind !== "message") throw new Error("expected a reply last");
  return [...entries.slice(0, -1), { ...last, message: { ...last.message, streaming: true } }];
}

describe("MessagesTimeline row heights", () => {
  let stopTier: (() => void) | undefined;
  beforeAll(async () => {
    await page.viewport(1400, 1000);
    useTierOverrideStore.setState({ override: "desktop" });
    stopTier = syncDocumentPresentationTier();
  });
  afterAll(() => {
    stopTier?.();
    useTierOverrideStore.setState({ override: null });
  });
  beforeEach(() => {
    timelineRowHeightMemory.clear();
    useUiStateStore.setState({
      threadTurnFoldExpandedById: {},
      threadWorkGroupExpandedById: {},
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await setRootFontSize("16px");
  });

  it("estimates real rows closely at two widths and two font sizes", async () => {
    const entries = buildThread("calibration", 7, 40);
    const turnFolds = Object.fromEntries(
      entries.flatMap((entry) =>
        entry.kind === "message" && entry.message.role === "user" && entry.message.turnId
          ? [[`turn-fold:settled:${entry.message.turnId}`, true] as const]
          : [],
      ),
    );
    const report: Array<{
      readonly totalRatio: number;
      readonly medians: Record<string, { n: number; median: number }>;
    }> = [];
    for (const fontSize of ["16px", "18px"] as const) {
      await setRootFontSize(fontSize);
      for (const hostWidth of [560, 808]) {
        for (const openTurns of [false, true]) {
          const listRef = createRef<LegendListRef>();
          const threadKey = uniqueKey("calibration");
          if (openTurns) {
            useUiStateStore.setState({ threadTurnFoldExpandedById: { [threadKey]: turnFolds } });
          }
          const screen = await render(
            <Timeline
              threadKey={threadKey}
              entries={entries}
              listRef={listRef}
              width={hostWidth}
              height={1600}
            />,
          );
          try {
            const node = await waitForReveal(listRef);
            await document.fonts.ready;
            if (openTurns) {
              // Open every other chapter too.
              const chapters = rowsOf(listRef).filter((row) => row.kind === "chapter");
              useUiStateStore.setState({
                threadWorkGroupExpandedById: {
                  [threadKey]: Object.fromEntries(
                    chapters.filter((_, index) => index % 2 === 0).map((row) => [row.id, true]),
                  ),
                },
              });
              await frames(4);
            }
            await measureEveryRow(listRef);
            const layout = currentLayout(listRef);
            // The probe the hints read is exactly as wide as a rendered row.
            const probe = node.parentElement?.querySelector<HTMLElement>(
              "[data-timeline-row-column-probe]",
            );
            expect(probe?.getBoundingClientRect().width).toBeCloseTo(layout.rowWidthPx, 1);
            const sizes = listRef.current!.getState().sizes;
            const errorsByKind = new Map<string, number[]>();
            let estimated = 0;
            let measured = 0;
            const rows: Array<{ id: string; kind: string; estimate: number; measured: number }> =
              [];
            for (const row of rowsOf(listRef)) {
              const size = sizes.get(row.id);
              if (size === undefined) continue;
              const estimate = estimateTimelineRowHeight(row, layout);
              const kind = row.kind === "message" ? `message:${row.message.role}` : row.kind;
              errorsByKind.set(kind, [
                ...(errorsByKind.get(kind) ?? []),
                Math.abs(estimate - size) / size,
              ]);
              estimated += estimate;
              measured += size;
              rows.push({ id: row.id, kind, estimate, measured: size });
            }
            expect(rows.length).toBe(rowsOf(listRef).length);
            const summary = {
              fontSize,
              openTurns,
              rowWidth: Math.round(layout.rowWidthPx),
              rows: rows.length,
              totalRatio: Math.round((estimated / measured) * 1000) / 1000,
              medians: Object.fromEntries(
                [...errorsByKind].map(([kind, errors]) => [
                  kind,
                  { n: errors.length, median: Math.round(median(errors) * 1000) / 1000 },
                ]),
              ),
              worst: rows
                .toSorted(
                  (a, b) =>
                    Math.abs(b.estimate - b.measured) / b.measured -
                    Math.abs(a.estimate - a.measured) / a.measured,
                )
                .slice(0, 4),
            };
            report.push(summary);
            console.log("[row-heights-calibration]", JSON.stringify(summary));
          } finally {
            await screen.unmount();
          }
        }
      }
    }
    expect(report).toHaveLength(8);
    for (const summary of report) {
      expect(summary.totalRatio).toBeGreaterThan(0.9);
      expect(summary.totalRatio).toBeLessThan(1.1);
      for (const [kind, { median: error }] of Object.entries(summary.medians)) {
        expect(error, kind).toBeLessThanOrEqual(kind.startsWith("message:") ? 0.2 : 0.25);
      }
    }
  }, 180_000);

  it("has the whole scroll range when the transcript first shows", async () => {
    const entries = buildThread("range", 11, 60);
    const listRef = createRef<LegendListRef>();
    const screen = await render(
      <Timeline
        threadKey={uniqueKey("range")}
        entries={entries}
        listRef={listRef}
        width={760}
        height={900}
      />,
    );
    try {
      const node = await waitForReveal(listRef);
      const atReveal = node.scrollHeight;
      await document.fonts.ready;
      await measureEveryRow(listRef);
      node.scrollTop = node.scrollHeight;
      await frames(10);
      const settled = node.scrollHeight;
      // 56 px guesses gave about half the range here.
      expect(atReveal / settled).toBeGreaterThan(0.9);
      expect(atReveal / settled).toBeLessThan(1.1);
    } finally {
      await screen.unmount();
    }
  });

  it("lays a thread opened again out at the heights its rows measured", async () => {
    const warn = vi.spyOn(console, "warn");
    const threadA = uniqueKey("switch-a");
    const threadB = uniqueKey("switch-b");
    const entriesA = buildThread("switch-a", 21, 40);
    const entriesB = buildThread("switch-b", 22, 40);
    const first = await openThread({ threadKey: threadA, entries: entriesA });
    try {
      expectRowsLaidOutWithoutOverlap(first.node, first.listRef);
      await first.screen.rerender(
        <Timeline {...first.props} threadKey={threadB} entries={entriesB} />,
      );
      await waitForReveal(first.listRef);
      await frames(10);
      const beforeSwitchBack = timelineRowHeightMemory.stats();
      expect(beforeSwitchBack.writes).toBeGreaterThan(0);

      await first.screen.rerender(<Timeline {...first.props} />);
      const node = await waitForReveal(first.listRef);
      await frames(10);
      const after = timelineRowHeightMemory.stats();
      expect(after.hits).toBeGreaterThan(beforeSwitchBack.hits);
      // Every row that showed was laid out at exactly the height it measured: no report.
      expect(after.corrections).toBe(beforeSwitchBack.corrections);
      expect(after.rewrites).toBe(beforeSwitchBack.rewrites);
      expectRowsLaidOutWithoutOverlap(node, first.listRef);
      expect(itemContainer(node)?.style.opacity).not.toBe("0");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(isRevealed(node)).toBe(true);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes("transcript still blank")),
      ).toBe(false);
    } finally {
      await first.screen.unmount();
    }
  });

  it("never remembers a streaming row", async () => {
    const threadKey = uniqueKey("streaming");
    const entries = streamingThread("streaming");
    const view = await openThread({ threadKey, entries });
    try {
      const streaming = rowsOf(view.listRef).findLast(
        (row) => row.kind === "message" && row.message.streaming,
      );
      expect(streaming).toBeDefined();
      // Rendered and measured, but not kept.
      expect(view.listRef.current!.getState().sizes.has(streaming!.id)).toBe(true);
      const layout = currentLayout(view.listRef);
      const bucket = timelineRowHeightMemory.openBucket(
        threadKey,
        timelineRowLayoutKey({ ...layout, typographyKey: typographyKeyOfDocument() }),
      );
      expect(bucket.rows.has(streaming!.id)).toBe(false);
    } finally {
      await view.screen.unmount();
    }
  });

  it("keeps rows apart when the layout changes under a mounted transcript", async () => {
    const threadKey = uniqueKey("relayout");
    const view = await openThread({ threadKey, entries: buildThread("relayout", 41, 40) });
    try {
      // A font-size change re-keys the layout: new estimates for every unmeasured row.
      await setRootFontSize("18px");
      await frames(SETTLE_FRAMES);
      expectRowsLaidOutWithoutOverlap(view.node, view.listRef);
      for (let step = 0; step < 12; step += 1) {
        view.node.scrollTop = Math.max(0, view.node.scrollTop - 700);
        await frames(SETTLE_FRAMES);
        expectRowsLaidOutWithoutOverlap(view.node, view.listRef);
      }
      expect(isRevealed(view.node)).toBe(true);
    } finally {
      await view.screen.unmount();
    }
  });

  it("keeps rows apart in two panes showing one thread", async () => {
    const threadKey = uniqueKey("panes");
    const entries = buildThread("panes", 51, 40);
    const left = createRef<LegendListRef>();
    const right = createRef<LegendListRef>();
    const screen = await render(
      <div style={{ display: "flex", gap: 8 }}>
        <Timeline threadKey={threadKey} entries={entries} listRef={left} width={640} height={800} />
        <Timeline
          threadKey={threadKey}
          entries={entries}
          listRef={right}
          width={640}
          height={800}
        />
      </div>,
    );
    try {
      const leftNode = await waitForReveal(left);
      const rightNode = await waitForReveal(right);
      // Scrolling one pane measures rows into the bucket both panes read.
      for (let step = 0; step < 10; step += 1) {
        leftNode.scrollTop = Math.max(0, leftNode.scrollTop - 600);
        await frames(2);
        rightNode.scrollTop = Math.max(0, rightNode.scrollTop - 300);
        await frames(SETTLE_FRAMES);
        expectRowsLaidOutWithoutOverlap(leftNode, left);
        expectRowsLaidOutWithoutOverlap(rightNode, right);
      }
      expect(isRevealed(leftNode)).toBe(true);
      expect(isRevealed(rightNode)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });
});

function typographyKeyOfDocument(): string {
  const style = getComputedStyle(document.documentElement);
  return [
    style.getPropertyValue("--font-family-sans").trim(),
    style.getPropertyValue("--font-family-mono").trim(),
  ].join("|");
}

/** Longer than the hints wait for a resized column to hold its width. */
const afterResizeSettles = () => new Promise((resolve) => setTimeout(resolve, 250));

describe("useTimelineRowHeightHints", () => {
  const AT = "2026-10-01T00:00:00.000Z";
  function chapterRow(expanded: boolean): MessagesTimelineRow {
    return {
      kind: "chapter",
      id: "chapter:hint",
      createdAt: AT,
      turnId: TurnId.make("turn-hint"),
      message: {
        id: MessageId.make("chapter-hint-message"),
        role: "assistant",
        text: "Reading the parser and its tests before changing anything in it.",
        createdAt: AT,
        streaming: false,
      },
      entries: Array.from({ length: 4 }, (_, index) => ({
        id: `step-${index}`,
        createdAt: AT,
        label: "Ran command",
        tone: "tool" as const,
        completed: true,
      })),
      status: "done",
      expanded,
      stepsExpanded: false,
      isFirstInTurn: true,
      isLastInTurn: false,
      startedAt: AT,
      endedAt: AT,
    };
  }
  function messageRow(id: string): MessagesTimelineRow {
    return {
      kind: "message",
      id,
      createdAt: AT,
      message: {
        id: MessageId.make(id),
        role: "assistant",
        text: "Done.",
        createdAt: AT,
        streaming: false,
      },
      durationStart: AT,
      showAssistantCopyButton: true,
    };
  }

  function attachColumn(hints: { rowColumnRef: (element: HTMLElement | null) => void }) {
    const column = document.createElement("div");
    column.style.width = "600px";
    document.body.append(column);
    hints.rowColumnRef(column);
    return () => column.remove();
  }

  it("does not serve a height remembered under another fold state", async () => {
    const memory = createTimelineRowHeightMemory();
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints({
        listRef: { current: null },
        routeThreadKey: "hints-fold",
        memory,
      }),
    );
    const detach = attachColumn(result.current);
    onTestFinished(detach);
    const folded = chapterRow(false);
    const expanded = chapterRow(true);
    result.current.onItemSizeChanged({
      itemKey: folded.id,
      itemData: folded,
      size: 31.875,
      previous: 30,
      index: 0,
    });
    expect(result.current.getEstimatedItemSize(folded, 0, "chapter")).toBe(32);
    // Same row id, opened: its content estimate, not the folded line's height.
    const estimate = result.current.getEstimatedItemSize(expanded, 0, "chapter");
    expect(estimate).toBeGreaterThan(100);
    result.current.onItemSizeChanged({
      itemKey: expanded.id,
      itemData: expanded,
      size: 250.375,
      previous: estimate!,
      index: 0,
    });
    // A fresh row object (the next mount) of each state reads its own height.
    expect(result.current.getEstimatedItemSize(chapterRow(true), 0, "chapter")).toBe(250);
    expect(result.current.getEstimatedItemSize(chapterRow(false), 0, "chapter")).toBe(32);
  });

  it("remembers a reply once it stops streaming, never while it streams", async () => {
    const memory = createTimelineRowHeightMemory();
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints({
        listRef: { current: null },
        routeThreadKey: "hints-live",
        memory,
      }),
    );
    const detach = attachColumn(result.current);
    onTestFinished(detach);
    const settled = messageRow("reply");
    const streaming: MessagesTimelineRow =
      settled.kind === "message"
        ? { ...settled, message: { ...settled.message, streaming: true } }
        : settled;
    result.current.onItemSizeChanged({
      itemKey: streaming.id,
      itemData: streaming,
      size: 140.5,
      previous: 90,
      index: 0,
    });
    expect(memory.stats()).toMatchObject({ writes: 0, corrections: 1 });
    result.current.onItemSizeChanged({
      itemKey: settled.id,
      itemData: settled,
      size: 140.5,
      previous: 90,
      index: 0,
    });
    expect(memory.stats()).toMatchObject({ writes: 1, corrections: 2 });
    // The list keeps 141 for a 140.5 px row (rounded); the next layout gets exactly that.
    expect(result.current.getEstimatedItemSize(messageRow("reply"), 0, "message")).toBe(141);
  });

  it("keys remembered heights by the width rows measured at", async () => {
    const memory = createTimelineRowHeightMemory();
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints({
        listRef: { current: null },
        routeThreadKey: "hints-width",
        memory,
      }),
    );
    const column = document.createElement("div");
    column.style.width = "640px";
    document.body.append(column);
    onTestFinished(() => column.remove());
    result.current.rowColumnRef(column);
    const report = (size: number) =>
      result.current.onItemSizeChanged({
        itemKey: "reply",
        itemData: messageRow("reply"),
        size,
        previous: 100,
        index: 0,
      });
    report(300.25);
    expect(result.current.getEstimatedItemSize(messageRow("reply"), 0, "message")).toBe(300);
    // Wider: rows wrap differently, so the 640 px height does not apply.
    column.style.width = "900px";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    result.current.onRowColumnResize();
    await afterResizeSettles();
    const wide = result.current.getEstimatedItemSize(messageRow("reply"), 0, "message");
    expect(wide).not.toBe(300);
    report(180);
    expect(result.current.getEstimatedItemSize(messageRow("reply"), 0, "message")).toBe(180);
    // Back at 640 px, its own height applies again.
    column.style.width = "640px";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    result.current.onRowColumnResize();
    await afterResizeSettles();
    expect(result.current.getEstimatedItemSize(messageRow("reply"), 0, "message")).toBe(300);
  });

  it("keeps only the width a resize settles on", async () => {
    const memory = createTimelineRowHeightMemory({ maxBuckets: 8 });
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints({
        listRef: { current: null },
        routeThreadKey: "hints-drag",
        memory,
      }),
    );
    const column = document.createElement("div");
    column.style.width = "640px";
    document.body.append(column);
    onTestFinished(() => column.remove());
    result.current.rowColumnRef(column);
    const report = (id: string, size: number) =>
      result.current.onItemSizeChanged({
        itemKey: id,
        itemData: messageRow(id),
        size,
        previous: 100,
        index: 0,
      });
    report("start", 120);
    expect(memory.stats()).toMatchObject({ buckets: 1, writes: 1 });
    // A drag through 30 widths, rows measuring at each, faster than the settle time.
    for (let step = 1; step <= 30; step += 1) {
      column.style.width = `${640 + step * 4}px`;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      result.current.onRowColumnResize();
      report(`row-${step}`, 100 + step);
      report("last", 200 + step);
    }
    // Nothing stored mid-drag, and no bucket per width passed through.
    expect(memory.stats()).toMatchObject({ buckets: 1, writes: 1 });
    await afterResizeSettles();
    // The two rows measured at the final 760 px width are kept, under that width only.
    expect(memory.stats()).toMatchObject({ buckets: 2, writes: 3 });
    expect(result.current.getEstimatedItemSize(messageRow("last"), 0, "message")).toBe(230);
    expect(result.current.getEstimatedItemSize(messageRow("row-30"), 0, "message")).toBe(130);
    expect(result.current.getEstimatedItemSize(messageRow("row-29"), 0, "message")).not.toBe(129);
  });

  it("keeps nothing a row measures while the column cannot be read", async () => {
    const memory = createTimelineRowHeightMemory();
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints({
        listRef: { current: null },
        routeThreadKey: "hints-collapsed",
        memory,
      }),
    );
    const column = document.createElement("div");
    column.style.width = "0px";
    document.body.append(column);
    onTestFinished(() => column.remove());
    result.current.rowColumnRef(column);
    const reply = messageRow("reply");
    result.current.onItemSizeChanged({
      itemKey: reply.id,
      itemData: reply,
      size: 900,
      previous: 100,
      index: 0,
    });
    // A collapsed pane: rows wrap at a width no layout has.
    expect(memory.stats()).toMatchObject({ writes: 0, corrections: 1 });
    result.current.rowColumnRef(null);
    result.current.onItemSizeChanged({
      itemKey: reply.id,
      itemData: reply,
      size: 700,
      previous: 900,
      index: 0,
    });
    expect(memory.stats()).toMatchObject({ writes: 0, corrections: 2 });
  });

  it("starts another thread's rows fresh when the same mount switches threads", async () => {
    const memory = createTimelineRowHeightMemory();
    const detachments: Array<() => void> = [];
    onTestFinished(() => detachments.forEach((detach) => detach()));
    const { result, rerender } = await renderHook(
      (props?: { threadKey: string }) =>
        useTimelineRowHeightHints({
          listRef: { current: null },
          routeThreadKey: props?.threadKey ?? "hints-thread-a",
          memory,
        }),
      { initialProps: { threadKey: "hints-thread-a" } },
    );
    detachments.push(attachColumn(result.current));
    const first = result.current;
    first.onItemSizeChanged({
      itemKey: "reply",
      itemData: messageRow("reply"),
      size: 410,
      previous: 100,
      index: 0,
    });
    expect(first.getEstimatedItemSize(messageRow("reply"), 0, "message")).toBe(410);
    await rerender({ threadKey: "hints-thread-b" });
    const second = result.current;
    expect(second).not.toBe(first);
    // Thread B's row of the same id has not measured anything yet.
    expect(second.getEstimatedItemSize(messageRow("reply"), 0, "message")).not.toBe(410);
  });

  it("does not serve heights measured under another presentation tier", async () => {
    const stopTier = syncDocumentPresentationTier();
    onTestFinished(() => {
      useTierOverrideStore.setState({ override: "desktop" });
      stopTier();
      useTierOverrideStore.setState({ override: null });
    });
    useTierOverrideStore.setState({ override: "desktop" });
    const memory = createTimelineRowHeightMemory();
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints({
        listRef: { current: null },
        routeThreadKey: "hints-tier",
        memory,
      }),
    );
    const detach = attachColumn(result.current);
    onTestFinished(detach);
    const report = (size: number) =>
      result.current.onItemSizeChanged({
        itemKey: "reply",
        itemData: messageRow("reply"),
        size,
        previous: 100,
        index: 0,
      });
    report(333);
    expect(result.current.getEstimatedItemSize(messageRow("reply"), 0, "message")).toBe(333);
    // The tier is read where the list asks, not after the commit that re-rendered for it.
    useTierOverrideStore.setState({ override: "phone" });
    expect(result.current.getEstimatedItemSize(messageRow("reply"), 0, "message")).not.toBe(333);
    report(222);
    useTierOverrideStore.setState({ override: "desktop" });
    expect(result.current.getEstimatedItemSize(messageRow("reply"), 0, "message")).toBe(333);
  });

  it("ignores size reports for a row that left the list's data", async () => {
    const memory = createTimelineRowHeightMemory();
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints({
        listRef: { current: null },
        routeThreadKey: "hints-stale",
        memory,
      }),
    );
    const detach = attachColumn(result.current);
    onTestFinished(detach);
    const removed = messageRow("removed");
    const shifted = messageRow("shifted");
    result.current.onItemSizeChanged({
      itemKey: removed.id,
      itemData: shifted,
      size: 321,
      previous: 100,
      index: 3,
    });
    expect(() =>
      result.current.onItemSizeChanged({
        itemKey: removed.id,
        itemData: undefined,
        size: 0,
        previous: 100,
        index: 3,
      }),
    ).not.toThrow();
    expect(memory.stats()).toMatchObject({ writes: 0, corrections: 0 });
    expect(result.current.getEstimatedItemSize(messageRow("removed"), 3, "message")).not.toBe(321);
    expect(result.current.getEstimatedItemSize(messageRow("shifted"), 3, "message")).not.toBe(321);
  });
});
