import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  WS_METHODS,
} from "@ryco/contracts";
import { createModelCapabilities, createModelSelection } from "@ryco/shared/model";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { useTerminalStateStore } from "../terminalStateStore";
import {
  setupChatViewBrowserSuite,
  CHAT_NEW_KEYBINDING,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  PROJECT_DRAFT_KEY,
  PROJECT_ID,
  THREAD_ID,
  THREAD_KEY,
  THREAD_REF,
  UUID_ROUTE_RE,
  WIDE_FOOTER_VIEWPORT,
  clickEnabledButton,
  composerDraftFor,
  createDraftFromChatNewLocalShortcut,
  createDraftFromChatNewShortcut,
  createDraftOnlySnapshot,
  createSnapshotForTargetUser,
  draftIdFromPath,
  draftThreadIdFor,
  enableChatNewLocalShortcut,
  enableChatNewShortcut,
  expectVisibleComboboxPopupToBeOpaqueAndClipped,
  fixture,
  materializePromotedDraftThreadViaDomainEvent,
  mountChatView,
  openNewWorkspaceDialog,
  serverThreadPath,
  setDraftThreadWithoutWorktree,
  startPromotedServerThreadViaDomainEvent,
  triggerChatNewLocalShortcutUntilPath,
  triggerChatNewShortcutUntilPath,
  waitForComposerEditor,
  waitForElement,
  waitForLayout,
  waitForSendButton,
  waitForServerConfigToApply,
  waitForURL,
  withProjectScripts,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/**
 * Opens the overview from the new-thread hero (where it starts suppressed) and
 * expands the Crown card on its Branch section, which carries the thread's
 * full branch selector.
 */
async function openCrownBranchSection(): Promise<HTMLElement> {
  const overviewToggle = await waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Toggle overview panel"]'),
    "Unable to find the overview toggle.",
  );
  overviewToggle.click();
  const branchIcon = await waitForElement(
    () =>
      document.querySelector<HTMLElement>(
        '[data-slot="crown-overview"][data-state="open"] [data-slot="crown-rail"] [data-nav-key="branch"]',
      ),
    "Unable to find the Crown rail's Branch icon.",
  );
  branchIcon.click();
  return waitForElement(
    () =>
      document.querySelector<HTMLElement>(
        '[data-slot="crown-card-detail"] [data-section="branch"]',
      ),
    "Unable to find the Crown card's Branch section.",
  );
}

