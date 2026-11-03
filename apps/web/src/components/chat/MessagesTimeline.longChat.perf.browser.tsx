import "../../index.css";

// Opt-in long-chat measurement for the real timeline (real LegendList, real CSS). Run with
//   VITE_RYCO_PERF_PROFILE=1 bun run --cwd apps/web test:browser -- \
//     src/components/chat/MessagesTimeline.longChat.perf.browser.tsx
// It prints one `[long-chat-perf]` JSON line per iteration and the medians. Only DOM state is
// read, so the same file measures any revision (copy it into a base worktree to compare). That is
// why it imports nothing added with it (the fixture generator and the visibility check are local).

import { EnvironmentId, MessageId, TurnId } from "@ryco/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef, type RefObject } from "react";
import { page } from "vite-plus/test/browser";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { cdpSession } from "../../../test/browserPointer";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import type { deriveTimelineEntries } from "../../session-logic";
import { useTierOverrideStore } from "../../tierOverrideStore";
import { MessagesTimeline } from "./MessagesTimeline";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const ITERATIONS = 7;
const TURNS = 150;
const HOST_WIDTH = 760;
const HOST_HEIGHT = 900;
const WHEEL_EVENTS = 120;
const WHEEL_DELTA_Y = -240;

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
  "the timeline keeps every row measured while the reader scrolls through long replies with code lists and tables so nothing jumps under the pointer".split(
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

function codeBlock(random: () => number, lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, line) =>
      `const value${line} = compute(${Math.floor(random() * 1000)}, "${sentence(random, 3)}");`,
  ).join("\n");
  return `\`\`\`ts\n${body}\n\`\`\``;
}

// 150 turns: a user message of 1-6 lines, 0-3 settled tool rows and a heavy-tailed reply
// (2-40 paragraphs, 0-3 code blocks of 5-60 lines).
function makeThread(seed: number): TimelineEntries {
  const random = mulberry32(seed);
  const entries: TimelineEntries = [];
  let second = 0;
  const at = () => new Date(Date.UTC(2026, 9, 1, 0, 0, second++)).toISOString();
  for (let turn = 0; turn < TURNS; turn += 1) {
    const turnId = TurnId.make(`turn-${seed}-${turn}`);
    const userAt = at();
    const userLines = 1 + Math.floor(random() * 6);
    entries.push({
      id: `user-${seed}-${turn}`,
      kind: "message",
      createdAt: userAt,
      message: {
        id: MessageId.make(`user-${seed}-${turn}`),
        role: "user",
        text: Array.from({ length: userLines }, () =>
          sentence(random, 6 + Math.floor(random() * 14)),
        ).join("\n"),
        turnId,
        createdAt: userAt,
        completedAt: userAt,
        streaming: false,
      },
    });
    const workRows = Math.floor(random() * 4);
    for (let work = 0; work < workRows; work += 1) {
      const workAt = at();
      entries.push({
        id: `work-${seed}-${turn}-${work}`,
        kind: "work",
        createdAt: workAt,
        entry: {
          id: `work-${seed}-${turn}-${work}`,
          createdAt: workAt,
          label: "Ran command",
          command: `bun run test -- ${sentence(random, 2)}`,
          completed: true,
          tone: "tool",
          itemType: "command_execution",
          turnId,
        },
      });
    }
    const tail = random();
    const paragraphs =
      tail < 0.6
        ? 2 + Math.floor(random() * 4)
        : tail < 0.9
          ? 6 + Math.floor(random() * 10)
          : 16 + Math.floor(random() * 25);
    const blocks: string[] = [];
    for (let paragraph = 0; paragraph < paragraphs; paragraph += 1) {
      blocks.push(sentence(random, 12 + Math.floor(random() * 40)));
    }
    const codeBlocks = Math.floor(random() * 4);
    for (let block = 0; block < codeBlocks; block += 1) {
      const position = Math.floor(random() * (blocks.length + 1));
      blocks.splice(position, 0, codeBlock(random, 5 + Math.floor(random() * 56)));
    }
    const replyAt = at();
    entries.push({
      id: `assistant-${seed}-${turn}`,
      kind: "message",
      createdAt: replyAt,
      message: {
        id: MessageId.make(`assistant-${seed}-${turn}`),
        role: "assistant",
        text: blocks.join("\n\n"),
        turnId,
        createdAt: replyAt,
        completedAt: replyAt,
        streaming: false,
      },
    });
  }
  return entries;
}

