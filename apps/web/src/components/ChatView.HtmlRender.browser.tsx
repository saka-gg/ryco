import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  type MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotError,
  type OrchestrationReadModel,
  OrchestrationThreadHistoryError,
  type ThreadId,
  type TurnId,
  WS_METHODS,
} from "@ryco/contracts";
import { wsConnectionOpenedCountAtom } from "@ryco/client-runtime/rpc";
import { injectHtmlRenderBootstrap } from "@ryco/shared/htmlRender";
import { page, userEvent } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WsRpcFailure, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { selectThreadByRef, useStore } from "../store";
import {
  LOCAL_ENVIRONMENT_ID,
  PHONE_VIEWPORT,
  THREAD_ID,
  WIDE_FOOTER_VIEWPORT,
  addThreadToSnapshot,
  createSnapshotForTargetUser,
  isoAt,
  mountChatView,
  serverThreadPath,
  setupChatViewBrowserSuite,
  waitForURL,
  wsRequests,
} from "./ChatView.browser.helpers";
import { __resetHtmlRenderSourceCacheForTests } from "./chat/useHtmlRenderSource";
import { __resetWorkspaceHtmlRenderLookupForTests } from "./chat/useWorkspaceHtmlRender";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const TURN_ID = "turn-html-render" as TurnId;
const RENDER_MESSAGE_ID = "msg-html-render" as MessageId;
const ATTACHMENT_ID = "thread-browser-test-chart-html";
const OTHER_THREAD_ID = "thread-html-render-other" as ThreadId;
const TITLE = "Quarterly chart";
const PAGE = injectHtmlRenderBootstrap(
  `<!doctype html><html><head></head><body><h1 id="chart">${TITLE}</h1></body></html>`,
);
const PAGE_BYTES = new TextEncoder().encode(PAGE);
// One thumbnail per appearance, told apart by their bytes.
const DARK_THUMBNAIL = "data:image/png;base64,ZGFyaw==";
const LIGHT_THUMBNAIL = "data:image/png;base64,bGlnaHQ=";
// A page from further back than the thread's loaded window.
const OLDER_MESSAGE_ID = "msg-html-render-older" as MessageId;
const OLDER_ATTACHMENT_ID = "thread-browser-test-older-chart-html";
const OLDER_RENDER_KEY = `${OLDER_MESSAGE_ID}:${OLDER_ATTACHMENT_ID}`;

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return btoa(binary);
}

/** The test thread, ending with a turn that published a page and then replied. */
function snapshotWithRender(): OrchestrationReadModel {
  const base = addThreadToSnapshot(
    createSnapshotForTargetUser({
      targetMessageId: "msg-user-html-render-target" as MessageId,
      targetText: "html render target",
    }),
    OTHER_THREAD_ID,
  );
  const turnMessages = [
    {
      id: "msg-user-html-render" as MessageId,
      role: "user" as const,
      text: "Chart revenue",
      turnId: null,
      streaming: false,
      createdAt: isoAt(300),
      updatedAt: isoAt(300),
    },
    {
      id: RENDER_MESSAGE_ID,
      role: "assistant" as const,
      text: " ",
      attachments: [
        {
          type: "file" as const,
          id: ATTACHMENT_ID,
          name: `${TITLE}.html`,
          mimeType: "text/html",
          sizeBytes: PAGE_BYTES.length,
          htmlRender: {
            title: TITLE,
            height: 240,
            thumbnails: { dark: DARK_THUMBNAIL, light: LIGHT_THUMBNAIL },
          },
        },
      ],
      turnId: TURN_ID,
      streaming: false,
      createdAt: isoAt(303),
      updatedAt: isoAt(303),
    },
    {
      id: "msg-html-render-reply" as MessageId,
      role: "assistant" as const,
      text: "Revenue doubled.",
      turnId: TURN_ID,
      streaming: false,
      createdAt: isoAt(305),
      updatedAt: isoAt(306),
    },
  ];
  return {
    ...base,
    threads: base.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, { messages: [...thread.messages, ...turnMessages] })
        : thread,
    ),
  };
}

