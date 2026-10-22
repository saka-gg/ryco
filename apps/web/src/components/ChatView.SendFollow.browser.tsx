import type { MessageId, OrchestrationReadModel } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../environmentApi";
import { useMessageQueueStore } from "../messageQueueStore";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_KEY,
  THREAD_REF,
  createSnapshotForTargetUser,
  findScrollToBottomButton,
  findScrollableAncestor,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerText,
  waitForElement,
  waitForLayout,
  waitForSendButton,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const SENT_TEXT = "follow the send";
/** How long the end has to stay in view (and the pill hidden) once reached. */
const SETTLE_MS = 300;

interface Command {
  readonly type: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records dispatched commands; a turn start is accepted, held until released, or rejected. */
function recordDispatch(
  snapshot: OrchestrationReadModel,
  turnStart: "accept" | "hold" | "reject" = "accept",
) {
  const commands: Command[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = readEnvironmentApi(LOCAL_ENVIRONMENT_ID)!;
  __setEnvironmentApiOverrideForTests(LOCAL_ENVIRONMENT_ID, {
    ...api,
    orchestration: {
      ...api.orchestration,
      dispatchCommand: async (command) => {
        commands.push(command as Command);
        if (command.type === "thread.turn.start") {
          if (turnStart === "reject") throw new Error("The node went away.");
          if (turnStart === "hold") await held;
        }
        return { sequence: snapshot.snapshotSequence + 1 };
      },
    },
  });
  return {
    release,
    turnStarts: () => commands.filter((command) => command.type === "thread.turn.start"),
  };
}

function composerPrompt(): string {
  return useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "";
}

function sentRowIsShown(): boolean {
  return Array.from(document.querySelectorAll("[data-message-id]")).some((row) =>
    row.textContent?.includes(SENT_TEXT),
  );
}

/** Records where the transcript was the moment the composer was cleared. */
function recordScrollAtClear(scroller: HTMLElement) {
  let scrollTopAtClear: number | null = null;
  const unsubscribe = useComposerDraftStore.subscribe((state) => {
    if (scrollTopAtClear !== null) return;
    if ((state.getComposerDraft(THREAD_REF)?.prompt ?? "") === "") {
      scrollTopAtClear = scroller.scrollTop;
    }
  });
  return {
    unsubscribe,
    scrollTopAtClear: () => scrollTopAtClear,
  };
}

/**
 * Checks for the scroll-to-bottom pill on every animation frame and on every
 * DOM mutation, so a flash between two samples is caught, not only its state
 * at the last one.
 */
function watchScrollToBottomPill() {
  let seen = false;
  let hidden = false;
  let seenAfterHidden = false;
  const check = () => {
    if (findScrollToBottomButton() === null) {
      hidden = true;
      return;
    }
    seen = true;
    if (hidden) seenAfterHidden = true;
  };
  let frame = 0;
  const onFrame = () => {
    check();
    frame = window.requestAnimationFrame(onFrame);
  };
  frame = window.requestAnimationFrame(onFrame);
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  check();
  return {
    stop: () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    },
    /** Whether the pill was seen at all. */
    seen: () => seen,
    /** Whether the pill came back after it had been hidden. */
    seenAfterHidden: () => seenAfterHidden,
  };
}

async function mountScrollableThread() {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-send-follow" as MessageId,
    targetText: "send follow target",
  });
  const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
  const timelineRow = await waitForElement(
    () => document.querySelector<HTMLElement>("[data-message-id]"),
    "Unable to find a timeline message row.",
  );
  const scroller = findScrollableAncestor(timelineRow);
  expect(scroller).not.toBeNull();
  const distanceFromEnd = () =>
    scroller!.scrollHeight - scroller!.clientHeight - scroller!.scrollTop;
  await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThanOrEqual(1));
  await waitForComposerEditor();
  return { mounted, snapshot, scroller: scroller!, distanceFromEnd };
}

/** Scrolls to the top and waits for the pill that says the end is out of view. */
async function scrollAwayFromEnd(scroller: HTMLElement) {
  // Let the opened thread's own end pin settle first: it would take the
  // transcript back to its end.
  await sleep(500);
  // The list keeps re-pinning to the end until its scroll handler observes
  // the user-initiated offset, so re-assert until the position sticks.
  await vi.waitFor(async () => {
    scroller.scrollTop = 0;
    await waitForLayout();
    expect(scroller.scrollTop).toBeLessThan(100);
  });
  await vi.waitFor(() => {
    expect(findScrollToBottomButton()).not.toBeNull();
    expect(scroller.scrollTop).toBeLessThan(100);
  });
}

async function prepareSend() {
  useComposerDraftStore.getState().setPrompt(THREAD_REF, SENT_TEXT);
  await waitForComposerText(SENT_TEXT);
  await waitForLayout();
  return waitForSendButton();
}