function Timeline(props: {
  readonly threadKey: string;
  readonly entries: TimelineEntries;
  readonly listRef: RefObject<LegendListRef | null>;
}) {
  return (
    <div style={{ width: HOST_WIDTH, height: HOST_HEIGHT }} data-long-chat-host="true">
      <MessagesTimeline
        // ChatView remounts the timeline per thread the same way.
        key={props.threadKey}
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnId={null}
        activeTurnStartedAt={null}
        listRef={props.listRef}
        timelineEntries={props.entries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        routeThreadKey={props.threadKey}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onUndoTurn={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
        onIsAtEndChange={() => {}}
      />
    </div>
  );
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) await nextFrame();
}

function scrollNodeOf(listRef: RefObject<LegendListRef | null>): HTMLElement | null {
  const node = listRef.current?.getScrollableNode?.();
  return node instanceof HTMLElement ? node : null;
}

// Visible = LegendList's item container is not faded out and a row intersects the viewport.
function isTranscriptVisible(node: HTMLElement): boolean {
  const content = node.firstElementChild;
  if (!content) return false;
  const container = Array.from(content.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.style.opacity !== "",
  );
  if (!container || container.style.opacity === "0") return false;
  const viewport = node.getBoundingClientRect();
  for (const row of node.querySelectorAll<HTMLElement>("[data-timeline-root]")) {
    const box = row.getBoundingClientRect();
    if (box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom) return true;
  }
  return false;
}

interface RevealSample {
  readonly revealMs: number;
  readonly rowsMountedAtReveal: number;
  readonly scrollHeightAtReveal: number;
}

async function waitForReveal(
  listRef: RefObject<LegendListRef | null>,
  startedAt: number,
): Promise<RevealSample> {
  for (let frame = 0; frame < 600; frame += 1) {
    const frameAt = await nextFrame();
    const node = scrollNodeOf(listRef);
    if (node && isTranscriptVisible(node)) {
      return {
        revealMs: frameAt - startedAt,
        rowsMountedAtReveal: node.querySelectorAll("[data-timeline-root]").length,
        scrollHeightAtReveal: node.scrollHeight,
      };
    }
  }
  throw new Error("transcript never became visible");
}

// A row on screen should move by exactly the scroll delta each frame; anything else is a jump.
function startDriftMeter(node: HTMLElement) {
  const drift = { frames: 0, jumps: 0, jumpPx: 0, maxJumpPx: 0 };
  let stopped = false;
  let previous: { element: HTMLElement; top: number; scrollTop: number } | null = null;
  const pick = () => {
    const viewTop = node.getBoundingClientRect().top;
    let best: HTMLElement | null = null;
    let bestTop = Infinity;
    for (const element of node.querySelectorAll<HTMLElement>("[data-timeline-root]")) {
      const top = element.getBoundingClientRect().top - viewTop;
      if (top >= 0 && top < node.clientHeight && top < bestTop) {
        best = element;
        bestTop = top;
      }
    }
    return best ? { element: best, top: bestTop, scrollTop: node.scrollTop } : null;
  };
  const tick = () => {
    if (stopped) return;
    drift.frames += 1;
    if (previous?.element.isConnected) {
      const top = previous.element.getBoundingClientRect().top - node.getBoundingClientRect().top;
      const expected = previous.top + (previous.scrollTop - node.scrollTop);
      const jump = Math.abs(top - expected);
      if (jump > 1) {
        drift.jumps += 1;
        drift.jumpPx += jump;
        drift.maxJumpPx = Math.max(drift.maxJumpPx, jump);
      }
    }
    previous = pick();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    stopped = true;
    return {
      ...drift,
      jumpPx: Math.round(drift.jumpPx),
      maxJumpPx: Math.round(drift.maxJumpPx),
    };
  };
}

interface BareRow {
  readonly id: string;
  readonly kind: "user" | "assistant" | "work";
  readonly height: number;
}

// The probe's synthetic thread: rows of fixed (fractional) heights, so only the list itself costs.
function makeBareRows(name: string, seed: number): BareRow[] {
  const random = mulberry32(seed);
  const rows: BareRow[] = [];
  const push = (kind: BareRow["kind"], height: number) => {
    rows.push({ id: `${name}-${rows.length}`, kind, height: Math.round(height * 8) / 8 });
  };
  for (let turn = 0; turn < TURNS; turn += 1) {
    push("user", 64 + random() * 140);
    const workRows = Math.floor(random() * 3);
    for (let w = 0; w < workRows; w += 1) push("work", random() < 0.8 ? 32 : 32 + random() * 300);
    const tail = random();
    push(
      "assistant",
      tail < 0.7
        ? 90 + random() * 300
        : tail < 0.93
          ? 400 + random() * 600
          : 1000 + random() * 1500,
    );
  }
  return rows;
}

function BareList({
  rows,
  listRef,
}: {
  readonly rows: readonly BareRow[];
  readonly listRef: RefObject<LegendListRef | null>;
}) {
  return (
    <div style={{ position: "relative", height: 860, width: 800 }}>
      <LegendList<BareRow>
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.id}
        getItemType={(row) => row.kind}
        renderItem={({ item }) => (
          <div data-timeline-root="true" style={{ height: item.height }}>
            {item.id}
          </div>
        )}
        estimatedItemSize={56}
        recycleItems={false}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.1}
        maintainVisibleContentPosition
        style={{ height: "100%", overflowX: "hidden" }}
        ListHeaderComponent={<div style={{ height: 48 }} />}
        ListFooterComponent={<div style={{ height: 140 }} />}
      />
    </div>
  );
}

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10;
};

