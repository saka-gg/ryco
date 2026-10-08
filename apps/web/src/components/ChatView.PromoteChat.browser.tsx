import {
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectsPromoteChatPreviewResult,
  type ThreadId,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  setupChatViewBrowserSuite,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_ID,
  createSnapshotForTargetUser,
  fixture,
  mountChatView,
  openCommandPaletteFromTrigger,
  rpcHarness,
  waitForServerConfigToApply,
} from "./ChatView.browser.helpers";
import { usePromoteChatDialogStore } from "./chat/promoteChatDialogStore";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const CHAT_PROJECT_ID = ProjectId.make("chat-project-promote");
const CHAT_THREAD_ID = "thread-in-chat-to-promote" as ThreadId;
const CHAT_TITLE = "Plan a trip";
const CHAT_FOLDER = "/home/me/.ryco/chats/2026-03-04-plan-a-trip-1a2b3c4d";
const DESTINATION = "/home/me/Code/plan-a-trip";
const CHATS_AVAILABLE = { available: true, root: "/home/me/.ryco/chats" } as const;

/** A project plus a chat project holding one thread, as the server reports them. */
function createSnapshotWithChat(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-promote-target" as MessageId,
    targetText: "project thread",
  });
  const projectThread = snapshot.threads[0]!;
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        ...snapshot.projects[0]!,
        id: CHAT_PROJECT_ID,
        title: CHAT_TITLE,
        workspaceRoot: CHAT_FOLDER,
        kind: "chat",
      },
    ],
    threads: [
      projectThread,
      {
        ...projectThread,
        id: CHAT_THREAD_ID,
        projectId: CHAT_PROJECT_ID,
        title: CHAT_TITLE,
        branch: null,
        messages: projectThread.messages.slice(0, 2),
        session: null,
      },
    ],
  };
}

function preview(destination: string | undefined): ProjectsPromoteChatPreviewResult {
  return {
    projectId: CHAT_PROJECT_ID,
    source: CHAT_FOLDER,
    defaultDestination: DESTINATION,
    destination: destination ?? DESTINATION,
    destinationStatus: "available",
    fileCount: 3,
    totalBytes: 2048,
    countTruncated: false,
    busyThreadIds: [],
    gitAvailable: true,
    gitIdentityConfigured: true,
    crossDevice: false,
  };
}

type ChatProject = OrchestrationReadModel["projects"][number];

/** The node re-points the chat's project at its new folder, as a regular project. */
function emitChatTurnedIntoProject(chatProject: ChatProject): void {
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
    kind: "project-upserted",
    sequence: fixture.snapshot.snapshotSequence + 1,
    project: {
      id: CHAT_PROJECT_ID,
      title: CHAT_TITLE,
      kind: "project",
      workspaceRoot: DESTINATION,
      repositoryIdentity: null,
      defaultModelSelection: chatProject.defaultModelSelection,
      scripts: [],
      createdAt: chatProject.createdAt,
      updatedAt: "2026-03-04T12:30:00.000Z",
    },
  });
}

/** Mounts the app on the chat thread, with a node that hosts chats and promotes them. */
async function mountChat(input: { readonly initialPath?: string } = {}) {
  const promoteRequests: Array<Record<string, unknown>> = [];
  const snapshot = createSnapshotWithChat();
  const chatProject = snapshot.projects.find((project) => project.id === CHAT_PROJECT_ID)!;
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot,
    initialPath: input.initialPath ?? `/${LOCAL_ENVIRONMENT_ID}/${CHAT_THREAD_ID}`,
    configureFixture: (nextFixture) => {
      nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
    },
    resolveRpc: (body) => {
      if (body._tag === WS_METHODS.projectsPromoteChatPreview) {
        return preview(typeof body.destination === "string" ? body.destination : undefined);
      }
      if (body._tag === WS_METHODS.projectsPromoteChat) {
        promoteRequests.push(body as Record<string, unknown>);
        // The server re-points the project before it answers.
        emitChatTurnedIntoProject(chatProject);
        return {
          projectId: CHAT_PROJECT_ID,
          workspaceRoot: DESTINATION,
          gitInitialized: true,
          initialCommitCreated: true,
        };
      }
      return undefined;
    },
  });
  await waitForServerConfigToApply();
  return { mounted, promoteRequests, chatProject };
}

/** The chat's row in the sidebar's Chats section. */
function sidebarChatRow(): Element | null {
  return document.querySelector(
    `[data-testid="sidebar-chats-section"] [data-testid="thread-row-${CHAT_THREAD_ID}"]`,
  );
}

