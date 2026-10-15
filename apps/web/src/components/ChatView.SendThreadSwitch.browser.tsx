import { ThreadId, type MessageId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  readEnvironmentApi,
} from "../environmentApi";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_ID,
  THREAD_REF,
  addThreadToSnapshot,
  createSnapshotForTargetUser,
  mountChatView,
  serverThreadPath,
  setupChatViewBrowserSuite,
  threadRefFor,
  waitForComposerEditor,
  waitForLayout,
  waitForSendButton,
  waitForURL,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/** A thread with no messages: its first send updates the title before its turn starts. */
const FIRST_THREAD_ID = ThreadId.make("thread-send-switch-first");

interface Command {
  readonly type: string;
  readonly threadId?: unknown;
}

/**
 * Holds the first-send title update of FIRST_THREAD_ID until released, so the
 * view can move to another thread while that send is still on its way.
 */
function holdFirstThreadSend(sequence: number) {
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
        const { type, threadId } = command as Command;
        if (type === "thread.meta.update" && threadId === FIRST_THREAD_ID) await held;
        return { sequence: sequence + 1 };
      },
    },
  });
  const turnStartsFor = (threadId: ThreadId) =>
    commands.filter(
      (command) => command.type === "thread.turn.start" && command.threadId === threadId,
    );
  return { commands, release, turnStartsFor };
}

async function mountOnFirstThread() {
  const snapshot = addThreadToSnapshot(
    createSnapshotForTargetUser({
      targetMessageId: "msg-user-send-switch" as MessageId,
      targetText: "send while switching",
    }),
    FIRST_THREAD_ID,
  );
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot,
    initialPath: serverThreadPath(FIRST_THREAD_ID),
  });
  return { mounted, snapshot };
}

async function sendFromFirstThreadThenOpenOther(
  mounted: Awaited<ReturnType<typeof mountChatView>>,
  sending: ReturnType<typeof holdFirstThreadSend>,
) {
  await waitForComposerEditor();
  useComposerDraftStore.getState().setPrompt(threadRefFor(FIRST_THREAD_ID), "send from the first");
  await waitForLayout();
  (await waitForSendButton()).click();
  await vi.waitFor(() =>
    expect(sending.commands.some((command) => command.type === "thread.meta.update")).toBe(true),
  );
  await mounted.router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: THREAD_ID },
  });
  await waitForURL(
    mounted.router,
    (path) => path === serverThreadPath(THREAD_ID),
    "The other thread should open.",
  );
  await waitForComposerEditor();
}

async function sendFromOtherThread() {
  useComposerDraftStore.getState().setPrompt(THREAD_REF, "send from the other");
  await waitForLayout();
  (await waitForSendButton()).click();
}

describe("ChatView sends across a thread switch (full app)", () => {
  setupChatViewBrowserSuite();

  it("lets the thread opened next send while the previous thread's send is in flight", async () => {
    const { mounted, snapshot } = await mountOnFirstThread();
    const sending = holdFirstThreadSend(snapshot.snapshotSequence);
    try {
      await sendFromFirstThreadThenOpenOther(mounted, sending);
      await sendFromOtherThread();
      await vi.waitFor(() => expect(sending.turnStartsFor(THREAD_ID)).toHaveLength(1));
    } finally {
      sending.release();
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("still shows a thread sending when the view comes back to it mid-send", async () => {
    const { mounted, snapshot } = await mountOnFirstThread();
    const sending = holdFirstThreadSend(snapshot.snapshotSequence);
    const sendingButton = () => document.querySelector('button[aria-label="Sending"]');
    try {
      await sendFromFirstThreadThenOpenOther(mounted, sending);
      expect(sendingButton()).toBeNull();

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: FIRST_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(FIRST_THREAD_ID),
        "The first thread should open again.",
      );
      await vi.waitFor(() => expect(sendingButton()).not.toBeNull());
    } finally {
      sending.release();
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });

  it("never leaves the thread opened next busy once the previous thread's send goes out", async () => {
    const { mounted, snapshot } = await mountOnFirstThread();
    const sending = holdFirstThreadSend(snapshot.snapshotSequence);
    try {
      await sendFromFirstThreadThenOpenOther(mounted, sending);
      // The first thread's send resumes on the other thread's view and starts its turn.
      sending.release();
      await vi.waitFor(() => expect(sending.turnStartsFor(FIRST_THREAD_ID)).toHaveLength(1));
      await waitForLayout();

      await sendFromOtherThread();
      await vi.waitFor(() => expect(sending.turnStartsFor(THREAD_ID)).toHaveLength(1));
      // Its turn went to its own thread, and the other draft was never touched.
      expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt ?? "").toBe("");
    } finally {
      __resetEnvironmentApiOverridesForTests();
      await mounted.cleanup();
    }
  });
});