describe.runIf(import.meta.env.VITE_RYCO_PERF_PROFILE === "1")("MessagesTimeline long chat", () => {
  let stopTier: (() => void) | undefined;
  beforeAll(async () => {
    await page.viewport(1280, 1000);
    useTierOverrideStore.setState({ override: "desktop" });
    stopTier = syncDocumentPresentationTier();
    await document.fonts.ready;
  });
  afterAll(() => {
    stopTier?.();
    useTierOverrideStore.setState({ override: null });
  });

  it(
    "opens, switches back and scrolls up a 150-turn thread",
    async () => {
      const threadA = makeThread(1);
      const threadB = makeThread(2);
      const samples: Record<string, number>[] = [];
      const cdp = cdpSession();

      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const keyA = `environment-local:long-a-${iteration}`;
        const keyB = `environment-local:long-b-${iteration}`;
        const listRef = createRef<LegendListRef>();

        const firstOpenAt = performance.now();
        const screen = await render(
          <Timeline threadKey={keyA} entries={threadA} listRef={listRef} />,
        );
        const firstOpen = await waitForReveal(listRef, firstOpenAt);
        await frames(20);

        const otherAt = performance.now();
        await screen.rerender(<Timeline threadKey={keyB} entries={threadB} listRef={listRef} />);
        await waitForReveal(listRef, otherAt);
        await frames(20);

        const switchBackAt = performance.now();
        await screen.rerender(<Timeline threadKey={keyA} entries={threadA} listRef={listRef} />);
        const switchBack = await waitForReveal(listRef, switchBackAt);
        await frames(20);

        const node = scrollNodeOf(listRef);
        if (!node) throw new Error("no scroll node");
        const box = node.getBoundingClientRect();
        const stopDrift = startDriftMeter(node);
        for (let event = 0; event < WHEEL_EVENTS; event += 1) {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: Math.round(box.left + box.width / 2),
            y: Math.round(box.top + box.height / 2),
            deltaX: 0,
            deltaY: WHEEL_DELTA_Y,
          });
          await nextFrame();
        }
        await frames(10);
        const drift = stopDrift();

        node.scrollTop = 0;
        await frames(20);
        node.scrollTop = node.scrollHeight;
        await frames(20);
        const settledScrollHeight = node.scrollHeight;

        const sample = {
          iteration,
          firstOpenRevealMs: Math.round(firstOpen.revealMs * 10) / 10,
          switchBackRevealMs: Math.round(switchBack.revealMs * 10) / 10,
          rowsMountedAtReveal: switchBack.rowsMountedAtReveal,
          rangeAtReveal:
            Math.round((switchBack.scrollHeightAtReveal / settledScrollHeight) * 1000) / 1000,
          wheelDriftPx: drift.jumpPx,
          maxJumpPx: drift.maxJumpPx,
          wheelJumps: drift.jumps,
        };
        samples.push(sample);
        console.log("[long-chat-perf]", JSON.stringify(sample));
        await screen.unmount();
        await frames(5);
      }

      const medians = Object.fromEntries(
        [
          "firstOpenRevealMs",
          "switchBackRevealMs",
          "rowsMountedAtReveal",
          "rangeAtReveal",
          "wheelDriftPx",
          "maxJumpPx",
          "wheelJumps",
        ].map((name) => [name, median(samples.map((sample) => sample[name]!))]),
      );
      console.log("[long-chat-perf] medians", JSON.stringify(medians));
      // The app's own reveal marks (absent on revisions without them): mount -> visible per mount.
      const revealMeasures = performance
        .getEntriesByType("measure")
        .filter((entry) => entry.name.startsWith("ryco:timeline-reveal:"))
        .map((entry) => Math.round(entry.duration));
      console.log(
        "[long-chat-perf] ryco:timeline-reveal measures",
        JSON.stringify({
          count: revealMeasures.length,
          medianMs: revealMeasures.length > 0 ? median(revealMeasures) : null,
        }),
      );
      expect(samples).toHaveLength(ITERATIONS);
    },
    10 * 60_000,
  );

  it(
    "reveals a bare end-anchored list with the timeline's list props",
    async () => {
      const rowsA = makeBareRows("a", 1);
      const rowsB = makeBareRows("b", 2);
      const firstOpen: number[] = [];
      const switchBack: number[] = [];
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const listRef = createRef<LegendListRef>();
        const openAt = performance.now();
        const screen = await render(
          <BareList key={`a-${iteration}`} rows={rowsA} listRef={listRef} />,
        );
        firstOpen.push((await waitForReveal(listRef, openAt)).revealMs);
        await frames(10);
        const otherAt = performance.now();
        await screen.rerender(<BareList key={`b-${iteration}`} rows={rowsB} listRef={listRef} />);
        await waitForReveal(listRef, otherAt);
        await frames(10);
        const backAt = performance.now();
        await screen.rerender(<BareList key={`a2-${iteration}`} rows={rowsA} listRef={listRef} />);
        switchBack.push((await waitForReveal(listRef, backAt)).revealMs);
        await frames(10);
        await screen.unmount();
      }
      const result = {
        rows: rowsA.length,
        firstOpenRevealMs: Math.round(median(firstOpen) * 10) / 10,
        switchBackRevealMs: Math.round(median(switchBack) * 10) / 10,
        firstOpenSamples: firstOpen.map((value) => Math.round(value)),
        switchBackSamples: switchBack.map((value) => Math.round(value)),
      };
      console.log("[long-chat-perf] bare", JSON.stringify(result));
      expect(firstOpen).toHaveLength(ITERATIONS);
    },
    5 * 60_000,
  );
});
