import "../../index.css";

import {
  type EnvironmentApi,
  EnvironmentId,
  MessageId,
  OrchestrationThreadHistoryCursor,
  ThreadId,
  TurnId,
  type OrchestrationGetThreadHistoryPageInput,
  type OrchestrationThreadHistoryPage,
  type OrchestrationThreadHistoryPageInfo,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { selectEnvironmentState, useStore } from "../../store";
import type { ChatAttachment, ChatMessage } from "../../types";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { __resetEarlierThreadArtifactsForTests } from "./useEarlierThreadArtifacts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-artifacts");
const TURN_ID = TurnId.make("turn-1");

const historyReads = { pages: [] as unknown[], calls: [] as unknown[] };
function installHistoryReads() {
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    orchestration: {
      getThreadHistoryPage: async (input: unknown) => {
        historyReads.calls.push(input);
        return historyReads.pages.shift();
      },
    },
  } as unknown as EnvironmentApi);
}
const THUMBNAIL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const NO_MORE: OrchestrationThreadHistoryPageInfo = {
  oldestCursor: null,
  newestCursor: null,
  hasMoreBefore: false,
};

const pageAttachment = (id: string, title: string): ChatAttachment => ({
  type: "file",
  id,
  name: `${id}.html`,
  mimeType: "text/html",
  sizeBytes: 2048,
  htmlRender: { title, height: 400, thumbnails: { dark: THUMBNAIL, light: THUMBNAIL } },
});

const message = (
  id: string,
  second: number,
  attachments: ChatAttachment[] | undefined,
  role: ChatMessage["role"] = "assistant",
): ChatMessage => ({
  id: MessageId.make(id),
  role,
  text: "",
  turnId: TURN_ID,
  createdAt: `2026-10-16T12:00:${String(second).padStart(2, "0")}.000Z`,
  streaming: false,
  ...(attachments ? { attachments } : {}),
});

function seedHistory(messages: OrchestrationThreadHistoryPageInfo) {
  useStore.setState((state) => ({
    environmentStateById: {
      ...state.environmentStateById,
      [ENVIRONMENT_ID]: {
        ...selectEnvironmentState(state, ENVIRONMENT_ID),
        threadHistoryByThreadId: {
          [THREAD_ID]: {
            messages,
            proposedPlans: NO_MORE,
            activities: NO_MORE,
            checkpoints: NO_MORE,
          },
        },
      },
    },
  }));
}

function historyPage(
  messages: ReadonlyArray<ChatMessage>,
  oldestCursor: string | null,
): OrchestrationThreadHistoryPage {
  return {
    collection: "messages",
    snapshotSequence: 1,
    items: messages.map((item) => ({ ...item, updatedAt: item.createdAt })),
    page: {
      oldestCursor: oldestCursor ? OrchestrationThreadHistoryCursor.make(oldestCursor) : null,
      newestCursor: null,
      hasMoreBefore: oldestCursor !== null,
    },
  } as unknown as OrchestrationThreadHistoryPage;
}

