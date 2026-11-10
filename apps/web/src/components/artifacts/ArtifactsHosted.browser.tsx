import "../../index.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { wsConnectionOpenedCountAtom } from "@ryco/client-runtime/rpc";
import {
  captureThreadReadContent,
  decodeThreadReadContent,
  projectThreadReadCacheShell,
} from "@ryco/client-runtime/state/threads";
import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  type EnvironmentApi,
  EnvironmentId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  OrchestrationThreadHistoryCursor,
  type OrchestrationThreadHistoryPage,
  type OrchestrationThreadHistoryPageInfo,
  type OrchestrationThreadWindowSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { injectHtmlRenderBootstrap } from "@ryco/shared/htmlRender";
import { useMemo, useState } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { clearHostedImageSources } from "../chat/hostedImageSource";
import { render } from "vitest-browser-react";

// The app as the hosted Hub serves it. Every export of the small env module is
// supplied: the thread store reads `isHostedHubMode` to keep attachment HTTP
// URLs out of hosted messages (no HTTP route to a node through the Hub).
vi.mock("../../env", () => ({
  isElectron: false,
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
  readMobileAppUrl: () => null,
  isPhoneAppInterstitialEnabled: () => false,
}));

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { createThreadSelectorByRef, useStore } from "../../store";
import { formatWorkspaceRenderKey } from "../../workspaceRouteSearch";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { HtmlRenderPanel } from "../chat/HtmlRenderPanel";
import { MessageAttachments } from "../chat/MessageAttachments";
import { __resetHtmlRenderSourceCacheForTests } from "../chat/useHtmlRenderSource";
import {
  __resetWorkspaceHtmlRenderLookupForTests,
  useWorkspaceHtmlRender,
} from "../chat/useWorkspaceHtmlRender";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { __resetEarlierThreadArtifactsForTests } from "./useEarlierThreadArtifacts";

const ENVIRONMENT_ID = EnvironmentId.make("env_hostedartifactsaaaaaa");
const THREAD_ID = ThreadId.make("thread-hosted-artifacts");
const PROJECT_ID = ProjectId.make("project-hosted-artifacts");
const TURN_ID = TurnId.make("turn-hosted-artifacts");
const DATE = "2026-11-10T12:00:00.000Z";
const at = (second: number) => `2026-11-10T12:00:${String(second).padStart(2, "0")}.000Z`;

const TITLE = "Pricing mockup";
const PAGE = injectHtmlRenderBootstrap(
  `<!doctype html><html><head></head><body><h1>${TITLE}</h1></body></html>`,
);
const PAGE_BYTES = new TextEncoder().encode(PAGE);
const THUMBNAIL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const THUMBNAIL = `data:image/png;base64,${THUMBNAIL_BASE64}`;
const IMAGE_BYTES = Uint8Array.from(atob(THUMBNAIL_BASE64), (char) => char.charCodeAt(0));

const PAGE_MESSAGE_ID = MessageId.make("msg-page");
const PAGE_ATTACHMENT_ID = "thread-hosted-pricing-html";
const IMAGE_MESSAGE_ID = MessageId.make("msg-image");
const IMAGE_ATTACHMENT_ID = "thread-hosted-chart-png";
const PAGE_RENDER_KEY = formatWorkspaceRenderKey({
  messageId: PAGE_MESSAGE_ID,
  attachmentId: PAGE_ATTACHMENT_ID,
});

const NO_MORE: OrchestrationThreadHistoryPageInfo = {
  oldestCursor: null,
  newestCursor: null,
  hasMoreBefore: false,
};

const shellThread = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Hosted artifacts",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  goal: null,
  createdAt: DATE,
  updatedAt: DATE,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} as const;

const shellSnapshot = {
  snapshotSequence: 1,
  updatedAt: DATE,
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: DATE,
      updatedAt: DATE,
    },
  ],
  worktrees: [],
  threads: [shellThread],
} as unknown as OrchestrationShellSnapshot;

function assistantMessage(
  id: MessageId,
  second: number,
  text: string,
  attachments?: OrchestrationMessage["attachments"],
): OrchestrationMessage {
  return {
    id,
    role: "assistant",
    text,
    turnId: TURN_ID,
    streaming: false,
    createdAt: at(second),
    updatedAt: at(second),
    ...(attachments ? { attachments } : {}),
  } as OrchestrationMessage;
}

const pageMessage = (id = PAGE_MESSAGE_ID, attachmentId = PAGE_ATTACHMENT_ID, second = 2) =>
  assistantMessage(id, second, " ", [
    {
      type: "file",
      id: attachmentId,
      name: `${TITLE}.html`,
      mimeType: "text/html",
      sizeBytes: PAGE_BYTES.length,
      htmlRender: { title: TITLE, height: 240, thumbnails: { dark: THUMBNAIL, light: THUMBNAIL } },
    },
  ] as OrchestrationMessage["attachments"]);

