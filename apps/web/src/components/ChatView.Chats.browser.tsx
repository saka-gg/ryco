import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  WS_METHODS,
  ProjectId,
  type MessageId,
  type OrchestrationReadModel,
  type ThreadId,
} from "@ryco/contracts";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { DraftId, isPendingChatDraft, useComposerDraftStore } from "../composerDraftStore";
import { selectProjectByRef, useStore } from "../store";
import {
  setupChatViewBrowserSuite,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  PHONE_VIEWPORT,
  PROJECT_DRAFT_KEY,
  PROJECT_ID,
  createDraftOnlySnapshot,
  createSnapshotForTargetUser,
  fixture,
  mountChatView,
  rpcHarness,
  waitForElement,
  waitForLayout,
  waitForSendButton,
  waitForServerConfigToApply,
  wsRequests,
} from "./ChatView.browser.helpers";
import { WsRpcFailure } from "../../test/wsRpcHarness";
import { setGitStatusForTests, watchedGitStatusCwdsForTests } from "../../test/gitStatusStateMock";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const DRAFT_ID = DraftId.make("draft-chats-browser");
const DRAFT_THREAD_ID = "thread-chats-browser" as ThreadId;
const CHAT_PROJECT_ID = ProjectId.make("chat-project-browser");
const CHAT_PROJECT_REF = scopeProjectRef(LOCAL_ENVIRONMENT_ID, CHAT_PROJECT_ID);
const CHAT_THREAD_ID = "thread-in-chat-project" as ThreadId;
const CHAT_TITLE = "Plan a trip";
const CHATS_AVAILABLE = { available: true, root: "/home/me/.ryco/chats" } as const;

function seedProjectDraft(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [DRAFT_ID]: {
        threadId: DRAFT_THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        logicalProjectKey: PROJECT_DRAFT_KEY,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: { [PROJECT_DRAFT_KEY]: DRAFT_ID },
  });
}

function seedChatDraft(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [DRAFT_ID]: {
        threadId: DRAFT_THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: CHAT_PROJECT_ID,
        logicalProjectKey: `chat:${CHAT_PROJECT_ID}`,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
        pendingChat: true,
      },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: { [`chat:${CHAT_PROJECT_ID}`]: DRAFT_ID },
  });
}

