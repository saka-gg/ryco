import type { MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { useComposerDraftStore } from "../composerDraftStore";
import { useUiStateStore } from "../uiStateStore";
import {
  readThreadReadingAnchor,
  rememberThreadReadingAnchor,
} from "../persistence/threadReadingPositions";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NARROW_PHONE_VIEWPORT,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  THREAD_TITLE,
  addThreadToSnapshot,
  createSnapshotForTargetUser,
  createUserMessage,
  findScrollToBottomButton,
  findScrollableAncestor,
  mountChatView,
  serverThreadPath,
  setupChatViewBrowserSuite,
  threadRefFor,
  waitForComposerEditor,
  waitForElement,
  waitForLayout,
  waitForURL,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const OTHER_THREAD_ID = "thread-reading-position-other" as ThreadId;
const TARGET_MESSAGE_ID = "msg-user-reading-position" as MessageId;
/** A pixel or two of sub-pixel layout between two visits. */
const TOLERANCE_PX = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function distanceFromEnd(node: HTMLElement): number {
  return node.scrollHeight - node.clientHeight - node.scrollTop;
}

function rowTop(node: HTMLElement, rowId: string): number | null {
  const row = node.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`);
  return row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
}

async function waitForTranscript(): Promise<HTMLElement> {
  const row = await waitForElement(
    () => document.querySelector<HTMLElement>("[data-message-id]"),
    "Unable to find a timeline message row.",
  );
  const scroller = findScrollableAncestor(row);
  expect(scroller).not.toBeNull();
  return scroller!;
}

/** Records the largest distance `rowId` moves from `top` until `stop` is called. */
function watchRow(rowId: string, top: number) {
  let drift = 0;
  let frame = 0;
  const sample = () => {
    const row = document.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`);
    const scroller = row ? findScrollableAncestor(row) : null;
    const current = scroller ? rowTop(scroller, rowId) : null;
    if (current !== null) drift = Math.max(drift, Math.abs(current - top));
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  return {
    stop: () => cancelAnimationFrame(frame),
    drift: () => drift,
  };
}

/** Records whether the scroll-to-bottom pill shows at any moment until `stop` is called. */
function watchPill() {
  let seen = findScrollToBottomButton() !== null;
  const observer = new MutationObserver(() => {
    if (findScrollToBottomButton() !== null) seen = true;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    stop: () => observer.disconnect(),
    seen: () => seen,
  };
}

function readingPositionSnapshot() {
  return addThreadToSnapshot(
    createSnapshotForTargetUser({
      targetMessageId: TARGET_MESSAGE_ID,
      targetText: "reading position target",
    }),
    OTHER_THREAD_ID,
  );
}

async function openThread(
  mounted: Awaited<ReturnType<typeof mountChatView>>,
  threadId: ThreadId,
): Promise<void> {
  await mounted.router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId },
  });
  await waitForURL(
    mounted.router,
    (path) => path === serverThreadPath(threadId),
    `Thread ${threadId} should open.`,
  );
  await waitForComposerEditor();
}