const imageMessage = (id = IMAGE_MESSAGE_ID, attachmentId = IMAGE_ATTACHMENT_ID, second = 3) =>
  assistantMessage(id, second, "Here is the chart.", [
    {
      type: "image",
      id: attachmentId,
      name: "chart.png",
      mimeType: "image/png",
      sizeBytes: IMAGE_BYTES.length,
    },
  ] as OrchestrationMessage["attachments"]);

const liveMessages = (): OrchestrationMessage[] => [
  {
    id: MessageId.make("msg-user"),
    role: "user",
    text: "Mock up the pricing page and chart revenue",
    turnId: null,
    streaming: false,
    createdAt: at(1),
    updatedAt: at(1),
  } as OrchestrationMessage,
  pageMessage(),
  imageMessage(),
  assistantMessage(MessageId.make("msg-reply"), 4, "Both are above."),
];

function threadWindow(
  messages: ReadonlyArray<OrchestrationMessage>,
  history: OrchestrationThreadHistoryPageInfo = NO_MORE,
): OrchestrationThreadWindowSnapshot {
  return {
    snapshotSequence: 2,
    thread: {
      ...shellThread,
      deletedAt: null,
      messages,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
    } as unknown as OrchestrationThread,
    history: {
      messages: history,
      proposedPlans: NO_MORE,
      activities: NO_MORE,
      checkpoints: NO_MORE,
    },
  };
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

/** The node's side of the attachments RPC, as the relay carries it. */
const readChunk = vi.fn(
  async (input: {
    messageId: string;
    attachmentId: string;
    offset: number;
    preview?: number | undefined;
  }) => {
    const bytes = input.attachmentId.endsWith("-png") ? IMAGE_BYTES : PAGE_BYTES;
    return {
      offset: input.offset,
      totalBytes: bytes.length,
      dataBase64: base64(
        bytes.subarray(input.offset, input.offset + CHAT_ATTACHMENT_READ_CHUNK_BYTES),
      ),
    };
  },
);
const getThreadHistoryPage = vi.fn<(input: unknown) => Promise<OrchestrationThreadHistoryPage>>();

/** The node's connection is up: its attachments and history read through the relay. */
function connectNode() {
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    attachments: { readChunk },
    orchestration: { getThreadHistoryPage },
  } as unknown as EnvironmentApi);
}

/** A socket opening, as `recordWsConnectionOpened` counts it. */
function openSocket() {
  appAtomRegistry.set(
    wsConnectionOpenedCountAtom,
    appAtomRegistry.get(wsConnectionOpenedCountAtom) + 1,
  );
}

/** The thread's surfaces as the app composes them: thread, artifacts tab, page tab. */
function HostedThreadSurfaces(props: { readonly renderKey: string | null }) {
  const selectThread = useMemo(
    () => createThreadSelectorByRef(scopeThreadRef(ENVIRONMENT_ID, THREAD_ID)),
    [],
  );
  const thread = useStore(selectThread);
  const resolution = useWorkspaceHtmlRender({
    environmentId: ENVIRONMENT_ID,
    threadId: THREAD_ID,
    thread,
    renderKey: props.renderKey,
    lookUp: true,
  });
  const [, setExpanded] = useState<ExpandedImagePreview | null>(null);
  return (
    <div style={{ display: "flex", gap: 16, width: 1200, height: 800 }}>
      <section aria-label="Thread" style={{ width: 600, overflow: "auto" }}>
        {thread?.messages.map((message) => (
          <div key={message.id}>
            <p>{message.text}</p>
            <MessageAttachments
              environmentId={ENVIRONMENT_ID}
              threadId={THREAD_ID}
              messageId={message.id}
              messageRole={message.role}
              attachments={message.attachments ?? []}
              onImageExpand={setExpanded}
              variant={message.role === "user" ? "user" : "assistant"}
            />
          </div>
        ))}
      </section>
      <section aria-label="Artifacts" style={{ width: 280, display: "flex" }}>
        <ArtifactsPanel
          environmentId={ENVIRONMENT_ID}
          threadId={THREAD_ID}
          messages={thread?.messages}
          onOpenPage={() => undefined}
          onShowInThread={() => undefined}
          onOpenThread={() => undefined}
        />
      </section>
      {props.renderKey ? (
        <section aria-label="Page tab" style={{ width: 280, display: "flex" }}>
          <HtmlRenderPanel
            environmentId={ENVIRONMENT_ID}
            threadId={THREAD_ID}
            renderKey={props.renderKey}
            resolution={resolution}
          />
        </section>
      ) : null}
    </div>
  );
}