describe("ChatView follows the transcript's end on send (full app)", () => {
  setupChatViewBrowserSuite();

  it("clears the composer before the transcript scrolls to its end, then follows the end", async () => {
    const { mounted, snapshot, scroller, distanceFromEnd } = await mountScrollableThread();
    const dispatch = recordDispatch(snapshot);
    const clear = recordScrollAtClear(scroller);
    let pill: ReturnType<typeof watchScrollToBottomPill> | null = null;
    try {
      await scrollAwayFromEnd(scroller);
      const sendButton = await prepareSend();
      pill = watchScrollToBottomPill();
      sendButton.click();

      await vi.waitFor(() => expect(clear.scrollTopAtClear()).not.toBeNull());
      // The composer cleared while the transcript was still where the user left it.
      expect(clear.scrollTopAtClear()).toBeLessThan(100);
      await vi.waitFor(() => {
        expect(distanceFromEnd()).toBeLessThanOrEqual(1);
        expect(sentRowIsShown()).toBe(true);
      });
      await sleep(SETTLE_MS);
      expect(distanceFromEnd()).toBeLessThanOrEqual(1);
      expect(dispatch.turnStarts()).toHaveLength(1);
      // The send hid the pill shown while the end was out of view; it never came back.
      expect(findScrollToBottomButton()).toBeNull();
      expect(pill.seenAfterHidden()).toBe(false);
    } finally {
      pill?.stop();
      clear.unsubscribe();
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("follows the end for a send made at the end", async () => {
    const { mounted, snapshot, distanceFromEnd } = await mountScrollableThread();
    const dispatch = recordDispatch(snapshot);
    let pill: ReturnType<typeof watchScrollToBottomPill> | null = null;
    try {
      const sendButton = await prepareSend();
      expect(findScrollToBottomButton()).toBeNull();
      pill = watchScrollToBottomPill();
      sendButton.click();

      await vi.waitFor(() => {
        expect(sentRowIsShown()).toBe(true);
        expect(distanceFromEnd()).toBeLessThanOrEqual(1);
      });
      await sleep(SETTLE_MS);
      expect(distanceFromEnd()).toBeLessThanOrEqual(1);
      expect(dispatch.turnStarts()).toHaveLength(1);
      expect(composerPrompt()).toBe("");
      expect(pill.seen()).toBe(false);
    } finally {
      pill?.stop();
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("restores the draft when the send fails after the composer cleared", async () => {
    const { mounted, snapshot, scroller } = await mountScrollableThread();
    const dispatch = recordDispatch(snapshot, "reject");
    const clear = recordScrollAtClear(scroller);
    try {
      await scrollAwayFromEnd(scroller);
      (await prepareSend()).click();

      await vi.waitFor(() => expect(clear.scrollTopAtClear()).not.toBeNull());
      await vi.waitFor(() => {
        expect(composerPrompt()).toBe(SENT_TEXT);
        expect(sentRowIsShown()).toBe(false);
        expect(document.querySelector('[data-slot="toast-viewport"]')?.textContent ?? "").toContain(
          "The node went away.",
        );
      });
      expect(dispatch.turnStarts()).toHaveLength(1);
      // The send is over: the composer can send again.
      await vi.waitFor(() => {
        expect(document.querySelector('button[aria-label="Sending"]')).toBeNull();
        expect(
          document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled,
        ).toBe(false);
      });
    } finally {
      clear.unsubscribe();
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("ignores a submit while the first send's dispatch is held, as before, and follows the end", async () => {
    const { mounted, snapshot, scroller, distanceFromEnd } = await mountScrollableThread();
    const dispatch = recordDispatch(snapshot, "hold");
    const clear = recordScrollAtClear(scroller);
    try {
      await scrollAwayFromEnd(scroller);
      (await prepareSend()).click();
      await vi.waitFor(() => {
        expect(clear.scrollTopAtClear()).not.toBeNull();
        expect(sentRowIsShown()).toBe(true);
      });
      await vi.waitFor(() => expect(dispatch.turnStarts()).toHaveLength(1));

      // The send is in flight until its dispatch is accepted, not until the
      // transcript has scrolled: this submit is neither sent nor queued.
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "second");
      await waitForComposerText("second");
      const editor = await waitForComposerEditor();
      editor.focus();
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await waitForLayout();
      await sleep(100);
      expect(dispatch.turnStarts()).toHaveLength(1);
      expect(composerPrompt()).toBe("second");
      expect(useMessageQueueStore.getState().queuesByThreadKey[THREAD_KEY] ?? []).toEqual([]);

      dispatch.release();
      await vi.waitFor(() => {
        expect(sentRowIsShown()).toBe(true);
        expect(distanceFromEnd()).toBeLessThanOrEqual(1);
      });
      await waitForLayout();
      // Nothing replays the ignored submit.
      expect(dispatch.turnStarts()).toHaveLength(1);
      expect(composerPrompt()).toBe("second");
    } finally {
      dispatch.release();
      clear.unsubscribe();
      useMessageQueueStore.getState().clear(THREAD_KEY);
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });
});
