import { WS_METHODS, type MessageId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_VIEWPORT,
  THREAD_ID,
  createSnapshotForTargetUser,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForServerConfigToApply,
  wsRequests,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const prewarmRequests = () =>
  wsRequests.filter((request) => request._tag === WS_METHODS.providerPrewarmSession);

async function mountWithStoppedSession(input: { readonly advertised: boolean }) {
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot: createSnapshotForTargetUser({
      targetMessageId: "msg-user-prewarm" as MessageId,
      targetText: "prewarm target",
      sessionStatus: "stopped",
    }),
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
      // is sent before that, so a retry cannot send twice.
      await vi.waitFor(() => {
        editor.blur();
        editor.focus();
        expect(prewarmRequests()).toHaveLength(1);
      });
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
});
