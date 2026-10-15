import { ThreadId, WS_METHODS, type MessageId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_ID,
  addThreadToSnapshot,
  createSnapshotForTargetUser,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForServerConfigToApply,
  waitForURL,
  serverThreadPath,
  wsRequests,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const prewarmRequests = () =>
  wsRequests.filter((request) => request._tag === WS_METHODS.providerPrewarmSession);

const PASSED_THREAD_ID = ThreadId.make("thread-prewarm-passed");
const DWELLED_THREAD_ID = ThreadId.make("thread-prewarm-dwelled");

async function mountWithStoppedSession(input: {
  readonly advertised: boolean;
  /** More threads whose sessions are stopped too. */
  readonly otherThreadIds?: ReadonlyArray<ThreadId>;
}) {
  let snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-prewarm" as MessageId,
    targetText: "prewarm target",
    sessionStatus: "stopped",
  });
  for (const threadId of input.otherThreadIds ?? []) {
    snapshot = addThreadToSnapshot(snapshot, threadId);
    snapshot = {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === threadId && thread.session
          ? { ...thread, session: { ...thread.session, status: "stopped" } }
          : thread,
      ),
    };
  }
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot,
    configureFixture: (fixture) => {
      if (!input.advertised) return;
      fixture.serverConfig = {
        ...fixture.serverConfig,
        environment: {
          ...fixture.serverConfig.environment,
          capabilities: {
            ...fixture.serverConfig.environment.capabilities,
            providerSessionPrewarm: true,
          },
        },
      };
    },
    resolveRpc: (body) =>
      body._tag === WS_METHODS.providerPrewarmSession ? { status: "started" } : undefined,
  });
  await waitForServerConfigToApply();
  return mounted;
}

describe("ChatView provider session prewarm (full app)", () => {
  setupChatViewBrowserSuite();

  it("asks the node to start the thread's session once when the composer gains focus", async () => {
    const mounted = await mountWithStoppedSession({ advertised: true });
    try {
      const editor = await waitForComposerEditor();
      // Focus again until the pushed server config (with the capability) has applied: nothing
      // is sent before that, so a retry cannot send twice. Each focus is only asked for once
      // it has dwelled on the thread.
      await vi.waitFor(
        () => {
          editor.blur();
          editor.focus();
          expect(prewarmRequests()).toHaveLength(1);
        },
        { timeout: 5_000 },
      );
      expect(prewarmRequests()[0]).toMatchObject({ threadId: THREAD_ID });
      // A keystroke right after focus does not ask again.
      await page.getByTestId("composer-editor").fill("hello");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(prewarmRequests()).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("never calls a node that does not advertise prewarm", async () => {
    const mounted = await mountWithStoppedSession({ advertised: false });
    try {
      const editor = await waitForComposerEditor();
      await new Promise((resolve) => setTimeout(resolve, 500));
      editor.focus();
      await page.getByTestId("composer-editor").fill("hello");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(prewarmRequests()).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("asks only once focus dwells on a thread, never for threads passed through", async () => {
    const mounted = await mountWithStoppedSession({
      advertised: true,
      otherThreadIds: [PASSED_THREAD_ID, DWELLED_THREAD_ID],
    });
    const open = async (threadId: ThreadId) => {
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(threadId),
        `Thread ${threadId} should open.`,
      );
      // As after a click in the sidebar: focus comes back to the composer.
      const editor = await waitForComposerEditor();
      editor.blur();
      editor.focus();
    };
    try {
      const editor = await waitForComposerEditor();
      // The capability has applied once the first thread's dwell asks.
      await vi.waitFor(
        () => {
          editor.blur();
          editor.focus();
          expect(prewarmRequests()).toHaveLength(1);
        },
        { timeout: 5_000 },
      );

      // Passing through a thread on the way to another asks nothing for it.
      await open(PASSED_THREAD_ID);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await open(DWELLED_THREAD_ID);
      await vi.waitFor(() => expect(prewarmRequests()).toHaveLength(2), { timeout: 3_000 });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(prewarmRequests().map((request) => request.threadId)).toEqual([
        THREAD_ID,
        DWELLED_THREAD_ID,
      ]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("asks nothing for a focus that leaves the composer before it dwelled", async () => {
    const mounted = await mountWithStoppedSession({
      advertised: true,
      otherThreadIds: [PASSED_THREAD_ID],
    });
    try {
      const editor = await waitForComposerEditor();
      // The capability has applied once the first thread's dwell asks.
      await vi.waitFor(
        () => {
          editor.blur();
          editor.focus();
          expect(prewarmRequests()).toHaveLength(1);
        },
        { timeout: 5_000 },
      );

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: PASSED_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(PASSED_THREAD_ID),
        `Thread ${PASSED_THREAD_ID} should open.`,
      );
      const nextEditor = await waitForComposerEditor();
      // Past the switch's own focus of the composer, which lands a frame after the commit.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Focus comes back to the composer on this thread...
      nextEditor.blur();
      nextEditor.focus();
      // ...and the user clicks away at once.
      nextEditor.blur();
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(prewarmRequests()).toHaveLength(1);

      // Focus that stays still asks.
      nextEditor.focus();
      await vi.waitFor(() => expect(prewarmRequests()).toHaveLength(2), { timeout: 3_000 });
      expect(prewarmRequests()[1]).toMatchObject({ threadId: PASSED_THREAD_ID });
    } finally {
      await mounted.cleanup();
    }
  });
});
