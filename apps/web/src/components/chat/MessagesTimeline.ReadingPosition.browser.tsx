import "../../index.css";

import { EnvironmentId, MessageId, TurnId } from "@ryco/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import type { SavedThreadReadingAnchor } from "@ryco/client-runtime/state/threads";
import { StrictMode, createRef, useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { deriveTimelineEntries } from "../../session-logic";
import {
  readThreadReadingAnchor,
  rememberThreadReadingAnchor,
  threadReadingPositions,
} from "../../persistence/threadReadingPositions";
import { useUiStateStore } from "~/uiStateStore";
import { MessagesTimeline } from "./MessagesTimeline";
import type { ReadingPositionOutcome } from "./useTimelineReadingPosition";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const THREAD_A = "environment-local:thread-reading-a";
const THREAD_B = "environment-local:thread-reading-b";
const WATCHED_TURN = TurnId.make("turn-reading-watched");
/** A pixel or two of sub-pixel layout between two visits. */
const TOLERANCE_PX = 2;
const NO_TURN_DIFFS = new Map();
const NO_REVERT_COUNTS = new Map();
const noop = () => {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  minute: number,
  turnId?: TurnId,
) {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
  return {
    id,
    kind: "message" as const,
    createdAt,
    message: {
      id: MessageId.make(id),
      role,
      text,
      createdAt,
      streaming: false,
      ...(turnId ? { turnId } : {}),
    },
  };
}

function workEntry(id: string, minute: number, turnId?: TurnId) {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
  return {
    id,
    kind: "work" as const,
    createdAt,
    entry: {
      id,
      createdAt,
      label: "Ran command",
      detail: `bun run ${id}`,
      tone: "tool" as const,
      ...(turnId ? { turnId } : {}),
    },
  };
}

/**
 * A conversation with one agent turn in it that starts working before it
 * says anything: open, the turn shows a chapter (`chapter:watched-work-a-0`)
 * that only exists while its work entries are loaded.
 */
function conversationWithTurn(): TimelineEntries {
  return [
    ...conversation("early", 12),
    messageEntry("watched-user", "user", "Run the checks", 40),
    ...Array.from({ length: 4 }, (_, index) =>
      workEntry(`watched-work-a-${index}`, 41, WATCHED_TURN),
    ),
    messageEntry(
      "watched-progress",
      "assistant",
      `Lint is clean. ${"Now the tests. ".repeat(12)}`,
      42,
      WATCHED_TURN,
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      workEntry(`watched-work-b-${index}`, 43, WATCHED_TURN),
    ),
    messageEntry(
      "watched-reply",
      "assistant",
      `All green. ${"Reading position text. ".repeat(12)}`,
      44,
      WATCHED_TURN,
    ),
    ...conversation("late", 16, 60),
  ];
}

/** A conversation with one tool call midway (`midway-tool`): a row the read cache cannot paint. */
function conversationWithToolCall(): TimelineEntries {
  return [
    ...conversation("early", 12),
    workEntry("midway-tool", 25),
    ...conversation("late", 12, 30),
  ];
}

/** What Hosted Web's read cache holds of a conversation: its message text, no work. */
function cachedContent(entries: TimelineEntries): TimelineEntries {
  return entries.filter((entry) => entry.kind === "message");
}

/** A conversation of `pairs` exchanges whose replies differ in length. */
function conversation(prefix: string, pairs: number, firstMinute = 0): TimelineEntries {
  const entries: TimelineEntries = [];
  for (let index = 0; index < pairs; index += 1) {
    const minute = firstMinute + index * 2;
    entries.push(messageEntry(`${prefix}-user-${index}`, "user", `Question ${index}`, minute));
    const paragraphs = Array.from(
      { length: 1 + (index % 4) },
      (_, paragraph) =>
        `Answer ${index}, paragraph ${paragraph}. ${"Reading position text. ".repeat(6)}`,
    );
    entries.push(
      messageEntry(
        `${prefix}-assistant-${index}`,
        "assistant",
        paragraphs.join("\n\n"),
        minute + 1,
      ),
    );
  }
  return entries;
}

interface HarnessProps {
  threadKey: string;
  entries: TimelineEntries;
  listRef: React.RefObject<LegendListRef | null>;
  /** The rows are the thread's live detail rather than a cache's copy. */
  detailLive?: boolean;
  /** Live follow at open; defaults to following unless a reading position is remembered. */
  followAtOpen?: boolean;
  targetMessageId?: MessageId | null;
  /** The turn running, watched by the view. */
  runningTurnId?: TurnId | null;
  /** The transcript's height in pixels. */
  height?: number;
}

/**
 * Stands in for the chat view: it keys the timeline by thread, reads the
 * thread's reading position once when it opens, opens following its end
 * unless one is remembered, and follows the timeline's report of the restore.
 * Live follow goes off on manual navigation and back on at the end; the
 * "Follow end" button is the scroll-to-bottom pill (or a send). What the
 * timeline last said about being at its end is `data-is-at-end`.
 */
function Harness({
  threadKey,
  entries,
  listRef,
  detailLive = true,
  followAtOpen,
  targetMessageId = null,
  runningTurnId = null,
  height = 600,
}: HarnessProps) {
  const [readingAnchor] = useState(() => readThreadReadingAnchor(threadKey));
  const [liveFollow, setLiveFollow] = useState(() => followAtOpen ?? readingAnchor === null);
  const [outcome, setOutcome] = useState<ReadingPositionOutcome | "none">("none");
  const [isAtEnd, setIsAtEnd] = useState<boolean | null>(null);
  // Stable like the chat view's handlers: a timeline callback that changed on
  // every render would re-run the timeline's scroll pass and hide a missing one.
  const followEnd = useCallback(() => {
    setLiveFollow(true);
    void listRef.current?.scrollToEnd({ animated: false });
  }, [listRef]);
  const stopFollow = useCallback(() => setLiveFollow(false), []);
  const resumeFollow = useCallback(() => setLiveFollow(true), []);
  const onReadingPositionResolved = useCallback(
    (next: ReadingPositionOutcome) => {
      setOutcome(next);
      if (next === "end") followEnd();
    },
    [followEnd],
  );
  return (
    <div
      data-testid="harness"
      data-live-follow={String(liveFollow)}
      data-reading-outcome={outcome}
      data-is-at-end={isAtEnd === null ? "none" : String(isAtEnd)}
      style={{ height, width: 720, display: "flex", flexDirection: "column" }}
    >
      <button
        type="button"
        data-testid="follow-end"
        onClick={followEnd}
        style={{ position: "absolute", left: 760, top: 0 }}
      >
        Follow end
      </button>
      <MessagesTimeline
        isWorking={runningTurnId !== null}
        activeTurnInProgress={runningTurnId !== null}
        activeTurnId={runningTurnId}
        activeTurnStartedAt={null}
        listRef={listRef}
        timelineEntries={entries}
        turnDiffSummaryByAssistantMessageId={NO_TURN_DIFFS}
        routeThreadKey={threadKey}
        onOpenTurnDiff={noop}
        revertTurnCountByUserMessageId={NO_REVERT_COUNTS}
        onRevertUserMessage={noop}
        onUndoTurn={noop}
        isRevertingCheckpoint={false}
        onImageExpand={noop}
        activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="24-hour"
        workspaceRoot={undefined}
        liveFollowEnabled={liveFollow}
        onIsAtEndChange={setIsAtEnd}
        onManualNavigation={stopFollow}
        onUserReachedEnd={resumeFollow}
        readingAnchor={readingAnchor}
        detailLive={detailLive}
        targetMessageId={targetMessageId}
        onReadingPositionResolved={onReadingPositionResolved}
      />
    </div>
  );
}

function scroller(listRef: React.RefObject<LegendListRef | null>): HTMLElement {
  const node = listRef.current?.getScrollableNode();
  if (!(node instanceof HTMLElement)) throw new Error("The timeline has no scroller.");
  return node;
}

function distanceFromEnd(node: HTMLElement): number {
  return node.scrollHeight - node.clientHeight - node.scrollTop;
}

/** Where `rowId`'s row starts relative to the viewport's top, or null when it is not mounted. */
function rowTop(node: HTMLElement, rowId: string): number | null {
  const row = node.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`);
  return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
}

function harnessAttribute(name: string): string | null | undefined {
  return document.querySelector('[data-testid="harness"]')?.getAttribute(name);
}

/** What a restore holding the list is doing, or null when none holds it. */
function readingHold(): string | null {
  return (
    document
      .querySelector("[data-reading-position-hold]")
      ?.getAttribute("data-reading-position-hold") ?? null
  );
}

type MountOptions = Omit<HarnessProps, "threadKey" | "entries" | "listRef">;

/**
 * Mounts the harness and returns as soon as it has committed: a restore is
 * then still running. `strict` renders it the way the dev app does, under
 * StrictMode, which rehearses an unmount and remount of every effect.
 */
async function mountNow(
  threadKey: string,
  entries: TimelineEntries,
  options: MountOptions = {},
  { strict = false }: { readonly strict?: boolean } = {},
) {
  const listRef = createRef<LegendListRef | null>();
  const wrap = (element: React.ReactElement) =>
    strict ? <StrictMode>{element}</StrictMode> : element;
  const screen = await render(
    wrap(
      <Harness
        key={threadKey}
        threadKey={threadKey}
        entries={entries}
        listRef={listRef}
        {...options}
      />,
    ),
  );
  const rerender = (next: TimelineEntries, nextOptions: MountOptions = options) =>
    screen.rerender(
      wrap(
        <Harness
          key={threadKey}
          threadKey={threadKey}
          entries={next}
          listRef={listRef}
          {...nextOptions}
        />,
      ),
    );
  return { listRef, screen, rerender };
}

async function mount(
  threadKey: string,
  entries: TimelineEntries,
  options: MountOptions = {},
  mode: { readonly strict?: boolean } = {},
) {
  const mounted = await mountNow(threadKey, entries, options, mode);
  await vi.waitFor(() => expect(scroller(mounted.listRef).scrollHeight).toBeGreaterThan(1_200));
  return mounted;
}

/** Leaves thread A at a row partway up, and returns where that row was. */
async function leaveThreadAMidway(entries: TimelineEntries = conversation("a", 24)) {
  const first = await mount(THREAD_A, entries);
  const left = await readAt(first.listRef, 900);
  await first.screen.unmount();
  return left;
}

/** The remembered anchors as Hosted Web's read cache saves and reads them back on a reload. */
function reloadFromSavedAnchors() {
  const saved: Array<[string, SavedThreadReadingAnchor]> = [];
  threadReadingPositions.forEach((key, anchor) => {
    saved.push([
      key,
      {
        rowId: anchor.rowId,
        offsetWithinRow: anchor.offsetWithinRow,
        ...(anchor.turnId === undefined ? {} : { turnId: anchor.turnId }),
        leftAt: anchor.leftAt,
      },
    ]);
  });
  threadReadingPositions.clear();
  threadReadingPositions.restore(saved);
}

/** Scrolls up the way a reader does: a wheel gesture leaves live follow, then the list moves. */
async function readAt(listRef: React.RefObject<LegendListRef | null>, scrollTop: number) {
  const node = scroller(listRef);
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="harness"]')?.getAttribute("data-live-follow"),
    ).toBe("false"),
  );
  await vi.waitFor(async () => {
    node.scrollTop = scrollTop;
    await nextFrame();
    await nextFrame();
    expect(Math.abs(node.scrollTop - scrollTop)).toBeLessThanOrEqual(1);
  });
  await vi.waitFor(() => expect(readThreadReadingAnchor(THREAD_A)).not.toBeNull());
  // Let the remembered anchor catch up with the last scroll event.
  await nextFrame();
  await nextFrame();
  const anchor = readThreadReadingAnchor(THREAD_A)!;
  const top = rowTop(node, anchor.rowId);
  expect(top).not.toBeNull();
  return { rowId: anchor.rowId, top: top! };
}

/**
 * Reads with `rowId` at the viewport's top. Rows above it measure as they
 * come into view, so its laid-out position is re-read until it holds.
 */
async function readAtRow(listRef: React.RefObject<LegendListRef | null>, rowId: string) {
  const node = scroller(listRef);
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  await vi.waitFor(() => expect(harnessAttribute("data-live-follow")).toBe("false"));
  await vi.waitFor(
    async () => {
      const state = listRef.current!.getState();
      const index = state.indexByKey(rowId);
      expect(index).not.toBeUndefined();
      node.scrollTop = Math.round(state.positionAtIndex(index!)) + 2;
      await nextFrame();
      await nextFrame();
      expect(readThreadReadingAnchor(THREAD_A)?.rowId).toBe(rowId);
    },
    { timeout: 5_000 },
  );
  await nextFrame();
  await nextFrame();
  expect(readThreadReadingAnchor(THREAD_A)?.rowId).toBe(rowId);
  const top = rowTop(node, rowId);
  expect(top).not.toBeNull();
  return { rowId, top: top! };
}

/** Waits for a reopened thread's row to settle where it was left. */
async function expectRowAt(
  listRef: React.RefObject<LegendListRef | null>,
  left: { readonly rowId: string; readonly top: number },
) {
  await vi.waitFor(
    () => {
      const top = rowTop(scroller(listRef), left.rowId);
      expect(top).not.toBeNull();
      expect(Math.abs(top! - left.top)).toBeLessThanOrEqual(TOLERANCE_PX);
    },
    { timeout: 5_000 },
  );
  // And it stays there once the restore lets go of the list.
  await sleep(250);
  expect(Math.abs(rowTop(scroller(listRef), left.rowId)! - left.top)).toBeLessThanOrEqual(
    TOLERANCE_PX,
  );
}

describe("MessagesTimeline reading position", () => {
  afterEach(() => {
    threadReadingPositions.clear();
    useUiStateStore.setState({
      threadTurnFoldExpandedById: {},
      threadWorkGroupExpandedById: {},
      threadWorkEntryExpandedById: {},
    });
    document.body.innerHTML = "";
  });

  it("reopens a thread at the row it was left at, and the other at its end", async () => {
    const entriesA = conversation("a", 24);
    const entriesB = conversation("b", 24);
    const first = await mount(THREAD_A, entriesA);
    const left = await readAt(first.listRef, 900);
    await first.screen.unmount();

    // The other thread was never left away from its end.
    const other = await mount(THREAD_B, entriesB);
    await vi.waitFor(() => expect(distanceFromEnd(scroller(other.listRef))).toBeLessThanOrEqual(1));
    await other.screen.unmount();

    const back = await mount(THREAD_A, entriesA);
    await expectRowAt(back.listRef, left);
    expect(distanceFromEnd(scroller(back.listRef))).toBeGreaterThan(200);
    // Reopened away from the end: live output is not followed.
    expect(
      document.querySelector('[data-testid="harness"]')?.getAttribute("data-live-follow"),
    ).toBe("false");
    await back.screen.unmount();
  });

  it("keeps the row in place when a group above it unfolds between visits", async () => {
    const entries: TimelineEntries = [
      ...conversation("early", 4),
      ...Array.from({ length: 12 }, (_, index) => workEntry(`tool-${index}`, 20)),
      ...conversation("late", 18, 30),
    ];
    const first = await mount(THREAD_A, entries);
    // Read below the folded group, so it sits above the anchor.
    const left = await readAt(first.listRef, 1_400);
    expect(left.rowId.startsWith("late-")).toBe(true);
    await first.screen.unmount();

    // Unfolded elsewhere (another pane): twelve rows appear above the anchor.
    useUiStateStore.setState({
      threadWorkGroupExpandedById: { [THREAD_A]: { "work-group:tool-0": true } },
    });
    const back = await mount(THREAD_A, entries);
    await expectRowAt(back.listRef, left);
    await back.screen.unmount();
  });

  it("keeps the row in place when older history loads above it", async () => {
    const recent = conversation("recent", 20, 100);
    const first = await mount(THREAD_A, recent);
    const left = await readAt(first.listRef, 800);
    await first.screen.unmount();

    // The thread reopens with an earlier page of history loaded above.
    const back = await mount(THREAD_A, [...conversation("older", 16), ...recent]);
    await expectRowAt(back.listRef, left);
    await back.screen.unmount();
  });

  it("keeps the row in place while older history loads above it on screen", async () => {
    const recent = conversation("recent", 20, 100);
    const view = await mount(THREAD_A, recent);
    const left = await readAt(view.listRef, 800);
    await view.screen.rerender(
      <Harness
        key={THREAD_A}
        threadKey={THREAD_A}
        entries={[...conversation("older", 16), ...recent]}
        listRef={view.listRef}
      />,
    );
    await expectRowAt(view.listRef, left);
    expect(readThreadReadingAnchor(THREAD_A)?.rowId).toBe(left.rowId);
    await view.screen.unmount();
  });

  it("keeps the row in place while a group above it unfolds on screen", async () => {
    const entries: TimelineEntries = [
      ...conversation("early", 4),
      ...Array.from({ length: 12 }, (_, index) => workEntry(`tool-${index}`, 20)),
      ...conversation("late", 18, 30),
    ];
    const view = await mount(THREAD_A, entries);
    const left = await readAt(view.listRef, 1_400);
    useUiStateStore.setState({
      threadWorkGroupExpandedById: { [THREAD_A]: { "work-group:tool-0": true } },
    });
    await expectRowAt(view.listRef, left);
    // What is remembered is still that row.
    expect(readThreadReadingAnchor(THREAD_A)?.rowId).toBe(left.rowId);
    await view.screen.unmount();
  });

  it("reopens a thread left at its end following its live output", async () => {
    const entries = conversation("a", 24);
    const first = await mount(THREAD_A, entries);
    await vi.waitFor(() => expect(distanceFromEnd(scroller(first.listRef))).toBeLessThanOrEqual(1));
    await first.screen.unmount();
    expect(readThreadReadingAnchor(THREAD_A)).toBeNull();

    const back = await mount(THREAD_A, entries);
    await vi.waitFor(() => expect(distanceFromEnd(scroller(back.listRef))).toBeLessThanOrEqual(1));
    expect(
      document.querySelector('[data-testid="harness"]')?.getAttribute("data-live-follow"),
    ).toBe("true");
    // New output arrives and the list follows it.
    await back.screen.rerender(
      <Harness
        key={THREAD_A}
        threadKey={THREAD_A}
        entries={[...entries, messageEntry("a-live", "assistant", "Live reply", 90)]}
        listRef={back.listRef}
      />,
    );
    await vi.waitFor(() => {
      expect(rowTop(scroller(back.listRef), "a-live")).not.toBeNull();
      expect(distanceFromEnd(scroller(back.listRef))).toBeLessThanOrEqual(1);
    });
    await back.screen.unmount();
  });

  it("reopens at the end, following, when the remembered row is gone", async () => {
    const entries = conversation("a", 24);
    rememberThreadReadingAnchor(THREAD_A, {
      rowId: "a-row-that-no-longer-exists",
      offsetWithinRow: 12,
    });

    const view = await mount(THREAD_A, entries);
    await vi.waitFor(() => {
      expect(distanceFromEnd(scroller(view.listRef))).toBeLessThanOrEqual(1);
      expect(
        document.querySelector('[data-testid="harness"]')?.getAttribute("data-live-follow"),
      ).toBe("true");
    });
    expect(readThreadReadingAnchor(THREAD_A)).toBeNull();
    await view.screen.unmount();
  });

  it("forgets the least recently left thread once a hundred others are remembered", async () => {
    const entries = conversation("a", 24);
    const first = await mount(THREAD_A, entries);
    await readAt(first.listRef, 900);
    await first.screen.unmount();

    for (let index = 0; index < 100; index += 1) {
      rememberThreadReadingAnchor(`environment-local:other-${index}`, {
        rowId: "row",
        offsetWithinRow: 0,
      });
    }
    expect(readThreadReadingAnchor(THREAD_A)).toBeNull();

    const back = await mount(THREAD_A, entries);
    await vi.waitFor(() => expect(distanceFromEnd(scroller(back.listRef))).toBeLessThanOrEqual(1));
    await back.screen.unmount();
  });

  it("holds the row while the composer clearance below it grows", async () => {
    const entries = conversation("a", 24);
    const first = await mount(THREAD_A, entries);
    const left = await readAt(first.listRef, 900);
    await first.screen.unmount();

    const back = await mount(THREAD_A, entries);
    await expectRowAt(back.listRef, left);
    // The composer grows (a long draft, an attachment): its clearance is the list footer.
    document
      .querySelector<HTMLElement>('[data-testid="harness"]')!
      .style.setProperty("--chat-composer-clearance", "320px");
    await expectRowAt(back.listRef, left);
    await back.screen.unmount();
  });

  it("waits for a reloaded thread's live rows to restore a row in a watched turn", async () => {
    const entries = conversationWithTurn();
    // The view watches the turn run, then settle: its outline stays open.
    const first = await mount(THREAD_A, entries, { runningTurnId: WATCHED_TURN });
    await first.rerender(entries, {});
    await vi.waitFor(() =>
      expect(
        first.listRef.current!.getState().indexByKey("chapter:watched-work-a-0"),
      ).not.toBeUndefined(),
    );
    // Let the opened thread's own end pin settle before reading.
    await vi.waitFor(() => expect(distanceFromEnd(scroller(first.listRef))).toBeLessThanOrEqual(1));
    await sleep(500);
    // Read with the turn's work-first chapter at the top: a row the cache cannot paint.
    const left = await readAtRow(first.listRef, "chapter:watched-work-a-0");
    expect(left.rowId).toBe("chapter:watched-work-a-0");
    expect(readThreadReadingAnchor(THREAD_A)?.turnId).toBe(WATCHED_TURN);
    await first.screen.unmount();

    // A reload: the anchor comes back from storage without the watched turns,
    // and the thread paints from the cache's message text first.
    reloadFromSavedAnchors();
    const back = await mount(THREAD_A, cachedContent(entries), { detailLive: false });
    await sleep(300);
    expect(readingHold()).toBe("waiting");
    expect(harnessAttribute("data-reading-outcome")).toBe("none");
    expect(harnessAttribute("data-live-follow")).toBe("false");
    // Nothing the cached paint showed replaced the remembered row.
    expect(readThreadReadingAnchor(THREAD_A)).toMatchObject({
      rowId: left.rowId,
      turnId: WATCHED_TURN,
    });

    // The live window arrives with the turn's work: the row is back, in its place.
    await back.rerender(entries, { detailLive: true });
    await expectRowAt(back.listRef, left);
    expect(harnessAttribute("data-reading-outcome")).toBe("restored");
    expect(harnessAttribute("data-live-follow")).toBe("false");
    await back.screen.unmount();
  });

  it("calls a remembered row gone only once the live rows lack it too", async () => {
    const entries = conversation("a", 24);
    rememberThreadReadingAnchor(THREAD_A, {
      rowId: "a-row-that-no-longer-exists",
      offsetWithinRow: 12,
    });

    const view = await mount(THREAD_A, cachedContent(entries), { detailLive: false });
    await sleep(300);
    expect(readingHold()).toBe("waiting");
    expect(readThreadReadingAnchor(THREAD_A)?.rowId).toBe("a-row-that-no-longer-exists");

    await view.rerender(entries, { detailLive: true });
    await vi.waitFor(() => {
      expect(harnessAttribute("data-reading-outcome")).toBe("end");
      expect(harnessAttribute("data-live-follow")).toBe("true");
      expect(distanceFromEnd(scroller(view.listRef))).toBeLessThanOrEqual(1);
    });
    expect(readingHold()).toBeNull();
    expect(readThreadReadingAnchor(THREAD_A)).toBeNull();
    await view.screen.unmount();
  });

  it("stops correcting the list once the reader scrolls during a restore", async () => {
    const entries = conversation("a", 24);
    const left = await leaveThreadAMidway(entries);

    const back = await mountNow(THREAD_A, entries);
    expect(readingHold()).toBe("restoring");
    const node = scroller(back.listRef);
    // The reader scrolls toward the top before the row has settled.
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    node.scrollTop = 0;
    await vi.waitFor(() => expect(readingHold()).toBeNull());
    await sleep(400);
    // The list stayed where the reader took it rather than at the remembered row.
    expect(node.scrollTop).toBeLessThan(300);
    const top = rowTop(node, left.rowId);
    expect(top === null || Math.abs(top - left.top) > 200).toBe(true);
    expect(harnessAttribute("data-reading-outcome")).toBe("restored");
    await back.screen.unmount();
  });

  it("ends a restore when live follow turns on during it", async () => {
    const entries = conversation("a", 24);
    await leaveThreadAMidway(entries);

    const back = await mountNow(THREAD_A, entries);
    expect(readingHold()).toBe("restoring");
    // The pill (or a send) before the row has settled: the end wins.
    document.querySelector<HTMLButtonElement>('[data-testid="follow-end"]')!.click();
    await vi.waitFor(() => {
      expect(readingHold()).toBeNull();
      expect(distanceFromEnd(scroller(back.listRef))).toBeLessThanOrEqual(1);
    });
    await sleep(400);
    expect(distanceFromEnd(scroller(back.listRef))).toBeLessThanOrEqual(1);
    expect(harnessAttribute("data-live-follow")).toBe("true");
    await vi.waitFor(() => expect(readThreadReadingAnchor(THREAD_A)).toBeNull());
    await back.screen.unmount();
  });

  it("opens at a search or deep-link target instead of the remembered row", async () => {
    const entries = conversation("a", 24);
    const left = await leaveThreadAMidway(entries);
    const target = MessageId.make("a-user-21");

    const back = await mount(THREAD_A, entries, { targetMessageId: target });
    await vi.waitFor(() => expect(harnessAttribute("data-reading-outcome")).toBe("released"));
    expect(readingHold()).toBeNull();
    await vi.waitFor(
      () => {
        const node = scroller(back.listRef);
        const top = rowTop(node, target);
        expect(top).not.toBeNull();
        expect(top!).toBeGreaterThanOrEqual(0);
        expect(top!).toBeLessThan(node.clientHeight);
      },
      { timeout: 5_000 },
    );
    const top = rowTop(scroller(back.listRef), left.rowId);
    expect(top === null || Math.abs(top - left.top) > 200).toBe(true);
    await back.screen.unmount();
  });

  it("opens at the end when live follow was turned on before the list mounted", async () => {
    const entries = conversation("a", 24);
    await leaveThreadAMidway(entries);

    // A send while the thread still showed its skeleton chose the end.
    const back = await mount(THREAD_A, entries, { followAtOpen: true });
    await vi.waitFor(() => expect(distanceFromEnd(scroller(back.listRef))).toBeLessThanOrEqual(1));
    expect(readingHold()).toBeNull();
    expect(harnessAttribute("data-reading-outcome")).toBe("none");
    await vi.waitFor(() => expect(readThreadReadingAnchor(THREAD_A)).toBeNull());
    await back.screen.unmount();
  });

  it("tells the chat view nothing about its end while a restore waits for its row", async () => {
    const entries = conversationWithToolCall();
    rememberThreadReadingAnchor(THREAD_A, { rowId: "midway-tool", offsetWithinRow: 0 });

    const view = await mount(THREAD_A, cachedContent(entries), { detailLive: false });
    await sleep(300);
    expect(readingHold()).toBe("waiting");
    // The list rests at its end meanwhile. A chat view told so would pin the
    // end for a resizing composer, and that would end the wait.
    expect(harnessAttribute("data-is-at-end")).toBe("none");

    await view.rerender(entries, { detailLive: true });
    await vi.waitFor(() => expect(readingHold()).toBeNull(), { timeout: 5_000 });
    expect(harnessAttribute("data-reading-outcome")).toBe("restored");
    // Once the restore lets go, where it settled is reported.
    await vi.waitFor(() => expect(harnessAttribute("data-is-at-end")).toBe("false"));
    await view.screen.unmount();
  });

  it("reports a restored row that can only settle at the end as the end", async () => {
    const entries = conversation("a", 24);
    const first = await mount(THREAD_A, entries);
    await vi.waitFor(() => expect(distanceFromEnd(scroller(first.listRef))).toBeLessThanOrEqual(1));
    await sleep(300);
    const node = scroller(first.listRef);
    await readAt(first.listRef, node.scrollHeight - node.clientHeight - 150);
    await first.screen.unmount();

    // A taller window: the row can no longer reach the viewport's top.
    const back = await mount(THREAD_A, entries, { height: 900 });
    await vi.waitFor(
      () => {
        expect(readingHold()).toBeNull();
        expect(distanceFromEnd(scroller(back.listRef))).toBeLessThanOrEqual(1);
      },
      { timeout: 5_000 },
    );
    expect(harnessAttribute("data-reading-outcome")).toBe("restored");
    // The settled spot is reported and remembered: the end.
    await vi.waitFor(() => {
      expect(harnessAttribute("data-is-at-end")).toBe("true");
      expect(readThreadReadingAnchor(THREAD_A)).toBeNull();
    });
    await back.screen.unmount();
  });

  it("hands a waiting restore to the reader's click, and follows the end from there", async () => {
    const entries = conversationWithToolCall();
    rememberThreadReadingAnchor(THREAD_A, { rowId: "midway-tool", offsetWithinRow: 0 });

    const view = await mount(THREAD_A, cachedContent(entries), { detailLive: false });
    await sleep(300);
    expect(readingHold()).toBe("waiting");
    // The reader clicks into the transcript, which rests at its end.
    const lastRow = scroller(view.listRef).querySelector<HTMLElement>(
      '[data-timeline-row-id="late-assistant-11"]',
    );
    expect(lastRow).not.toBeNull();
    lastRow!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await vi.waitFor(() => {
      expect(harnessAttribute("data-reading-outcome")).toBe("released");
      expect(readingHold()).toBeNull();
      expect(harnessAttribute("data-live-follow")).toBe("true");
    });

    // The live rows arrive, then live output: the list follows it.
    await view.rerender(entries, { detailLive: true });
    await view.rerender([...entries, messageEntry("late-live", "assistant", "Live reply", 90)], {
      detailLive: true,
    });
    await vi.waitFor(() => {
      expect(rowTop(scroller(view.listRef), "late-live")).not.toBeNull();
      expect(distanceFromEnd(scroller(view.listRef))).toBeLessThanOrEqual(1);
    });
    expect(readThreadReadingAnchor(THREAD_A)).toBeNull();
    await view.screen.unmount();
  });

  it("lets a thread close while its restore is still running", async () => {
    const entries = conversation("a", 24);
    await leaveThreadAMidway(entries);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    try {
      const back = await mountNow(THREAD_A, entries);
      expect(readingHold()).toBe("restoring");
      // The reader switches threads before the row has settled.
      await back.screen.unmount();
      await sleep(200);
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("restores the row under StrictMode, which rehearses an unmount and remount", async () => {
    const entries = conversation("a", 24);
    const left = await leaveThreadAMidway(entries);

    const back = await mount(THREAD_A, entries, {}, { strict: true });
    await expectRowAt(back.listRef, left);
    expect(harnessAttribute("data-reading-outcome")).toBe("restored");
    await back.screen.unmount();
  });
});