describe("ChatView reading position (full app)", () => {
  setupChatViewBrowserSuite();

  it("reopens a thread where it was left, and holds it while the pill mounts and the composer grows", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: readingPositionSnapshot(),
    });
    try {
      const scroller = await waitForTranscript();
      await vi.waitFor(() => expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1));
      // Let the opened thread's own end pin settle, then read a third of the way down.
      await sleep(500);
      const target = Math.round((scroller.scrollHeight - scroller.clientHeight) / 3);
      await vi.waitFor(async () => {
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
        scroller.scrollTop = target;
        await waitForLayout();
        expect(Math.abs(scroller.scrollTop - target)).toBeLessThan(50);
        expect(readThreadReadingAnchor(THREAD_KEY)).not.toBeNull();
      });
      await waitForLayout();
      const anchor = readThreadReadingAnchor(THREAD_KEY)!;
      const left = rowTop(scroller, anchor.rowId);
      expect(left).not.toBeNull();

      await openThread(mounted, OTHER_THREAD_ID);
      await openThread(mounted, THREAD_ID);

      const reopened = await waitForTranscript();
      await vi.waitFor(
        () => {
          const top = rowTop(reopened, anchor.rowId);
          expect(top).not.toBeNull();
          expect(Math.abs(top! - left!)).toBeLessThanOrEqual(TOLERANCE_PX);
        },
        { timeout: 5_000 },
      );
      await vi.waitFor(() => expect(findScrollToBottomButton()).not.toBeNull());

      // The pill is up and the composer grows with a long draft: the row stays put.
      const watch = watchRow(anchor.rowId, left!);
      useComposerDraftStore
        .getState()
        .setPrompt(THREAD_REF, ["One", "Two", "Three", "Four", "Five", "Six"].join("\n"));
      await sleep(600);
      watch.stop();
      expect(watch.drift()).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(distanceFromEnd(reopened)).toBeGreaterThan(200);
      // Reopened away from the end, the thread does not follow live output: it
      // still remembers the row rather than its end.
      expect(readThreadReadingAnchor(THREAD_KEY)?.rowId).toBe(anchor.rowId);

      // The pill takes the thread back to its end, which it then remembers.
      findScrollToBottomButton()!.click();
      await vi.waitFor(() => {
        expect(distanceFromEnd(reopened)).toBeLessThanOrEqual(1);
        expect(readThreadReadingAnchor(THREAD_KEY)).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  // The real path: the thread is read with the wheel, the other one followed
  // at its end, and the reader comes back by a sidebar click. Wheels and
  // resizes that change nothing leave updates queued at their own priority,
  // which the click's render skips; the thread must still reopen at its row.
  it("reopens a thread where it was left after the other thread followed its end, from the sidebar", async () => {
    // The Inbox lists both threads.
    useUiStateStore.setState({ sidebarMode: "inbox" });
    const snapshot = readingPositionSnapshot();
    const otherThread = snapshot.threads.find((thread) => thread.id === OTHER_THREAD_ID)!;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: [
          ...snapshot.threads.filter((thread) => thread !== otherThread),
          {
            ...otherThread,
            messages: [
              createUserMessage({
                id: "msg-user-other-thread" as MessageId,
                text: "other thread message",
                offsetSeconds: 0,
              }),
            ],
          },
        ],
      },
    });
    try {
      const scroller = await waitForTranscript();
      await vi.waitFor(() => expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1));
      await sleep(500);
      // Read a third of the way down, wheeling up as a reader does: every
      // wheel turns live follow off, again and again.
      const target = Math.round((scroller.scrollHeight - scroller.clientHeight) / 3);
      await vi.waitFor(async () => {
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true }));
        scroller.scrollTop = target;
        await waitForLayout();
        expect(Math.abs(scroller.scrollTop - target)).toBeLessThan(50);
        expect(readThreadReadingAnchor(THREAD_KEY)).not.toBeNull();
      });
      for (let wheel = 0; wheel < 3; wheel += 1) {
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
      }
      await waitForLayout();
      const anchor = readThreadReadingAnchor(THREAD_KEY)!;
      const left = rowTop(scroller, anchor.rowId);
      expect(left).not.toBeNull();

      // The other thread opens at its end and keeps it while its composer
      // grows: each resize pins the end and turns live follow on, already on.
      await openThread(mounted, OTHER_THREAD_ID);
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-message-id="msg-user-other-thread"]'),
        "The other thread's message should show.",
      );
      for (const lines of [3, 6, 2, 5]) {
        useComposerDraftStore
          .getState()
          .setPrompt(
            threadRefFor(OTHER_THREAD_ID),
            Array.from({ length: lines }, (_, line) => `Line ${line + 1}`).join("\n"),
          );
        await sleep(150);
      }

      // Back through the sidebar: a click, rendered at its own priority.
      await page.getByTestId("inbox-thread-row").filter({ hasText: THREAD_TITLE }).click();
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        `Thread ${THREAD_ID} should open.`,
      );
      const reopened = await waitForTranscript();
      await vi.waitFor(
        () => {
          const top = rowTop(reopened, anchor.rowId);
          expect(top).not.toBeNull();
          expect(Math.abs(top! - left!)).toBeLessThanOrEqual(TOLERANCE_PX);
        },
        { timeout: 5_000 },
      );
      await sleep(600);
      expect(Math.abs(rowTop(reopened, anchor.rowId)! - left!)).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(distanceFromEnd(reopened)).toBeGreaterThan(200);
      expect(readThreadReadingAnchor(THREAD_KEY)?.rowId).toBe(anchor.rowId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens at the end, following, without the pill when the remembered row is gone", async () => {
    rememberThreadReadingAnchor(THREAD_KEY, {
      rowId: "msg-row-that-no-longer-exists",
      offsetWithinRow: 12,
    });
    // Watched from before the thread opens: the pill must not flash while the
    // timeline is still deciding.
    const pill = watchPill();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: readingPositionSnapshot(),
    });
    try {
      const scroller = await waitForTranscript();
      await vi.waitFor(() => {
        expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1);
        expect(readThreadReadingAnchor(THREAD_KEY)).toBeNull();
      });
      await sleep(400);
      pill.stop();
      expect(pill.seen()).toBe(false);
      expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1);
    } finally {
      pill.stop();
      await mounted.cleanup();
    }
  });

  it("opens the frozen phone tier at its end, as before reading positions", async () => {
    // A row that is there: a desktop window would reopen at it.
    rememberThreadReadingAnchor(THREAD_KEY, { rowId: TARGET_MESSAGE_ID, offsetWithinRow: 0 });
    const mounted = await mountChatView({
      viewport: NARROW_PHONE_VIEWPORT,
      snapshot: readingPositionSnapshot(),
    });
    try {
      const scroller = await waitForTranscript();
      await vi.waitFor(() => expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1));
      await sleep(400);
      expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1);
      expect(findScrollToBottomButton()).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
});