/** The project tree's row (the auto-animated list item) for the chat's project. */
function sidebarProjectRow(): HTMLElement | null {
  return (
    document
      .querySelector(`[data-sidebar-project-members~="${LOCAL_ENVIRONMENT_ID}:${CHAT_PROJECT_ID}"]`)
      ?.closest<HTMLElement>("li") ?? null
  );
}

async function expectDialogPrefilled(): Promise<void> {
  await expect.element(page.getByTestId("promote-chat-dialog")).toBeVisible();
  await expect.element(page.getByTestId("promote-chat-location")).toHaveValue(DESTINATION);
  await expect.element(page.getByTestId("promote-chat-name")).toHaveValue(CHAT_TITLE);
}

describe("Turn into project… (full app)", () => {
  setupChatViewBrowserSuite();
  beforeEach(() => {
    // The dialog's store is app-wide; a test that ends with it open must not leak it.
    usePromoteChatDialogStore.setState({ open: false, token: 0, request: null, origin: null });
  });

  it("promotes a chat from its header and lands it in the project tree", async () => {
    const { mounted, promoteRequests } = await mountChat();
    try {
      const promote = page.getByTestId("chat-header-promote");
      await expect.element(promote).toBeVisible();
      // The chat's header offers promotion instead of a "No Git" badge.
      expect(document.body.textContent).not.toContain("No Git");
      await promote.click();

      await expectDialogPrefilled();
      await expect
        .element(page.getByTestId("promote-chat-move-plan"))
        .toHaveTextContent("Move 3 files (2.0 KB)");
      await page.getByTestId("promote-chat-submit").click();

      await vi.waitFor(() => expect(promoteRequests).toHaveLength(1));
      expect(promoteRequests[0]).toMatchObject({
        projectId: CHAT_PROJECT_ID,
        title: CHAT_TITLE,
        destination: DESTINATION,
        initializeGit: true,
        initialCommit: true,
        writeGitignore: true,
      });
      await expect
        .element(page.getByTestId("promote-step-initial-commit"))
        .toHaveAttribute("data-status", "done");

      // The dialog folds away into the project's new row in the sidebar.
      await vi.waitFor(
        () => expect(document.querySelector('[data-testid="promote-chat-dialog"]')).toBeNull(),
        { timeout: 6_000 },
      );
      expect(sidebarProjectRow()?.textContent).toContain(CHAT_TITLE);
      expect(document.querySelector('[data-testid="sidebar-chats-section"]')).toBeNull();
      expect(document.querySelector('[data-testid="chat-header-promote"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("moves the chat from Chats into the project tree without an empty frame", async () => {
    const { mounted, chatProject } = await mountChat();
    try {
      await vi.waitFor(() => expect(sidebarChatRow()).not.toBeNull());
      expect(sidebarProjectRow()).toBeNull();

      // Sample every painted frame while the node turns the chat into a project.
      const frames: Array<{ chatListed: boolean; projectOpacity: number | null }> = [];
      let sampling = true;
      const sample = () => {
        if (!sampling) return;
        const projectRow = sidebarProjectRow();
        frames.push({
          chatListed: sidebarChatRow() !== null,
          projectOpacity: projectRow ? Number(getComputedStyle(projectRow).opacity) : null,
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      emitChatTurnedIntoProject(chatProject);
      await vi.waitFor(() => expect(sidebarProjectRow()).not.toBeNull());
      // Longer than the list's entrance animation (1.5 × 180 ms).
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      sampling = false;

      // In every frame the chat is somewhere you can see it: still under Chats,
      // or already a fully visible project row (never an invisible one).
      expect(frames.filter((frame) => !frame.chatListed && frame.projectOpacity !== 1)).toEqual([]);
      expect(frames.at(-1)).toEqual({ chatListed: false, projectOpacity: 1 });
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Turn into project… in the Chats row menu", async () => {
    // Viewing another thread: the chat is reached from its sidebar row only.
    const { mounted } = await mountChat({ initialPath: `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}` });
    try {
      const row = page.getByTestId(`thread-row-${CHAT_THREAD_ID}`);
      await expect.element(row).toBeVisible();
      await row.click({ button: "right" });
      // The browser renders the row menu with the DOM fallback (plain buttons).
      const item = await vi.waitFor(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>("div[data-level='0'] > button"),
        ).find((candidate) => candidate.textContent === "Turn into project…");
        expect(button).toBeDefined();
        return button!;
      });
      item.click();

      await expectDialogPrefilled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Turn chat into project… in the command palette for the active chat", async () => {
    const { mounted } = await mountChat();
    try {
      await openCommandPaletteFromTrigger();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("into project");
      const palette = page.getByTestId("command-palette");
      const action = palette.getByText("Turn chat into project…", { exact: true });
      await expect.element(action).toBeInTheDocument();
      await action.click();

      await expectDialogPrefilled();
    } finally {
      await mounted.cleanup();
    }
  });
});