/** Serves the page over the attachment chunk RPC, as a server does. */
function resolveAttachmentChunks(body: { _tag: string; [key: string]: unknown }) {
  if (body._tag !== WS_METHODS.chatAttachmentsReadChunk) return undefined;
  if (body.attachmentId !== ATTACHMENT_ID && body.attachmentId !== OLDER_ATTACHMENT_ID) {
    return undefined;
  }
  const offset = Number(body.offset);
  return {
    offset,
    totalBytes: PAGE_BYTES.length,
    dataBase64: base64(PAGE_BYTES.subarray(offset, offset + CHAT_ATTACHMENT_READ_CHUNK_BYTES)),
  };
}

const panel = () => document.querySelector<HTMLElement>("[data-html-render-panel]");
const panelFrame = () => panel()?.querySelector<HTMLIFrameElement>("iframe") ?? null;

async function mountRenderThread(
  options: {
    viewport?: typeof PHONE_VIEWPORT;
    path?: string;
    /** The thread's window holds its latest messages only; this answers the rest. */
    resolveOlderMessage?: (body: NormalizedWsRpcRequestBody) => unknown;
  } = {},
) {
  const { resolveOlderMessage } = options;
  return mountChatView({
    viewport: options.viewport ?? WIDE_FOOTER_VIEWPORT,
    snapshot: snapshotWithRender(),
    resolveRpc: (body) =>
      resolveOlderMessage && body._tag === ORCHESTRATION_WS_METHODS.getThreadHistoryPage
        ? resolveOlderMessage(body)
        : resolveAttachmentChunks(body),
    ...(resolveOlderMessage
      ? {
          configureFixture: (fixture) => {
            fixture.threadsWithOlderMessages = new Set([THREAD_ID]);
          },
        }
      : {}),
    ...(options.path ? { initialPath: options.path } : {}),
  });
}

/** The older page's message, as the environment's history holds it. */
function olderMessagePage() {
  return {
    collection: "messages",
    snapshotSequence: 1,
    items: [
      {
        id: OLDER_MESSAGE_ID,
        role: "assistant",
        text: " ",
        attachments: [
          {
            type: "file",
            id: OLDER_ATTACHMENT_ID,
            name: `${TITLE}.html`,
            mimeType: "text/html",
            sizeBytes: PAGE_BYTES.length,
            htmlRender: { title: TITLE, height: 240 },
          },
        ],
        turnId: null,
        streaming: false,
        createdAt: isoAt(10),
        updatedAt: isoAt(10),
      },
    ],
    page: { oldestCursor: null, newestCursor: null, hasMoreBefore: true },
  };
}

const pageTabPath = (renderKey: string) =>
  `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}?workspaceOpen=1&workspaceTab=render&workspaceRender=${renderKey}`;

const requestsOf = (tag: string) => wsRequests.filter((request) => request._tag === tag);

/** Shows another thread, then this one again: the page tab is restored. */
async function switchThreadAndBack(mounted: Awaited<ReturnType<typeof mountRenderThread>>) {
  await mounted.router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: OTHER_THREAD_ID },
  });
  await waitForURL(
    mounted.router,
    (path) => path === serverThreadPath(OTHER_THREAD_ID),
    "The other thread should open.",
  );
  await mounted.router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: THREAD_ID },
  });
  await waitForURL(
    mounted.router,
    (path) => path === serverThreadPath(THREAD_ID),
    "The thread should open again.",
  );
}

/** The thread as the store holds it: never widened by a page tab's lookup. */
function storedMessageIds() {
  return (
    selectThreadByRef(useStore.getState(), {
      environmentId: LOCAL_ENVIRONMENT_ID,
      threadId: THREAD_ID,
    })?.messages.map((message) => message.id) ?? []
  );
}

async function waitForInlinePage() {
  await vi.waitFor(
    () =>
      expect(
        document
          .querySelector('[data-timeline-row-kind="html-render"] iframe')
          ?.getAttribute("srcdoc"),
      ).toBe(PAGE),
    { timeout: 10_000 },
  );
}