/** A project plus a chat project holding one thread, as the server reports them. */
function createSnapshotWithChat(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-chat-target" as MessageId,
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
        workspaceRoot: "/home/me/.ryco/chats/2026-03-04-plan-a-trip-1a2b3c4d",
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

type TurnStartRequest = {
  commandId?: string;
  threadId?: string;
  message?: { messageId?: string; text?: string };
  bootstrap?: {
    createChatProject?: { projectId?: string; titleSeed?: string };
    createThread?: { projectId?: string; branch?: string | null };
    prepareWorktree?: unknown;
  };
};

function findTurnStarts(): TurnStartRequest[] {
  return wsRequests.filter(
    (request) =>
      request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
      (request as { type?: string }).type === "thread.turn.start",
  ) as TurnStartRequest[];
}

function findTurnStart(): TurnStartRequest | undefined {
  return findTurnStarts()[0];
}

describe("ChatView chats without a project (full app)", () => {
  setupChatViewBrowserSuite();

  it("starts a chat from the hero and creates its project on the first send", async () => {
    seedProjectDraft();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${DRAFT_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { sequence: fixture.snapshot.snapshotSequence + 1 }
          : undefined,
    });

    try {
      await waitForServerConfigToApply();
      const startWithoutProject = page.getByTestId("new-thread-start-without-project");
      await expect.element(startWithoutProject).toBeInTheDocument();
      await startWithoutProject.click();

      await expect.element(page.getByTestId("new-thread-chat-location")).toBeInTheDocument();
      await expect.element(page.getByText("What should we do?")).toBeInTheDocument();
      const draft = useComposerDraftStore.getState().getDraftSession(DRAFT_ID);
      expect(isPendingChatDraft(draft)).toBe(true);
      expect(draft?.projectId).not.toBe(PROJECT_ID);
      // The chat runs in a plain folder: no branch/worktree toolbar.
      expect(document.querySelector('[data-testid="branch-toolbar"]')).toBeNull();

      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Plan a trip to Lisbon");
      await waitForLayout();
      const sendButton = await waitForSendButton();
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStart = findTurnStart();
          expect(turnStart?.bootstrap?.createChatProject).toEqual({
            projectId: draft?.projectId,
            titleSeed: "Plan a trip to Lisbon",
          });
          expect(turnStart?.bootstrap?.createThread).toMatchObject({
            projectId: draft?.projectId,
            branch: null,
          });
          expect(turnStart?.bootstrap?.prepareWorktree).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends again under a fresh chat id when the node retired the draft's", async () => {
    seedChatDraft();
    let refused = false;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${DRAFT_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
      },
      resolveRpc: (body) => {
        if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
        // Startup cleanup removed this unused chat: the node refuses its id once.
        if ((body as { type?: string }).type === "thread.turn.start" && !refused) {
          refused = true;
          return new WsRpcFailure(
            new OrchestrationDispatchCommandError({
              message:
                "This chat was cleaned up before its first message was sent. Start a new chat to send this message.",
              reason: "chat-project-retired",
            }),
          );
        }
        return { sequence: fixture.snapshot.snapshotSequence + 1 };
      },
    });

    try {
      await waitForServerConfigToApply();
      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Plan a trip to Lisbon");
      await waitForLayout();
      (await waitForSendButton()).click();

      await vi.waitFor(
        () => {
          expect(findTurnStarts()).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );
      const [first, second] = findTurnStarts();
      const renewed = useComposerDraftStore.getState().getDraftSession(DRAFT_ID);
      // The draft keeps its thread under a fresh, persisted chat project id.
      expect(isPendingChatDraft(renewed)).toBe(true);
      expect(renewed?.threadId).toBe(DRAFT_THREAD_ID);
      expect(renewed?.projectId).not.toBe(CHAT_PROJECT_ID);
      expect(first?.bootstrap?.createChatProject?.projectId).toBe(CHAT_PROJECT_ID);
      expect(second?.bootstrap?.createChatProject).toEqual({
        projectId: renewed?.projectId,
        titleSeed: "Plan a trip to Lisbon",
      });
      expect(second?.bootstrap?.createThread?.projectId).toBe(renewed?.projectId);
      expect(second?.threadId).toBe(first?.threadId);
      expect(second?.message).toEqual(first?.message);
      expect(second?.commandId).not.toBe(first?.commandId);
      // The refusal never reaches the user.
      expect(document.body.textContent).not.toContain("This chat was cleaned up");
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends the chat bootstrap again when a failed first send already created the chat", async () => {
    seedChatDraft();
    let failed = false;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${DRAFT_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
      },
      resolveRpc: (body) => {
        if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
        if ((body as { type?: string }).type === "thread.turn.start" && !failed) {
          failed = true;
          // The node created the chat project, then a later bootstrap step failed: it
          // removed the empty folder and kept the chat, which reaches the client first.
          const template = fixture.snapshot.projects[0]!;
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
            kind: "project-upserted",
            sequence: fixture.snapshot.snapshotSequence + 1,
            project: {
              id: CHAT_PROJECT_ID,
              title: CHAT_TITLE,
              kind: "chat",
              workspaceRoot: "/home/me/.ryco/chats/2026-03-04-plan-a-trip-1a2b3c4d",
              repositoryIdentity: null,
              defaultModelSelection: template.defaultModelSelection,
              scripts: [],
              createdAt: NOW_ISO,
              updatedAt: NOW_ISO,
            },
          });
          return new WsRpcFailure(
            new OrchestrationDispatchCommandError({ message: "The provider could not start." }),
          );
        }
        return { sequence: fixture.snapshot.snapshotSequence + 2 };
      },
    });

    try {
      await waitForServerConfigToApply();
      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Plan a trip to Lisbon");
      await waitForLayout();
      (await waitForSendButton()).click();

      await vi.waitFor(
        () => {
          expect(findTurnStarts()).toHaveLength(1);
          expect(selectProjectByRef(useStore.getState(), CHAT_PROJECT_REF)).toBeDefined();
        },
        { timeout: 8_000, interval: 16 },
      );
      const draft = useComposerDraftStore.getState().getDraftSession(DRAFT_ID);
      // The chat project arrived, but no thread exists yet: the draft is still an unsent chat.
      expect(isPendingChatDraft(draft)).toBe(true);
      expect(draft?.projectId).toBe(CHAT_PROJECT_ID);

      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Plan a trip to Lisbon");
      await waitForLayout();
      (await waitForSendButton()).click();

      await vi.waitFor(
        () => {
          expect(findTurnStarts()).toHaveLength(2);
        },
        { timeout: 8_000, interval: 16 },
      );
      const retry = findTurnStarts()[1];
      // Only the chat bootstrap makes the node reuse the chat and recreate its folder.
      expect(retry?.bootstrap?.createChatProject).toEqual({
        projectId: CHAT_PROJECT_ID,
        titleSeed: "Plan a trip to Lisbon",
      });
      expect(retry?.bootstrap?.createThread).toMatchObject({
        projectId: CHAT_PROJECT_ID,
        branch: null,
      });
      expect(retry?.bootstrap?.prepareWorktree).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("names an unsent chat No project in the header, with no empty segment", async () => {
    seedChatDraft();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${DRAFT_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
      },
    });

    try {
      await waitForServerConfigToApply();
      const breadcrumb = await waitForElement(
        () => document.querySelector<HTMLElement>('header nav[aria-label="Breadcrumb"]'),
        "The header breadcrumb did not render.",
      );
      await vi.waitFor(() => {
        expect(breadcrumb.textContent).toBe("No projectNew chat");
      });
      // One separator, between the two segments: nothing ahead of "No project".
      const separators = breadcrumb.querySelectorAll('[data-slot="breadcrumb-separator"]');
      expect(separators).toHaveLength(1);
      expect(breadcrumb.firstElementChild?.textContent).toBe("No project");
      // The chat's folder does not exist before the first send: nothing to open.
      expect(
        document.querySelector('header [role="group"][aria-label="Subscription actions"]'),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows no Git sections or Notes on a chat's overview rail, only the way to a project", async () => {
    // The node answers Git status for any folder, a chat's included.
    setGitStatusForTests({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    });
    const snapshot = createSnapshotWithChat();
    const chatFolder = snapshot.projects.find(
      (project) => project.id === CHAT_PROJECT_ID,
    )!.workspaceRoot;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      initialPath: `/${LOCAL_ENVIRONMENT_ID}/${CHAT_THREAD_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          chats: CHATS_AVAILABLE,
          environment: {
            ...nextFixture.serverConfig.environment,
            capabilities: {
              ...nextFixture.serverConfig.environment.capabilities,
              worktreeNotes: true,
            },
          },
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const toggle = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Toggle overview panel"]'),
        "Unable to find the overview toggle.",
      );
      if (toggle.getAttribute("aria-pressed") !== "true") toggle.click();
      const rail = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-slot="crown-overview"][data-state="open"] [data-slot="crown-rail"]',
          ),
        "Unable to find the overview rail.",
      );
      // A chat folder is no checkout: no Branch, Changes, Checks, Pull request or
      // Push, and no worktree Notes. Promotion is where all of them start.
      const railKeys = () =>
        Array.from(rail.querySelectorAll<HTMLElement>("[data-nav-key]"), (button) => {
          return button.dataset.navKey;
        });
      await vi.waitFor(() => expect(railKeys()).toEqual(["plan", "agents", "project"]));
      // The face wears the chat glyph "No project" wears elsewhere, not the chat
      // folder's favicon or a monogram of the chat's title.
      const faceLogo = rail
        .closest('[data-slot="crown-overview"]')!
        .querySelector<HTMLElement>('[data-slot="crown-face-logo"]')!;
      expect(faceLogo.dataset.logo).toBe("chat");
      expect(faceLogo.querySelector("img, svg text")).toBeNull();

      rail.querySelector<HTMLElement>('[data-nav-key="project"]')!.click();
      const promote = page.getByTestId("crown-promote-chat");
      await expect.element(promote).toBeVisible();
      const card = promote.element().closest<HTMLElement>('[data-slot="crown-card"]')!;
      expect(card.textContent).toContain("Turn into project");
      expect(card.querySelector('button[aria-label^="Refresh pull request"]')).toBeNull();

      // Nothing asked about the chat folder's Git status, pull request, CI or notes.
      expect(watchedGitStatusCwdsForTests().has(chatFolder)).toBe(false);
      const noChatFolderLookups: ReadonlySet<string> = new Set([
        WS_METHODS.notesList,
        WS_METHODS.notesCommand,
        WS_METHODS.sourceControlListChangeRequests,
        WS_METHODS.sourceControlGetChangeRequestDetail,
        WS_METHODS.sourceControlListWorkflowRuns,
        WS_METHODS.sourceControlGetWorkflowRunJobs,
      ]);
      expect(wsRequests.filter((request) => noChatFolderLookups.has(request._tag))).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("lists chat projects under Chats, never in the project tree", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithChat(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
      },
    });

    try {
      const chatsSection = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="sidebar-chats-section"]'),
        "The Chats section did not render.",
      );
      await vi.waitFor(() => {
        expect(
          chatsSection.querySelector(`[data-testid="thread-row-${CHAT_THREAD_ID}"]`),
        ).not.toBeNull();
      });
      // The chat project is not a project row; the regular project still is.
      await expect
        .element(page.getByRole("button", { name: "Start a new thread in Project" }))
        .toBeInTheDocument();
      expect(
        document.querySelector(`[aria-label="Start a new thread in ${CHAT_TITLE}"]`),
      ).toBeNull();
      expect(
        chatsSection
          .querySelector(`[data-testid="thread-row-${CHAT_THREAD_ID}"]`)
          ?.closest('[data-testid="sidebar-chats-section"]'),
      ).toBe(chatsSection);

      // Collapsing the section hides its rows.
      await page.getByTestId("sidebar-chats-toggle").click();
      await vi.waitFor(() => {
        expect(document.querySelector(`[data-testid="thread-row-${CHAT_THREAD_ID}"]`)).toBeNull();
      });
    } finally {
      localStorage.removeItem("ryco:sidebar-chats-expanded");
      await mounted.cleanup();
    }
  });

  it("hides every chat entry point when the node cannot host chats", async () => {
    for (const chats of [
      undefined,
      { available: false, unavailableReason: "inside-git-repository" },
    ] as const) {
      seedProjectDraft();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        initialPath: `/draft/${DRAFT_ID}`,
        configureFixture: (nextFixture) => {
          const { chats: _ignored, ...rest } = nextFixture.serverConfig;
          nextFixture.serverConfig = chats ? { ...rest, chats } : rest;
        },
      });
      try {
        await waitForServerConfigToApply();
        await expect.element(page.getByTestId("new-thread-hero")).toBeInTheDocument();
        await waitForLayout();
        expect(
          document.querySelector('[data-testid="new-thread-start-without-project"]'),
        ).toBeNull();
        expect(document.querySelector('[data-testid="sidebar-new-chat"]')).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    }
  });

  it("offers no way to start a chat on the frozen phone tier", async () => {
    for (const viewport of [DEFAULT_VIEWPORT, PHONE_VIEWPORT]) {
      const phone = viewport === PHONE_VIEWPORT;
      seedProjectDraft();
      const mounted = await mountChatView({
        viewport,
        snapshot: createDraftOnlySnapshot(),
        initialPath: `/draft/${DRAFT_ID}`,
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
        },
      });
      try {
        await waitForServerConfigToApply();
        await vi.waitFor(() => {
          expect(document.documentElement.getAttribute("data-tier")).toBe(
            phone ? "phone" : "desktop",
          );
        });
        await waitForLayout();
        if (phone) {
          expect(
            document.querySelector('[data-testid="new-thread-start-without-project"]'),
          ).toBeNull();
        } else {
          await expect
            .element(page.getByTestId("new-thread-start-without-project"))
            .toBeInTheDocument();
        }

        // PhoneHome's Search opens the same palette; its chat items follow the tier too.
        useCommandPaletteStore.getState().setOpen(true);
        const palette = page.getByTestId("command-palette");
        // The action list has rendered once its last regular action is there.
        await expect.element(palette.getByText("Add project", { exact: true })).toBeInTheDocument();
        const newChat = palette.getByText("New chat without a project", { exact: true });
        if (phone) {
          expect(palette.element().textContent).not.toContain("New chat without a project");
        } else {
          await expect.element(newChat).toBeInTheDocument();
        }
      } finally {
        useCommandPaletteStore.getState().setOpen(false);
        await mounted.cleanup();
      }
    }
  });

  it("turns a chat draft back into a project draft when a project is picked", async () => {
    seedChatDraft();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${DRAFT_ID}`,
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = { ...nextFixture.serverConfig, chats: CHATS_AVAILABLE };
      },
    });

    try {
      await waitForServerConfigToApply();
      useComposerDraftStore.getState().setPrompt(DRAFT_ID, "Keep this prompt");
      const switcher = page.getByRole("combobox", {
        name: "Switch project (currently No project)",
      });
      await expect.element(switcher).toBeInTheDocument();
      await switcher.click();
      await expect.element(page.getByTestId("project-switcher-no-project")).toBeInTheDocument();
      await page.getByRole("option", { name: /^Project/ }).click();

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getDraftSession(DRAFT_ID);
        expect(draft?.projectId).toBe(PROJECT_ID);
        expect(isPendingChatDraft(draft)).toBe(false);
      });
      expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe(
        "Keep this prompt",
      );
      await expect.element(page.getByText("What should we do in")).toBeInTheDocument();
      expect(document.querySelector('[data-testid="new-thread-chat-location"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
});
