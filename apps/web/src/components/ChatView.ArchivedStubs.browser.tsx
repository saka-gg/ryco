import { isArchivedThreadStub } from "@ryco/client-runtime/state/threads";
import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useSettingsDialogStore } from "../settingsDialogStore";
import { selectEnvironmentState, useStore } from "../store";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  THREAD_ID,
  addThreadToSnapshot,
  createSnapshotForTargetUser,
  mountChatView,
  setupChatViewBrowserSuite,
  waitForElement,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

setupChatViewBrowserSuite();

const OTHER_ARCHIVED_ID = ThreadId.make("thread-archived-other");
const OTHER_ARCHIVED_TITLE = "Archived release checklist";

/** The routed thread archived, plus a second archived thread nobody opens. */
function archivedSnapshot(): OrchestrationReadModel {
  const base = addThreadToSnapshot(
    createSnapshotForTargetUser({
      targetMessageId: "msg-user-archived-deep-link" as MessageId,
      targetText: "archived deep link text",
    }),
    OTHER_ARCHIVED_ID,
  );
  return {
    ...base,
    threads: base.threads.map((thread) =>
      thread.id === THREAD_ID
        ? { ...thread, archivedAt: NOW_ISO }
        : thread.id === OTHER_ARCHIVED_ID
          ? { ...thread, title: OTHER_ARCHIVED_TITLE, archivedAt: NOW_ISO, session: null }
          : thread,
    ),
  };
}

const shellEntry = (threadId: ThreadId) =>
  selectEnvironmentState(useStore.getState(), LOCAL_ENVIRONMENT_ID).threadShellById[threadId];

describe("archived thread stubs", () => {
  it("loads a deep-linked archived thread's full shell on demand, and only that one", async () => {
    await using _mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: archivedSnapshot(),
    });

    // The client asked for stubs and the shell listed both archived threads as stubs.
    const shellRequest = wsRequests.find(
      (request) => request._tag === ORCHESTRATION_WS_METHODS.subscribeShell,
    ) as { readonly archivedThreads?: string } | undefined;
    expect(shellRequest?.archivedThreads).toBe("stub");
    expect(isArchivedThreadStub(shellEntry(OTHER_ARCHIVED_ID))).toBe(true);

    // The routed one loads in full and renders its conversation.
    await vi.waitFor(() => {
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.getThreadShells &&
            (request as { readonly threadIds?: ReadonlyArray<string> }).threadIds?.includes(
              THREAD_ID,
            ),
        ),
      ).toBe(true);
    });
    // The full shell (and the thread window) replace the stub.
    await vi.waitFor(() => {
      expect(isArchivedThreadStub(shellEntry(THREAD_ID))).toBe(false);
      expect(shellEntry(THREAD_ID)?.archivedAt).toBe(NOW_ISO);
    });
    // The other archived thread was never asked for.
    expect(isArchivedThreadStub(shellEntry(OTHER_ARCHIVED_ID))).toBe(true);
  });

  it("lists archived stubs in the archive panel without loading them", async () => {
    await using _mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: archivedSnapshot(),
    });
    useSettingsDialogStore.getState().openSettings("archived");
    const row = await waitForElement(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>("h3")).find(
          (heading) => heading.textContent === OTHER_ARCHIVED_TITLE,
        ) ?? null,
      "Unable to find the archived stub's row in the archive panel.",
    );
    expect(row.closest("div")?.parentElement?.textContent).toContain("Unarchive");
    // Still a stub: listing it needed nothing a stub lacks.
    expect(isArchivedThreadStub(shellEntry(OTHER_ARCHIVED_ID))).toBe(true);
    expect(
      wsRequests.some(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.getThreadShells &&
          (request as { readonly threadIds?: ReadonlyArray<string> }).threadIds?.includes(
            OTHER_ARCHIVED_ID,
          ),
      ),
    ).toBe(false);
  });

  it("keeps full archived shells from a server that ignores the stub request", async () => {
    await using _mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: archivedSnapshot(),
      configureFixture: (next) => {
        next.serverIgnoresArchivedStubs = true;
      },
    });
    // The client still asks; the older server answers with full shells.
    const shellRequest = wsRequests.find(
      (request) => request._tag === ORCHESTRATION_WS_METHODS.subscribeShell,
    ) as { readonly archivedThreads?: string } | undefined;
    expect(shellRequest?.archivedThreads).toBe("stub");
    await vi.waitFor(() => {
      expect(shellEntry(OTHER_ARCHIVED_ID)?.archivedAt).toBe(NOW_ISO);
    });
    expect(isArchivedThreadStub(shellEntry(OTHER_ARCHIVED_ID))).toBe(false);
    expect(isArchivedThreadStub(shellEntry(THREAD_ID))).toBe(false);
    // Nothing is a stub, so nothing is loaded on demand.
    expect(
      wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.getThreadShells),
    ).toBe(false);
    // The archive panel lists the full archived shells as before.
    useSettingsDialogStore.getState().openSettings("archived");
    await waitForElement(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>("h3")).find(
          (heading) => heading.textContent === OTHER_ARCHIVED_TITLE,
        ) ?? null,
      "Unable to find the archived thread's row in the archive panel.",
    );
  });
});