describe("ChatView Workspace (full app)", () => {
  setupChatViewBrowserSuite();

  it("opens the project cwd for draft threads without a worktree path", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not leak a server worktree path into drawer runtime env when launch context clears it", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-launch-context-target" as MessageId,
      targetText: "launch context worktree override",
    });
    const targetThread = snapshot.threads.find((thread) => thread.id === THREAD_ID);
    if (targetThread) {
      Object.assign(targetThread, {
        branch: "feature/branch",
        worktreePath: "/repo/worktrees/feature-branch",
      });
    }

    useTerminalStateStore.setState({
      terminalStateByThreadKey: {
        [THREAD_KEY]: {
          terminalOpen: true,
          terminalHeight: 280,
          terminalIds: ["default"],
          runningTerminalIds: [],
          activeTerminalId: "default",
          terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
          activeTerminalGroupId: "group-default",
        },
      },
      terminalLaunchContextByThreadKey: {
        [THREAD_KEY]: {
          cwd: "/repo/project",
          worktreePath: null,
        },
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          ) as
            | {
                _tag: string;
                cwd?: string;
                worktreePath?: string | null;
                env?: Record<string, string>;
              }
            | undefined;
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            cwd: "/repo/project",
            worktreePath: null,
            env: {
              RYCO_PROJECT_ROOT: "/repo/project",
            },
          });
          expect(openRequest?.env?.RYCO_WORKTREE_PATH).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with VS Code Insiders when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with Trae when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["trae"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "trae",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows Kiro in the open picker menu and opens the project cwd with it", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["kiro"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      const kiroItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Kiro"),
          ) ?? null,
        "Unable to find Kiro menu item.",
      );
      (kiroItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "kiro",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters expanded app options and keeps Terminal from replacing the favorite editor", async () => {
    localStorage.setItem("ryco:last-editor", JSON.stringify("vscode"));
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode", "windsurf", "xcode", "android-studio", "terminal"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      const androidStudioItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Android Studio"),
          ) ?? null,
        "Unable to find Android Studio menu item.",
      );
      expect(androidStudioItem.querySelector("svg image")).not.toBeNull();

      const windsurfItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Windsurf"),
          ) ?? null,
        "Unable to find Windsurf menu item.",
      );
      expect(windsurfItem.querySelector("svg image")).not.toBeNull();

      const xcodeItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Xcode"),
          ) ?? null,
        "Unable to find Xcode menu item.",
      );
      expect(xcodeItem.querySelector("svg image")).not.toBeNull();
      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Positron"),
        ),
      ).toBe(false);

      (androidStudioItem as HTMLElement).click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.shellOpenInEditor &&
                request.editor === "android-studio",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      (menuButton as HTMLButtonElement).click();
      const reopenedWindsurfItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Windsurf"),
          ) ?? null,
        "Unable to find Windsurf menu item after reopening the picker.",
      );
      (reopenedWindsurfItem as HTMLElement).click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.shellOpenInEditor && request.editor === "windsurf",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      (menuButton as HTMLButtonElement).click();

      const terminalItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("Terminal"),
          ) ?? null,
        "Unable to find Terminal menu item.",
      );
      expect(terminalItem.querySelector("svg")).not.toBeNull();
      (terminalItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.shellOpenInEditor && request.editor === "terminal",
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "terminal",
          });
          expect(localStorage.getItem("ryco:last-editor")).toBe(JSON.stringify("windsurf"));
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters the open picker menu and opens VSCodium from the menu", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders", "vscodium"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VS Code Insiders"),
          ) ?? null,
        "Unable to find VS Code Insiders menu item.",
      );

      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Zed"),
        ),
      ).toBe(false);

      const vscodiumItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VSCodium"),
          ) ?? null,
        "Unable to find VSCodium menu item.",
      );
      (vscodiumItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscodium",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first installed editor when the stored favorite is unavailable", async () => {
    localStorage.setItem("ryco:last-editor", JSON.stringify("vscodium"));
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
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
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Lint",
          ) as HTMLButtonElement | null,
        "Unable to find Run Lint button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              RYCO_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            data: "bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
    });

    try {
      const runButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.title === "Run Test",
          ) as HTMLButtonElement | null,
        "Unable to find Run Test button.",
      );
      runButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              RYCO_PROJECT_ROOT: "/repo/project",
              RYCO_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("lets the server own setup after preparing a pull request worktree thread", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
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
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.gitResolvePullRequest) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/sak0a/ryco/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
          };
        }
        if (body._tag === WS_METHODS.gitPreparePullRequestThread) {
          return {
            pullRequest: {
              number: 1359,
              title: "Add thread archiving and settings navigation",
              url: "https://github.com/sak0a/ryco/pull/1359",
              baseBranch: "main",
              headBranch: "archive-settings-overhaul",
              state: "open",
            },
            branch: "archive-settings-overhaul",
            worktreePath: "/repo/worktrees/pr-1359",
          };
        }
        return undefined;
      },
    });

    try {
      const branchButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "main",
          ) as HTMLButtonElement | null,
        "Unable to find branch selector button.",
      );
      await clickEnabledButton(branchButton, "Branch selector did not become actionable.");

      const branchInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );
      branchInput.focus();
      await page.getByPlaceholder("Search refs...").fill("1359");

      const checkoutItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "Checkout pull request",
          ) as HTMLSpanElement | null,
        "Unable to find checkout pull request option.",
      );
      checkoutItem.click();

      const worktreeButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Worktree",
          ) as HTMLButtonElement | null,
        "Unable to find Worktree button.",
      );
      await clickEnabledButton(
        worktreeButton,
        "Worktree preparation did not become actionable after resolving the pull request.",
      );

      await vi.waitFor(
        () => {
          const prepareRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitPreparePullRequestThread,
          );
          expect(prepareRequest).toMatchObject({
            _tag: WS_METHODS.gitPreparePullRequestThread,
            cwd: "/repo/project",
            reference: "1359",
            mode: "worktree",
            threadId: THREAD_ID,
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite && request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends bootstrap turn-starts and waits for server setup on first-send worktree drafts", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          ) as
            | {
                _tag: string;
                type?: string;
                bootstrap?: {
                  createThread?: { projectId?: string };
                  prepareWorktree?: {
                    projectCwd?: string;
                    baseBranch?: string;
                    branch?: string;
                  };
                  runSetupScript?: boolean;
                };
              }
            | undefined;
          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.turn.start",
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "origin/main",
                branch: expect.stringMatching(/^ryco\/[0-9a-f]{8}$/),
              },
              runSetupScript: true,
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      expect(wsRequests.some((request) => request._tag === WS_METHODS.vcsCreateWorktree)).toBe(
        false,
      );
      expect(
        wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalWrite &&
            request.threadId === THREAD_ID &&
            request.data === "bun install\r",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps custom provider instance ids when bootstrapping a local draft thread", async () => {
    setDraftThreadWithoutWorktree();
    const openRouterInstanceId = ProviderInstanceId.make("claude_openrouter");
    const openRouterSelection = createModelSelection(openRouterInstanceId, "openai/gpt-5.5");
    useComposerDraftStore.getState().setModelSelection(THREAD_REF, openRouterSelection);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: [
            ...nextFixture.serverConfig.providers,
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: ProviderInstanceId.make("claudeAgent"),
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [],
                  }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId: openRouterInstanceId,
              displayName: "Claude OpenRouter",
              enabled: true,
              installed: true,
              version: "2.1.117",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: NOW_ISO,
              models: [
                {
                  slug: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [],
                  }),
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ],
          settings: {
            ...nextFixture.serverConfig.settings,
            providerInstances: {
              ...nextFixture.serverConfig.settings.providerInstances,
              [openRouterInstanceId]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                displayName: "Claude OpenRouter",
                config: { customModels: ["openai/gpt-5.5"] },
              },
            },
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Hello there");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          const turnStartRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.start",
          ) as
            | {
                modelSelection?: { instanceId?: string; model?: string };
                bootstrap?: {
                  createThread?: {
                    modelSelection?: { instanceId?: string; model?: string };
                  };
                };
              }
            | undefined;

          expect(turnStartRequest?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
          expect(turnStartRequest?.bootstrap?.createThread?.modelSelection).toMatchObject({
            instanceId: openRouterInstanceId,
            model: "openai/gpt-5.5",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a worktree from the sidebar new workspace dialog", async () => {
    const createdThreadId = "thread-browser-test-created-worktree" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === WS_METHODS.gitCreateWorktreeForProject) {
          return {
            worktreeId: "worktree-browser-test-created",
            sessionId: createdThreadId,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByRole("button", { name: /Create worktree/ }).click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitCreateWorktreeForProject,
          ) as
            | {
                _tag: string;
                intent?: { kind?: string; branchName?: string };
                projectId?: string;
              }
            | undefined;

          expect(createWorktreeRequest).toMatchObject({
            _tag: WS_METHODS.gitCreateWorktreeForProject,
            projectId: PROJECT_ID,
            intent: {
              kind: "branch",
              branchName: "main",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(createdThreadId),
        "Route should switch to the created worktree session.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates the selected branch in the new workspace dialog before creation", async () => {
    const createdThreadId = "thread-browser-test-selected-worktree" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === WS_METHODS.gitCreateWorktreeForProject) {
          return {
            worktreeId: "worktree-browser-test-selected",
            sessionId: createdThreadId,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByText("release/next", { exact: true }).click();
      await page.getByRole("button", { name: /Create worktree/ }).click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.gitCreateWorktreeForProject,
          ) as
            | {
                _tag: string;
                intent?: { branchName?: string };
              }
            | undefined;

          expect(createWorktreeRequest?.intent?.branchName).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new workspace from-branch picker opaque when opened wide", async () => {
    const branches = [
      {
        name: "main",
        current: true,
        isDefault: true,
        worktreePath: null,
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        name: `feature/very-long-worktree-branch-selector-regression-${String(index).padStart(2, "0")}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      })),
    ];
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: branches.length,
            refs: branches,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByRole("tab", { name: "New branch" }).click();

      const fromBranchTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="combobox-trigger"]'))
            .filter((element) => element.getBoundingClientRect().width > 0)
            .find((element) => element.textContent?.includes("main")) ?? null,
        "Unable to find the new workspace from-branch selector trigger.",
      );

      await clickEnabledButton(
        fromBranchTrigger,
        "New workspace branch selector did not become actionable.",
      );
      await expectVisibleComboboxPopupToBeOpaqueAndClipped();
    } finally {
      await mounted.cleanup();
    }
  });

  it("ignores stale generated branch names after the base branch changes", async () => {
    let resolveGeneration!: (value: { branch: string }) => void;
    const generationPromise = new Promise<{ branch: string }>((resolve) => {
      resolveGeneration = resolve;
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === WS_METHODS.textGenerationGenerateBranchName) {
          return generationPromise;
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByRole("tab", { name: "New branch" }).click();
      await page.getByRole("button", { name: "Generate branch name" }).click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) => request._tag === WS_METHODS.textGenerationGenerateBranchName,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      const fromBranchTrigger = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="combobox-trigger"]'))
            .filter((element) => element.getBoundingClientRect().width > 0)
            .find((element) => element.textContent?.includes("main")) ?? null,
        "Unable to find the new workspace from-branch selector trigger.",
      );
      await clickEnabledButton(
        fromBranchTrigger,
        "New workspace branch selector did not become actionable.",
      );
      await page.getByText("release/next", { exact: true }).click();

      await vi.waitFor(
        () => {
          const releaseTrigger = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-slot="combobox-trigger"]'),
          )
            .filter((element) => element.getBoundingClientRect().width > 0)
            .find((element) => element.textContent?.includes("release/next"));
          expect(releaseTrigger).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );

      resolveGeneration({ branch: "stale/generated" });
      await waitForLayout();
      const branchNameInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="task/short-name"]'),
        "Unable to find new branch name input.",
      );

      await vi.waitFor(
        () => {
          expect(branchNameInput.value).toBe("");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves the selected branch when reopening the new workspace dialog", async () => {
    const createdThreadId = "thread-browser-test-reopened-worktree" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        if (body._tag === WS_METHODS.gitCreateWorktreeForProject) {
          return {
            worktreeId: "worktree-browser-test-reopened",
            sessionId: createdThreadId,
          };
        }
        return undefined;
      },
    });

    try {
      await openNewWorkspaceDialog();
      await page.getByText("release/next", { exact: true }).click();
      await page.getByText("Cancel", { exact: true }).click();

      await openNewWorkspaceDialog();
      await page.getByRole("button", { name: /Create worktree/ }).click();

      await vi.waitFor(
        () => {
          const createWorktreeRequest = wsRequests.findLast(
            (request) => request._tag === WS_METHODS.gitCreateWorktreeForProject,
          ) as
            | {
                _tag: string;
                intent?: { branchName?: string };
              }
            | undefined;

          expect(createWorktreeRequest?.intent?.branchName).toBe("release/next");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the send state once bootstrap dispatch is in flight", async () => {
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
    });
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [THREAD_KEY]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: THREAD_KEY,
      },
    });

    let resolveDispatch!: (value: { sequence: number }) => void;
    const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
      resolveDispatch = resolve;
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return dispatchPromise;
        }
        return undefined;
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
      await waitForLayout();

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand),
          ).toBe(true);
          expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
          expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
      await mounted.cleanup();
    }
  });

  it("uses the active draft route session when changing the base branch", async () => {
    const staleDraftId = draftIdFromPath("/draft/draft-stale-branch-session");
    const activeDraftId = draftIdFromPath("/draft/draft-active-branch-session");

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [staleDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: `${PROJECT_DRAFT_KEY}:stale`,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
        [activeDraftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [`${PROJECT_DRAFT_KEY}:stale`]: staleDraftId,
        [PROJECT_DRAFT_KEY]: activeDraftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${activeDraftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 2,
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: null,
              },
              {
                name: "release/next",
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          };
        }
        return undefined;
      },
    });

    try {
      const branchSection = await openCrownBranchSection();
      const branchButton = await waitForElement(
        () =>
          Array.from(branchSection.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From main",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From main".',
      );
      await clickEnabledButton(branchButton, "Branch selector did not become actionable.");

      const branchOption = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("span")).find(
            (element) => element.textContent?.trim() === "release/next",
          ) as HTMLSpanElement | null,
        'Unable to find the "release/next" branch option.',
      );
      branchOption.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftSession(activeDraftId)?.branch).toBe(
            "release/next",
          );
          expect(useComposerDraftStore.getState().getDraftSession(staleDraftId)?.branch).toBe(
            "main",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const updatedButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.trim().includes("From release/next"),
          );
          expect(updatedButton).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new worktree branch picker anchored at the top when opening with a preselected branch", async () => {
    const draftId = DraftId.make("draft-branch-picker-scroll-regression");
    const branches = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "main",
        current: false,
        isDefault: true,
        worktreePath: null,
      },
      ...Array.from({ length: 48 }, (_, index) => ({
        name: `feature/${String(index).padStart(2, "0")}`,
        current: false,
        isDefault: false,
        worktreePath: null,
      })),
      {
        name: "feature/selected",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/selected",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.vcsListRefs) {
          return {
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: branches.length,
            refs: branches,
          };
        }
        return undefined;
      },
    });

    try {
      const branchSection = await openCrownBranchSection();
      const branchButton = await waitForElement(
        () =>
          Array.from(branchSection.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "From feature/selected",
          ) as HTMLButtonElement | null,
        'Unable to find branch selector button with "From feature/selected".',
      );
      await clickEnabledButton(branchButton, "Branch selector did not become actionable.");

      await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
        "Unable to find ref search input.",
      );

      const popup = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
        "Unable to find the branch picker popup.",
      );

      await vi.waitFor(
        () => {
          const popupSpans = Array.from(popup.querySelectorAll("span"));
          expect(
            popupSpans.some((element) => element.textContent?.trim() === "feature/current"),
          ).toBe(true);
          expect(popupSpans.some((element) => element.textContent?.trim() === "main")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("greets an empty draft thread with the new-thread hero", async () => {
    const draftId = DraftId.make("draft-new-thread-hero");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
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
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      const hero = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero.",
      );

      expect(hero.textContent).toContain("What should we do in Project?");
    } finally {
      await mounted.cleanup();
    }
  });

  it("drops the new-thread hero once the thread has messages", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-hero-absent" as MessageId,
        targetText: "hero absent",
      }),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-timeline-root="true"]'),
        "Unable to find the rendered timeline.",
      );

      expect(document.querySelector('[data-testid="new-thread-hero"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches an empty draft into new-worktree mode and clears the stale worktree path", async () => {
    const draftId = DraftId.make("draft-env-mode-chip");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
          environmentId: LOCAL_ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: PROJECT_DRAFT_KEY,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/existing",
          // A draft attached to an existing worktree reads as "Local"; the chip
          // has to clear this path or the switch back to worktree mode is a
          // no-op once `resolveEffectiveEnvMode` runs again.
          worktreePath: "/repo/.ryco/worktrees/existing",
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      // The sentence names the directory even though no worktree summary
      // matches the path, rather than silently reading "the project root".
      const locationTrigger = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label^="Change where this thread runs"]',
          ),
        "Unable to find the work-location picker.",
      );
      expect(locationTrigger.textContent).toContain("existing");

      // The picker no longer offers "A new worktree"; the context bar's switch
      // above the composer is the one way in.
      locationTrigger.click();
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
        "Unable to find the work-location popup.",
      );
      expect(page.getByText("A new worktree", { exact: true }).query()).toBeNull();
      await userEvent.keyboard("{Escape}");

      const worktreeSwitch = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-testid="new-thread-context-bar"] button[role="switch"]',
          ),
        "Unable to find the new-worktree switch.",
      );
      expect(worktreeSwitch.getAttribute("aria-checked")).toBe("false");
      worktreeSwitch.click();

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
            envMode: "worktree",
            worktreePath: null,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the Crown rail on an empty thread and restores it on request", async () => {
    const draftId = DraftId.make("draft-empty-thread-overview");
    useComposerDraftStore.setState({
      draftThreadsByThreadKey: {
        [draftId]: {
          threadId: THREAD_ID,
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
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [PROJECT_DRAFT_KEY]: draftId,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      initialPath: `/draft/${draftId}`,
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero.",
      );

      // The overview describes a thread's history, so it stays out of the way
      // until there is one — or until the user explicitly asks for it.
      // Open state plus visibility, not DOM presence: the rail stays mounted
      // through its exit transition.
      const overviewShowing = () => {
        const crown = document.querySelector<HTMLElement>('[data-slot="crown-overview"]');
        const rail = crown?.querySelector('nav[aria-label="Overview"]');
        return crown?.dataset.state === "open" && rail != null && rail.checkVisibility();
      };
      await vi.waitFor(
        () => {
          expect(overviewShowing()).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );

      const overviewToggle = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Toggle overview panel"]'),
        "Unable to find the overview toggle.",
      );
      overviewToggle.click();

      await vi.waitFor(
        () => {
          expect(overviewShowing()).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the new-thread hero from the sidebar project row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-new-thread" as MessageId,
        targetText: "sidebar new thread",
      }),
    });

    try {
      const newThreadButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('[data-testid="new-thread-composer-button"]'),
        "Unable to find the sidebar new-thread button.",
      );
      newThreadButton.click();

      await vi.waitFor(
        () => {
          expect(mounted.router.state.location.pathname.startsWith("/draft/")).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-testid="new-thread-hero"]'),
        "Unable to find the new-thread hero after using the sidebar button.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh worktree draft from an existing worktree thread when the default mode is worktree", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }),
        threads: createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
          targetText: "new thread worktree default test",
        }).threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                branch: "feature/existing",
                worktreePath: "/repo/.ryco/worktrees/existing",
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        enableChatNewLocalShortcut(nextFixture);
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
        };
      },
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(useComposerDraftStore.getState().getDraftSession(newDraftId)).toMatchObject({
        envMode: "worktree",
        worktreePath: null,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new draft instead of reusing a promoting draft thread", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoting-draft-new-thread-test" as MessageId,
        targetText: "promoting draft new thread test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const firstDraftPath = await createDraftFromChatNewLocalShortcut(mounted);
      const firstDraftId = draftIdFromPath(firstDraftPath);
      const firstThreadId = draftThreadIdFor(firstDraftId);

      await materializePromotedDraftThreadViaDomainEvent(firstThreadId);
      expect(mounted.router.state.location.pathname).toBe(firstDraftPath);

      const secondDraftPath = await triggerChatNewLocalShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== firstDraftPath,
        "Route should change to a second draft thread instead of reusing the promoting draft.",
      );
      expect(draftIdFromPath(secondDraftPath)).not.toBe(firstDraftId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.3-codex",
          [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      // `toMatchObject` matches objects loosely (extras ignored) but compares
      // arrays strictly, so wrap `options` in `arrayContaining` to keep the
      // assertion focused on sticky `fastMode` carrying over without asserting
      // on exactly which other options are preserved.
      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("claudeAgent")]: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("claudeAgent"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);

      expect(composerDraftFor(newDraftId)).toBe(undefined);
    } finally {
      await mounted.cleanup();
    }
  });

  it("prefers draft state over sticky composer settings and defaults", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("codex")]: createModelSelection(
          ProviderInstanceId.make("codex"),
          "gpt-5.3-codex",
          [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        ),
      },
      stickyActiveProvider: ProviderInstanceId.make("codex"),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const threadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const draftId = draftIdFromPath(threadPath);

      // See the note on the sibling sticky-codex test: arrays match strictly
      // under `toMatchObject`, so use `arrayContaining` to keep the assertion
      // scoped to the sticky trait (`fastMode`) that must carry over.
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: expect.arrayContaining([{ id: "fastMode", value: true }]),
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(
        draftId,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ]),
      );

      await triggerChatNewLocalShortcutUntilPath(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      expect(composerDraftFor(draftId)).toMatchObject({
        modelSelectionByProvider: {
          codex: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "low" },
            { id: "fastMode", value: true },
          ]),
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        enableChatNewShortcut(nextFixture);
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [CHAT_NEW_KEYBINDING],
        };
      },
    });

    try {
      const promotedThreadPath = await createDraftFromChatNewShortcut(mounted);
      const promotedDraftId = draftIdFromPath(promotedThreadPath);
      const promotedThreadId = draftThreadIdFor(promotedDraftId);

      await materializePromotedDraftThreadViaDomainEvent(promotedThreadId);
      await startPromotedServerThreadViaDomainEvent(promotedThreadId);
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(promotedThreadId),
        "Promoted drafts should canonicalize to the server thread route before a fresh draft is created.",
      );
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().getDraftThread(promotedDraftId)).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });
});
