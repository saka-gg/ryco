import { ThreadId, type MessageId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { LazySideChatPanel } from "./chat/chatViewLazySurfaces";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  addThreadToSnapshot,
  createSnapshotForTargetUser,
  mountChatView,
  serverThreadPath,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForLayout,
  waitForURL,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const THREAD_COUNT = 8;
const SWITCH_THREAD_IDS = Array.from({ length: THREAD_COUNT }, (_, index) =>
  ThreadId.make(`thread-listener-switch-${index}`),
);

type ListenerOptions = boolean | EventListenerOptions | undefined;

/**
 * Counts the listeners registered on `target` that are still attached, the way
 * the DOM identifies them: by type, listener and capture flag.
 */
function trackListeners(target: Document | Window) {
  const live = new Set<string>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const idOf = (listener: object) => {
    let id = ids.get(listener);
    if (id === undefined) ids.set(listener, (id = ++nextId));
    return id;
  };
  const keyOf = (type: string, listener: unknown, options: ListenerOptions) => {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    return `${type}:${idOf(listener as object)}:${capture}`;
  };
  const add = vi.spyOn(target, "addEventListener");
  const remove = vi.spyOn(target, "removeEventListener");
  add.mockImplementation(function (this: EventTarget, type, listener, options) {
    if (listener) live.add(keyOf(type, listener, options));
    return EventTarget.prototype.addEventListener.call(this, type, listener, options);
  });
  remove.mockImplementation(function (this: EventTarget, type, listener, options) {
    if (listener) live.delete(keyOf(type, listener, options));
    return EventTarget.prototype.removeEventListener.call(this, type, listener, options);
  });
  return {
    count: () => live.size,
    restore: () => {
      add.mockRestore();
      remove.mockRestore();
    },
  };
}

describe("ChatView thread switches release per-thread document listeners (full app)", () => {
  setupChatViewBrowserSuite();

  it("keeps the document and window listener counts flat across thread switches", async () => {
    // The side chat panel is idle-preloaded in the app; once its chunk is in,
    // it renders on every desktop thread next to the selection toolbar.
    await LazySideChatPanel.preload();
    expect(LazySideChatPanel.isLoaded()).toBe(true);

    let snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-listener-switch" as MessageId,
      targetText: "listener switch",
    });
    for (const threadId of SWITCH_THREAD_IDS) snapshot = addThreadToSnapshot(snapshot, threadId);

    const duplicateKeyWarnings: unknown[][] = [];
    const originalError = console.error.bind(console);
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes("two children with the same key")) {
        duplicateKeyWarnings.push(args);
        return;
      }
      originalError(...args);
    });
    const documentListeners = trackListeners(document);
    const windowListeners = trackListeners(window);
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      initialPath: serverThreadPath(SWITCH_THREAD_IDS[0]!),
    });
    const open = async (threadId: ThreadId) => {
      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(threadId),
        "The thread should open.",
      );
      await waitForComposerEditor();
      await waitForLayout();
    };
    try {
      await waitForComposerEditor();
      // Visit every thread once so lazily mounted, app-lifetime listeners are
      // in place before the baseline is taken.
      for (const threadId of SWITCH_THREAD_IDS) await open(threadId);
      await open(SWITCH_THREAD_IDS[0]!);
      const baseline = {
        document: documentListeners.count(),
        window: windowListeners.count(),
      };

      for (let round = 0; round < 2; round += 1) {
        for (const threadId of [...SWITCH_THREAD_IDS.slice(1), SWITCH_THREAD_IDS[0]!]) {
          await open(threadId);
        }
      }

      // A leaked per-thread scope keeps its listeners on the document: the
      // count must come back exactly. Window listeners are re-registered by
      // app-level effects during a switch; they must not grow with switches.
      expect(documentListeners.count()).toBe(baseline.document);
      expect(windowListeners.count()).toBeLessThanOrEqual(baseline.window + 2);
      expect(duplicateKeyWarnings).toEqual([]);
    } finally {
      documentListeners.restore();
      windowListeners.restore();
      consoleError.mockRestore();
      await mounted.cleanup();
    }
  });
});