describe("ArtifactsPanel", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    historyReads.pages = [];
    historyReads.calls = [];
    __resetEarlierThreadArtifactsForTests();
    __resetEnvironmentApiOverridesForTests();
    useStore.setState({ environmentStateById: {} });
    document.body.innerHTML = "";
  });

  async function mount(messages: ReadonlyArray<ChatMessage>) {
    installHistoryReads();
    const onOpenPage = vi.fn();
    const onShowInThread = vi.fn();
    const onOpenThread = vi.fn();
    const host = document.createElement("div");
    host.style.width = "480px";
    host.style.height = "640px";
    host.style.display = "flex";
    document.body.append(host);
    mounted = await render(
      <ArtifactsPanel
        environmentId={ENVIRONMENT_ID}
        threadId={THREAD_ID}
        messages={messages}
        onOpenPage={onOpenPage}
        onShowInThread={onShowInThread}
        onOpenThread={onOpenThread}
      />,
      { container: host },
    );
    return { onOpenPage, onShowInThread, onOpenThread };
  }

  it("lists the agent's pages and files newest first, never the user's uploads", async () => {
    seedHistory(NO_MORE);
    const { onOpenPage, onShowInThread } = await mount([
      message(
        "upload",
        1,
        [
          {
            type: "image",
            id: "shot",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 9,
          },
        ],
        "user",
      ),
      message("pricing", 2, [pageAttachment("pricing-html", "Pricing mockup")]),
      message("export", 3, [
        { type: "file", id: "report", name: "report.csv", mimeType: "text/csv", sizeBytes: 64 },
      ]),
      message("reply", 4, undefined),
      message("dashboard", 5, [pageAttachment("dashboard-html", "Dashboard")]),
    ]);

    await expect.element(page.getByRole("heading", { name: "Pages 2" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Files 1" })).toBeVisible();
    const titles = [
      ...document.querySelectorAll("[data-artifact-page] button[aria-label^='Open']"),
    ].map((button) => button.getAttribute("aria-label"));
    expect(titles).toEqual(["Open Dashboard", "Open Pricing mockup"]);
    const thumbnail = document.querySelector<HTMLImageElement>("[data-artifact-page] img");
    expect(thumbnail?.getAttribute("src")).toBe(THUMBNAIL);
    expect(document.body.textContent).toContain("report.csv");
    expect(document.body.textContent).not.toContain("screenshot.png");

    await page.getByRole("button", { name: "Open Dashboard" }).click();
    expect(onOpenPage).toHaveBeenCalledOnce();
    expect(onOpenPage.mock.calls[0]?.[0]).toMatchObject({
      kind: "page",
      messageId: "dashboard",
      attachment: { id: "dashboard-html" },
    });

    await page.getByRole("button", { name: "Show report.csv in thread" }).click();
    await page.getByRole("button", { name: "Show Pricing mockup in thread" }).click();
    expect(onShowInThread.mock.calls).toEqual([["export"], ["pricing"]]);
  });

  it("reads the artifacts further back than the thread as loaded, a page at a time", async () => {
    seedHistory({
      oldestCursor: OrchestrationThreadHistoryCursor.make("v1.window"),
      newestCursor: null,
      hasMoreBefore: true,
    });
    historyReads.pages = [
      historyPage([message("sketch", 1, [pageAttachment("sketch-html", "Early sketch")])], "v1.p2"),
      historyPage([message("first", 0, [pageAttachment("first-html", "First idea")])], null),
    ];
    await mount([message("latest", 9, [pageAttachment("latest-html", "Latest")])]);

    await expect.element(page.getByRole("button", { name: "Open Early sketch" })).toBeVisible();
    expect(historyReads.calls[0]).toMatchObject({
      threadId: THREAD_ID,
      collection: "messages",
      mode: { kind: "before", cursor: OrchestrationThreadHistoryCursor.make("v1.window") },
      messageFilter: "artifacts",
    } satisfies Partial<OrchestrationGetThreadHistoryPageInput>);

    await page.getByRole("button", { name: "Show earlier artifacts" }).click();
    await expect.element(page.getByRole("button", { name: "Open First idea" })).toBeVisible();
    expect(historyReads.calls[1]).toMatchObject({ mode: { kind: "before", cursor: "v1.p2" } });
    const titles = [
      ...document.querySelectorAll("[data-artifact-page] button[aria-label^='Open']"),
    ].map((button) => button.getAttribute("aria-label"));
    expect(titles).toEqual(["Open Latest", "Open Early sketch", "Open First idea"]);
    await expect
      .element(page.getByRole("button", { name: "Show earlier artifacts" }))
      .not.toBeInTheDocument();
  });

  it("lists artifacts handed over from another thread, and opens where they came from", async () => {
    seedHistory(NO_MORE);
    const handoff = { threadId: ThreadId.make("thread-parent"), messageId: MessageId.make("src") };
    const { onOpenThread } = await mount([
      message(
        "delegated",
        1,
        [{ ...pageAttachment("copy-html", "Pricing mockup"), handoff } as ChatAttachment],
        "user",
      ),
    ]);

    await expect.element(page.getByRole("button", { name: "Open Pricing mockup" })).toBeVisible();
    await page.getByRole("button", { name: "From another thread" }).click();
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("thread-parent");
  });

  it("says when the thread has no artifacts", async () => {
    seedHistory(NO_MORE);
    await mount([message("reply", 1, undefined)]);
    await expect.element(page.getByText("No artifacts yet")).toBeVisible();
    expect(historyReads.calls).toEqual([]);
  });
});