async function expectPageInPanel(mounted: Awaited<ReturnType<typeof mountRenderThread>>) {
  await vi.waitFor(() => expect(panelFrame()?.srcdoc).toBe(PAGE), { timeout: 10_000 });
  const frame = panelFrame()!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  expect(frame.title).toBe(TITLE);
  expect(mounted.router.state.location.search).toMatchObject({
    workspaceOpen: "1",
    workspaceTab: "render",
    workspaceRender: `${RENDER_MESSAGE_ID}:${ATTACHMENT_ID}`,
  });
  // The page tab is named after the page, and it is the selected tab.
  await expect.element(page.getByRole("tab", { name: TITLE, selected: true })).toBeVisible();
  // The workspace panel is not a dialog.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}

describe("ChatView HTML renders (full app)", () => {
  setupChatViewBrowserSuite();

  beforeEach(() => {
    __resetHtmlRenderSourceCacheForTests();
    __resetWorkspaceHtmlRenderLookupForTests();
  });

  it("opens a page in the workspace panel from its expand button, with source and download", async () => {
    const mounted = await mountRenderThread();
    try {
      await waitForInlinePage();
      await page.getByRole("button", { name: "Open full size" }).click();
      await expectPageInPanel(mounted);

      // Escape belongs to the page in a tab; it never closes the panel.
      await userEvent.click(panelFrame()!);
      await userEvent.keyboard("{Escape}");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(panelFrame()).not.toBeNull();
      expect(mounted.router.state.location.search).toMatchObject({ workspaceTab: "render" });

      const tabPanel = page.getByRole("tabpanel");
      await tabPanel.getByRole("button", { name: "Source" }).click();
      const source = panel()!.querySelector("pre")!;
      expect(source.textContent).toContain(`<h1 id="chart">${TITLE}</h1>`);
      // The agent's own markup, without the bootstrap Ryco injected.
      expect(source.textContent).not.toContain("ryco-theme");
      expect(source.querySelector("h1, script")).toBeNull();
      await tabPanel.getByRole("button", { name: "Source" }).click();
      expect(panel()!.querySelector("pre")).toBeNull();

      const createObjectURL = vi.spyOn(URL, "createObjectURL");
      const downloads: Array<{ download: string; href: string }> = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        function (this: HTMLAnchorElement) {
          downloads.push({ download: this.download, href: this.href });
        },
      );
      try {
        await tabPanel.getByRole("button", { name: "Download" }).click();
        expect(downloads).toEqual([
          { download: `${TITLE}.html`, href: expect.stringMatching(/^blob:/) },
        ]);
        const blob = createObjectURL.mock.calls.at(-1)![0] as Blob;
        expect(blob.type).toBe("application/octet-stream");
        expect(await blob.text()).toBe(PAGE);
      } finally {
        vi.restoreAllMocks();
      }

      // Closing the page tab leaves the page in the thread.
      await page.getByRole("button", { name: `Close ${TITLE} tab` }).click();
      await vi.waitFor(() => expect(panel()).toBeNull());
      expect(mounted.router.state.location.search).not.toMatchObject({ workspaceTab: "render" });
      await waitForInlinePage();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a page from its reply card and keeps the tab across a thread switch", async () => {
    const mounted = await mountRenderThread();
    try {
      await waitForInlinePage();
      const card = page.getByRole("button", { name: `Open ${TITLE}` });
      await expect.element(card).toBeVisible();
      // The card shows the thumbnail of the app's appearance.
      const image = card.element().querySelector("img")!;
      expect(image.getAttribute("src")).toBe(
        document.documentElement.classList.contains("dark") ? DARK_THUMBNAIL : LIGHT_THUMBNAIL,
      );
      await card.click();
      await expectPageInPanel(mounted);

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: OTHER_THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(OTHER_THREAD_ID),
        "The other thread should open.",
      );
      await vi.waitFor(() => expect(panel()).toBeNull());

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: THREAD_ID },
      });
      // Coming back restores the page tab with its page.
      await expectPageInPanel(mounted);
    } finally {
      await mounted.cleanup();
    }
  });

  it("says quietly that a page is gone when its message is", async () => {
    const mounted = await mountRenderThread({
      path: pageTabPath(`msg-removed:${ATTACHMENT_ID}`),
    });
    try {
      await vi.waitFor(
        () => expect(document.body.textContent).toContain("This page is no longer available"),
        { timeout: 10_000 },
      );
      await expect.element(page.getByText("This page is no longer available")).toBeVisible();
      expect(document.querySelector("[data-html-render-panel]")).toBeNull();
      // Its tab falls back to a plain name.
      await expect.element(page.getByRole("tab", { name: "Page" })).toBeVisible();
      // The whole thread is loaded, so there is nothing to look up.
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a page from further back on its own, leaving the thread's window as it is", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const mounted = await mountRenderThread({
      path: pageTabPath(OLDER_RENDER_KEY),
      resolveOlderMessage: () => answered.then(olderMessagePage),
    });
    try {
      // Looking it up: a quiet busy panel, never a verdict.
      await vi.waitFor(
        () => expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toHaveLength(1),
        { timeout: 10_000 },
      );
      const tabPanel = page.getByRole("tabpanel");
      expect(tabPanel.element().querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(document.body.textContent).not.toContain("This page is no longer available");
      // Just the page's message.
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)[0]).toMatchObject({
        threadId: THREAD_ID,
        collection: "messages",
        mode: { kind: "around", anchorId: OLDER_MESSAGE_ID },
        limit: 1,
      });

      answer();
      await vi.waitFor(() => expect(panelFrame()?.srcdoc).toBe(PAGE), { timeout: 10_000 });
      expect(panelFrame()!.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      await expect.element(page.getByRole("tab", { name: TITLE, selected: true })).toBeVisible();
      // The thread's window is untouched: no older message, no re-snapshot.
      expect(storedMessageIds()).not.toContain(OLDER_MESSAGE_ID);
      expect(storedMessageIds()).toContain(RENDER_MESSAGE_ID);
      expect(document.querySelectorAll('[data-timeline-row-kind="html-render"]')).toHaveLength(1);
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadWindow)).toEqual([]);

      // Coming back to the thread shows it again without asking again.
      await switchThreadAndBack(mounted);
      await vi.waitFor(() => expect(panelFrame()?.srcdoc).toBe(PAGE), { timeout: 10_000 });
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("asks once about a page from further back that is gone, and never reloads the thread", async () => {
    const mounted = await mountRenderThread({
      path: pageTabPath(OLDER_RENDER_KEY),
      resolveOlderMessage: () =>
        new WsRpcFailure(
          new OrchestrationThreadHistoryError({
            reason: "stale-cursor",
            threadId: THREAD_ID,
            collection: "messages",
          }),
        ),
    });
    try {
      await vi.waitFor(
        () => expect(document.body.textContent).toContain("This page is no longer available"),
        { timeout: 10_000 },
      );
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toHaveLength(1);
      // A missing message never sends the thread back to a fresh window.
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadWindow)).toEqual([]);

      await switchThreadAndBack(mounted);
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("This page is no longer available"),
      );
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toHaveLength(1);
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadWindow)).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers a retry, not a verdict, when looking up a page from further back fails", async () => {
    let fail = true;
    const mounted = await mountRenderThread({
      path: pageTabPath(OLDER_RENDER_KEY),
      resolveOlderMessage: () =>
        fail
          ? new WsRpcFailure(new OrchestrationGetSnapshotError({ message: "database is locked" }))
          : olderMessagePage(),
    });
    try {
      await expect
        .element(page.getByText("Unable to find this page"), { timeout: 10_000 })
        .toBeVisible();
      expect(document.body.textContent).not.toContain("This page is no longer available");
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toHaveLength(1);

      // A socket opening (a reconnect) asks again by itself.
      appAtomRegistry.set(
        wsConnectionOpenedCountAtom,
        appAtomRegistry.get(wsConnectionOpenedCountAtom) + 1,
      );
      await vi.waitFor(() =>
        expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toHaveLength(2),
      );
      await expect.element(page.getByText("Unable to find this page")).toBeVisible();

      // So does Retry.
      fail = false;
      await page.getByRole("tabpanel").getByRole("button", { name: "Retry" }).click();
      await vi.waitFor(() => expect(panelFrame()?.srcdoc).toBe(PAGE), { timeout: 10_000 });
      expect(requestsOf(ORCHESTRATION_WS_METHODS.getThreadHistoryPage)).toHaveLength(3);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a page in a dialog on the phone tier, which has no page tab", async () => {
    const mounted = await mountRenderThread({ viewport: PHONE_VIEWPORT });
    try {
      await waitForInlinePage();
      await page.getByRole("button", { name: `Open ${TITLE}` }).click();
      const dialog = page.getByRole("dialog");
      await expect.element(dialog).toBeVisible();
      await vi.waitFor(() => expect(dialog.element().querySelector("iframe")?.srcdoc).toBe(PAGE));
      expect(dialog.element().querySelector("iframe")!.getAttribute("sandbox")).toBe(
        "allow-scripts allow-forms",
      );
      expect(mounted.router.state.location.search).not.toMatchObject({ workspaceTab: "render" });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