const thread = page.getByRole("region", { name: "Thread" });
const artifacts = page.getByRole("region", { name: "Artifacts" });
const pageTab = page.getByRole("region", { name: "Page tab" });
const frameIn = (region: typeof thread) =>
  region.element().querySelector<HTMLIFrameElement>("iframe");

describe("artifacts in the hosted app", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  async function mount(renderKey: string | null = null) {
    mounted = await render(
      <AppAtomRegistryProvider>
        <HostedThreadSurfaces renderKey={renderKey} />
      </AppAtomRegistryProvider>,
    );
  }

  beforeEach(async () => {
    await page.viewport(1_400, 900);
    useStore.getState().syncServerShellSnapshot(shellSnapshot, ENVIRONMENT_ID);
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    readChunk.mockClear();
    getThreadHistoryPage.mockReset();
    __resetEnvironmentApiOverridesForTests();
    __resetEarlierThreadArtifactsForTests();
    __resetHtmlRenderSourceCacheForTests();
    __resetWorkspaceHtmlRenderLookupForTests();
    clearHostedImageSources();
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    document.body.innerHTML = "";
  });

  it("shows a published page and image in the thread, the artifacts tab, the page tab and full size", async () => {
    connectNode();
    useStore.getState().syncServerThreadWindow(threadWindow(liveMessages()), ENVIRONMENT_ID);
    await mount(PAGE_RENDER_KEY);

    // No HTTP URL reaches a hosted message: bytes only come over the relay.
    const stored =
      useStore.getState().environmentStateById[ENVIRONMENT_ID]!.messageByThreadId[THREAD_ID]!;
    expect(stored[IMAGE_MESSAGE_ID]!.attachments?.[0]).not.toHaveProperty("previewUrl");
    expect(stored[PAGE_MESSAGE_ID]!.attachments?.[0]).not.toHaveProperty("previewUrl");

    // Thread: the page loads inline, through the attachments RPC.
    await vi.waitFor(() => expect(frameIn(thread)?.srcdoc).toBe(PAGE), { timeout: 10_000 });
    expect(frameIn(thread)!.title).toBe(TITLE);
    expect(readChunk).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      messageId: PAGE_MESSAGE_ID,
      attachmentId: PAGE_ATTACHMENT_ID,
      offset: 0,
    });

    // Artifacts tab: the page's card with its stored thumbnail, the image as a file.
    await expect.element(artifacts.getByRole("heading", { name: "Pages 1" })).toBeVisible();
    await expect.element(artifacts.getByRole("heading", { name: "Files 1" })).toBeVisible();
    const card = artifacts.getByRole("button", { name: `Open ${TITLE}` });
    await expect.element(card).toBeVisible();
    expect(card.element().querySelector("img")?.getAttribute("src")).toBe(THUMBNAIL);

    // Page tab: the same page, from memory or the RPC, at full size.
    await vi.waitFor(() => expect(frameIn(pageTab)?.srcdoc).toBe(PAGE), { timeout: 10_000 });
    await expect.element(pageTab.getByRole("heading", { name: TITLE })).toBeInTheDocument();

    // The image shows by itself, its preview asked for over the RPC (this node
    // answers with the small original), and expands full size.
    const image = artifacts.getByRole("img", { name: "chart.png" });
    await expect.element(image).toBeVisible();
    await vi.waitFor(() => expect((image.element() as HTMLImageElement).naturalWidth).toBe(1));
    expect(readChunk).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      messageId: IMAGE_MESSAGE_ID,
      attachmentId: IMAGE_ATTACHMENT_ID,
      offset: 0,
      preview: 1024,
    });
    await artifacts.getByRole("button", { name: "Preview chart.png" }).click();
    const expanded = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(expanded).toBeVisible();
    await expect.element(expanded.getByRole("img", { name: "chart.png" })).toBeVisible();
    await expanded.getByRole("button", { name: "Close image preview" }).last().click();
    await expect.element(expanded).not.toBeInTheDocument();

    // The inline page expands full size too.
    await thread.getByRole("button", { name: "Open full size" }).click();
    const fullSize = page.getByRole("dialog");
    await expect.element(fullSize).toBeVisible();
    await vi.waitFor(() => expect(fullSize.element().querySelector("iframe")?.srcdoc).toBe(PAGE));
  });

  it("after a reload, waits for the live thread instead of calling its artifacts gone", async () => {
    // The display cache (local or the Hub's) as a reload restores it: the
    // thread's text, captured from the live messages, with no attachments.
    const live = threadWindow(liveMessages());
    useStore.getState().syncServerThreadWindow(live, ENVIRONMENT_ID);
    const liveThread = createThreadSelectorByRef(scopeThreadRef(ENVIRONMENT_ID, THREAD_ID))(
      useStore.getState(),
    );
    const content = decodeThreadReadContent(
      JSON.parse(JSON.stringify(captureThreadReadContent(liveThread?.messages ?? []))),
    );
    // Every message survives, as text: the cache allowlist drops attachments.
    expect(content?.messages).toHaveLength(4);
    expect(content?.messages.some((message) => message.attachments)).toBe(false);
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        projectThreadReadCacheShell(
          shellSnapshot,
          ENVIRONMENT_ID,
          100,
          new Map([[THREAD_ID, content!]]),
        ),
        ENVIRONMENT_ID,
      );
    await mount(PAGE_RENDER_KEY);

    // The cached text shows; nothing claims the artifacts are gone.
    await expect.element(thread.getByText("Both are above.")).toBeVisible();
    await expect.element(artifacts.getByText("No artifacts yet")).not.toBeInTheDocument();
    await expect
      .element(pageTab.getByText("This page is no longer available"))
      .not.toBeInTheDocument();
    expect(artifacts.element().querySelector("[aria-busy]")).not.toBeNull();
    expect(pageTab.element().querySelector("[aria-busy]")).not.toBeNull();
    expect(readChunk).not.toHaveBeenCalled();

    // The node connects and its live window arrives: everything shows.
    connectNode();
    openSocket();
    useStore.getState().syncServerThreadWindow(live, ENVIRONMENT_ID);
    await expect.element(artifacts.getByRole("button", { name: `Open ${TITLE}` })).toBeVisible();
    await vi.waitFor(() => expect(frameIn(pageTab)?.srcdoc).toBe(PAGE), { timeout: 10_000 });
    await vi.waitFor(() => expect(frameIn(thread)?.srcdoc).toBe(PAGE), { timeout: 10_000 });
  });

  it("while the node is not connected, says a page or image cannot load, then loads it once connected", async () => {
    useStore.getState().syncServerThreadWindow(threadWindow(liveMessages()), ENVIRONMENT_ID);
    await mount(PAGE_RENDER_KEY);

    // No transport: the page holds its box with a retry, the image says so.
    await expect.element(thread.getByText(`Unable to load ${TITLE}`)).toBeVisible();
    await artifacts.getByRole("button", { name: /^chart\.png/ }).click();
    await expect
      .element(artifacts.getByRole("status"))
      .toHaveTextContent("Could not load file. Click to retry.");

    // The connection opens: pages retry by themselves, the image on request.
    connectNode();
    openSocket();
    await vi.waitFor(() => expect(frameIn(thread)?.srcdoc).toBe(PAGE), { timeout: 10_000 });
    await vi.waitFor(() => expect(frameIn(pageTab)?.srcdoc).toBe(PAGE), { timeout: 10_000 });
    await artifacts.getByRole("button", { name: /^chart\.png/ }).click();
    await expect.element(artifacts.getByRole("img", { name: "chart.png" })).toBeVisible();
  });

  it("loads artifacts further back than the loaded window over the RPC", async () => {
    connectNode();
    const olderPage = pageMessage(MessageId.make("msg-older-page"), "thread-hosted-older-html", 1);
    const olderImage = imageMessage(
      MessageId.make("msg-older-image"),
      "thread-hosted-older-png",
      2,
    );
    // The artifacts read, then the page tab's lookup of one message.
    getThreadHistoryPage.mockImplementation(async (input) => {
      const { mode } = input as { mode: { kind: string } };
      return {
        collection: "messages",
        snapshotSequence: 2,
        items: mode.kind === "around" ? [olderPage] : [olderPage, olderImage],
        page: NO_MORE,
      } as unknown as OrchestrationThreadHistoryPage;
    });
    useStore.getState().syncServerThreadWindow(
      threadWindow([assistantMessage(MessageId.make("msg-latest"), 9, "Latest reply")], {
        oldestCursor: OrchestrationThreadHistoryCursor.make("v1.window"),
        newestCursor: null,
        hasMoreBefore: true,
      }),
      ENVIRONMENT_ID,
    );
    await mount(
      formatWorkspaceRenderKey({
        messageId: olderPage.id,
        attachmentId: "thread-hosted-older-html",
      }),
    );

    // Listed with their metadata, though the thread never loaded them.
    await expect.element(artifacts.getByRole("button", { name: `Open ${TITLE}` })).toBeVisible();
    expect(
      artifacts
        .getByRole("button", { name: `Open ${TITLE}` })
        .element()
        .querySelector("img")?.src,
    ).toBe(THUMBNAIL);

    // The image there has no URL of any kind; it reads over the attachments RPC.
    await expect.element(artifacts.getByRole("img", { name: "chart.png" })).toBeVisible();
    expect(readChunk).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      messageId: "msg-older-image",
      attachmentId: "thread-hosted-older-png",
      offset: 0,
      preview: 1024,
    });

    // The page tab finds the older page on its own and loads it.
    await vi.waitFor(() => expect(frameIn(pageTab)?.srcdoc).toBe(PAGE), { timeout: 10_000 });
  });
});
