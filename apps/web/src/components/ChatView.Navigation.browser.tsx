import { useChatPanesStore } from "../chatPanesStore";
import { paneLeaves } from "../chatPanes.logic";
import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ThreadId,
  WS_METHODS,
} from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { __setEnvironmentApiOverrideForTests } from "../environmentApi";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { isMacPlatform } from "../lib/utils";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  setupChatViewBrowserSuite,
  ADD_PROJECT_SUBMENU_PLACEHOLDER,
  CHAT_NEW_KEYBINDING,
  COMPOSER_STASH_KEYBINDING,
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  NOW_ISO,
  PROJECT_ID,
  PROJECT_LOGICAL_KEY,
  REMOTE_ENVIRONMENT_ID,
  SECOND_PROJECT_ID,
  SECOND_PROJECT_LOGICAL_KEY,
  THREAD_ID,
  THREAD_KEY,
  THREAD_PIN_TOGGLE_KEYBINDING,
  THREAD_REF,
  UUID_ROUTE_RE,
  addThreadToSnapshot,
  composerDraftFor,
  createDraftFromChatNewLocalShortcut,
  createDraftFromChatNewShortcut,
  createDraftOnlySnapshot,
  createMockEnvironmentApi,
  createProjectlessSnapshot,
  createSnapshotForTargetUser,
  createSnapshotWithSecondaryProject,
  dispatchChatNewShortcut,
  dispatchInputKey,
  dispatchThreadPinToggleShortcut,
  draftIdFromPath,
  draftThreadIdFor,
  enableChatNewLocalShortcut,
  enableChatNewShortcut,
  fixture,
  getCommandPaletteLegendEntries,
  materializePromotedDraftThreadViaDomainEvent,
  mountChatView,
  openCommandPaletteFromTrigger,
  selectionSnapshot,
  serverThreadPath,
  startPromotedServerThreadViaDomainEvent,
  threadKeyFor,
  threadRefFor,
  waitForCommandPaletteInput,
  waitForCommandPaletteShortcutLabel,
  waitForComposerEditor,
  waitForElement,
  waitForLayout,
  waitForServerConfigToApply,
  waitForURL,
  waitForWsRequestsToSettle,
  wsRequests,
} from "./ChatView.browser.helpers";

// Hoisted per suite: a mock registered from the shared helpers runs after this file's static imports.
vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

describe("ChatView Navigation (full app)", () => {
  setupChatViewBrowserSuite();

  it("pane focus isolates real thread search and preserves neighboring composer drafts", async () => {
    const other = "pane-other-thread" as ThreadId;
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1600, height: 1000 },
      snapshot: addThreadToSnapshot(selectionSnapshot(), other),
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          keybindings: [
            {
              ...COMPOSER_STASH_KEYBINDING,
              command: "thread.find",
              shortcut: { ...COMPOSER_STASH_KEYBINDING.shortcut, key: "f" },
            },
          ],
        };
      },
    });
    try {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "First pane draft");
      useComposerDraftStore.getState().setPrompt(threadRefFor(other), "Second pane draft");
      useChatPanesStore.getState().open(threadRefFor(other), "right", THREAD_REF);
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('[data-pane-thread] [data-testid="composer-editor"]').length,
        ).toBe(2),
      );
      const pane = document.querySelector<HTMLElement>(
        `[data-pane-thread="${threadKeyFor(other)}"]`,
      )!;
      pane.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
      await vi.waitFor(() => expect(pane.dataset.paneFocused).toBe("true"));
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          metaKey: isMacPlatform(navigator.platform),
          ctrlKey: !isMacPlatform(navigator.platform),
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() =>
        expect(pane.querySelector('[data-thread-message-search="true"]')).not.toBeNull(),
      );
      expect(document.querySelectorAll('[data-thread-message-search="true"]')).toHaveLength(1);
      expect(composerDraftFor(THREAD_KEY)?.prompt).toBe("First pane draft");
      expect(composerDraftFor(threadKeyFor(other))?.prompt).toBe("Second pane draft");
    } finally {
      await mounted.cleanup();
    }
  });

  it("pane grid remains usable at four views and narrows without losing drafts", async () => {
    const ids = ["pane-b", "pane-c", "pane-d"] as ThreadId[];
    const snapshot = ids.reduce<OrchestrationReadModel>(
      (snapshot, id) => addThreadToSnapshot(snapshot, id),
      selectionSnapshot(),
    );
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1600, height: 1000 },
      snapshot,
    });
    try {
      const panes = useChatPanesStore.getState();
      panes.open(threadRefFor(ids[0]!), "right", THREAD_REF);
      panes.open(threadRefFor(ids[1]!), "bottom", THREAD_REF);
      panes.open(threadRefFor(ids[2]!), "bottom", threadRefFor(ids[0]!));
      await vi.waitFor(() =>
        expect(
          document.querySelectorAll('[data-pane-thread] [data-testid="composer-editor"]').length,
        ).toBe(4),
      );
      await waitForLayout();
      await mounted.setViewport({ ...DEFAULT_VIEWPORT, width: 1000, height: 800 });
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-pane-thread]:not([hidden])")).toHaveLength(1),
      );
      expect(paneLeaves(useChatPanesStore.getState().root!)).toHaveLength(4);
    } finally {
      await mounted.cleanup();
    }
  });

  it("pane layout retains a detached local draft and an omitted server thread across snapshots", async () => {
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1600, height: 1000 },
      snapshot: selectionSnapshot(),
    });
    try {
      const drafts = useComposerDraftStore.getState();
      const draftId = DraftId.make("pane-detached-draft");
      drafts.setLogicalProjectDraftThreadId(
        PROJECT_LOGICAL_KEY,
        { environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID },
        draftId,
      );
      drafts.setPrompt(draftId, "Unsent detached work");
      const session = drafts.getDraftSession(draftId)!;
      const draftRef = threadRefFor(session.threadId);
      useChatPanesStore.getState().open(draftRef, "right", THREAD_REF);
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-pane-thread]")).toHaveLength(2),
      );
      // A replacing shell omits a thread; omission must not retire its pane.
      useStore.getState().removeThread(THREAD_REF);
      await waitForLayout();
      expect(paneLeaves(useChatPanesStore.getState().root!)).toEqual([THREAD_REF, draftRef]);
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
        "Unsent detached work",
      );
      const pane = document.querySelector<HTMLElement>(
        `[data-pane-thread="${threadKeyFor(session.threadId)}"]`,
      )!;
      pane.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
      await vi.waitFor(() => expect(pane.dataset.paneFocused).toBe("true"));
      expect(pane.textContent).not.toContain("Thread unavailable");
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
        "Unsent detached work",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a cached hosted thread visible while its node reconnects", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-cached-cross-node" as MessageId,
        targetText: "cached cross-node switch target",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();

      // Hosted A -> B disposal keeps thread detail in memory but marks the
      // old environment non-live until its next relay bootstrap.
      useStore.getState().demoteEnvironmentStateToCachedSnapshot(LOCAL_ENVIRONMENT_ID, Date.now());
      await waitForLayout();

      expect(useStore.getState().environmentStateById[LOCAL_ENVIRONMENT_ID]).toMatchObject({
        bootstrapComplete: false,
      });
      expect(composerEditor.isConnected).toBe(true);
      expect(await waitForComposerEditor()).toBe(composerEditor);
    } finally {
      await mounted.cleanup();
    }
  });

  it("re-expands the bootstrap project using its logical key", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [PROJECT_LOGICAL_KEY]: false,
      },
      projectOrder: [PROJECT_LOGICAL_KEY],
      threadLastVisitedAtById: {},
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap-project-expand" as MessageId,
        targetText: "bootstrap project expand",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(useUiStateStore.getState().projectExpandedById[PROJECT_LOGICAL_KEY]).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the sidebar project available when the snapshot has no server threads", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await expect.element(page.getByText("Project", { exact: true })).toBeInTheDocument();
      expect(document.querySelector('[data-testid="thread-row-thread-browser-test"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves Inbox filters across sidebar mode changes without workspace churn", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-modes" as MessageId,
        targetText: "sidebar modes",
      }),
    });

    try {
      const projectTrigger = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-add-project-trigger"]',
      );
      expect(projectTrigger?.checkVisibility()).toBe(true);
      expect(
        document.querySelector<HTMLElement>('[data-testid="inbox-sidebar"]')?.checkVisibility(),
      ).toBe(false);
      await waitForWsRequestsToSettle();
      const stableRequestTags = [
        ORCHESTRATION_WS_METHODS.subscribeShell,
        WS_METHODS.subscribeServerConfig,
        WS_METHODS.subscribeServerLifecycle,
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverGetSettings,
      ];
      const countStableRequests = () =>
        stableRequestTags.map((tag) => wsRequests.filter((request) => request._tag === tag).length);
      const stableRequestCountsBeforeSwitch = countStableRequests();

      const showInboxButton = page.getByRole("button", { name: "Show Inbox sidebar" });
      await expect.element(showInboxButton).toHaveAttribute("aria-pressed", "false");
      await showInboxButton.click();

      await expect.element(page.getByTestId("inbox-sidebar")).toBeInTheDocument();
      expect(projectTrigger?.checkVisibility()).toBe(false);
      await page.getByRole("searchbox", { name: "Search inbox" }).fill("preserved search");
      expect(useUiStateStore.getState().sidebarMode).toBe("inbox");

      const showProjectsButton = page.getByRole("button", { name: "Show Projects sidebar" });
      await expect.element(showProjectsButton).toHaveAttribute("aria-pressed", "true");
      await showProjectsButton.click();
      expect(useUiStateStore.getState().sidebarMode).toBe("projects");
      expect(
        document.querySelector<HTMLElement>('[data-testid="inbox-sidebar"]')?.checkVisibility(),
      ).toBe(false);
      expect(
        document
          .querySelector<HTMLElement>('[data-testid="sidebar-add-project-trigger"]')
          ?.checkVisibility(),
      ).toBe(true);
      await waitForWsRequestsToSettle();
      await showInboxButton.click();
      await expect
        .element(page.getByRole("searchbox", { name: "Search inbox" }))
        .toHaveValue("preserved search");
      expect(countStableRequests()).toEqual(stableRequestCountsBeforeSwitch);
    } finally {
      await mounted.cleanup();
    }
  });

  it("pins and renames a thread from the Inbox action menu", async () => {
    useUiStateStore.setState({ sidebarMode: "inbox" });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-inbox-actions" as MessageId,
        targetText: "inbox actions",
      }),
    });
    try {
      const row = page.getByTestId("inbox-thread-row").first();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Pin thread", exact: true }).click();
      await vi.waitFor(() =>
        expect(
          useUiStateStore.getState().pinnedThreadKeys[
            scopedThreadKey(scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID))
          ],
        ).toBe(true),
      );
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="context-menu-popup"]')).toBeNull(),
      );
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename thread", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Thread title", exact: true })
        .fill("Renamed inbox thread");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await vi.waitFor(() =>
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              JSON.stringify(request).includes("Renamed inbox thread"),
          ),
        ).toBe(true),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens an Inbox row through its exact scoped route", async () => {
    useUiStateStore.setState({ sidebarMode: "inbox" });
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-inbox-navigation" as MessageId,
      targetText: "inbox navigation",
    });
    const sourceThread = snapshot.threads[0]!;
    const inboxThreadId = "thread-inbox-target" as ThreadId;
    const inboxSiblingThreadId = "thread-inbox-sibling" as ThreadId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: [
          sourceThread,
          {
            ...sourceThread,
            id: inboxThreadId,
            title: "Inbox exact target",
            createdAt: "2026-08-23T09:00:00.000Z",
            updatedAt: "2026-08-23T11:00:00.000Z",
          },
          {
            ...sourceThread,
            id: inboxSiblingThreadId,
            title: "Inbox motion sibling",
            createdAt: "2026-08-23T08:00:00.000Z",
            updatedAt: "2026-08-23T10:00:00.000Z",
          },
        ],
      },
    });

    try {
      const rows = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="inbox-thread-row"]'),
      );
      const rowIndex = rows.findIndex((candidate) =>
        candidate.textContent?.includes("Inbox exact target"),
      );
      const row = rows[rowIndex];
      const rowLocator = page.getByTestId("inbox-thread-row").nth(rowIndex);
      const siblingRow = rows.find((candidate) =>
        candidate.textContent?.includes("Inbox motion sibling"),
      );
      expect(row).toBeDefined();
      expect(siblingRow).toBeDefined();
      expect(row?.textContent).toContain("Studio Mac");
      expect(row?.textContent).toContain("Project");
      expect(row?.textContent).toContain("main");
      expect(row?.textContent).toContain("Idle");
      expect(row?.className).toContain("hover:-translate-y-px");
      expect(row?.className).toContain("motion-reduce:translate-none");
      expect(row?.className).toContain("group/row");

      expect(row?.querySelector('[class*="group-hover/row:opacity-100"]')).toBeNull();
      expect(siblingRow?.querySelector('[class*="group-hover/row:opacity-100"]')).toBeNull();

      // Tailwind v4 guards hover utilities with `(hover: hover)`. Linux
      // headless Chromium can still report no hover device even though
      // Playwright can dispatch a mouse; exercise the motion only when the
      // same media query that guards the production CSS is active.
      if (
        window.matchMedia("(hover: hover)").matches &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        const restingTranslate = getComputedStyle(row!).translate;
        await rowLocator.hover();
        await vi.waitFor(() => {
          expect(getComputedStyle(row!).translate).not.toBe(restingTranslate);
        });
      }

      await rowLocator.click();
      await vi.waitFor(() => {
        expect(mounted.router.state.location.pathname).toBe(
          `/${LOCAL_ENVIRONMENT_ID}/${inboxThreadId}`,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes promoted draft threads to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // `thread.created` should only mark the draft as promoting; it should
      // not navigate away until the server thread has actual runtime state.
      await materializePromotedDraftThreadViaDomainEvent(newThreadId);
      expect(mounted.router.state.location.pathname).toBe(newThreadPath);
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

      // Once the server thread starts, the route should canonicalize.
      await startPromotedServerThreadViaDomainEvent(newThreadId);

      // The route should switch to the canonical server thread path.
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Promoted drafts should canonicalize to the server thread route.",
      );

      // The composer should remain usable after canonicalization, regardless of
      // whether the promoted thread is still visibly empty or has already
      // entered the running state.
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("canonicalizes stale promoted draft routes to the server thread route", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-hydration-race-test" as MessageId,
        targetText: "draft hydration race test",
      }),
      configureFixture: enableChatNewLocalShortcut,
    });

    try {
      const newThreadPath = await createDraftFromChatNewLocalShortcut(mounted);
      const newDraftId = draftIdFromPath(newThreadPath);
      const newThreadId = draftThreadIdFor(newDraftId);

      await materializePromotedDraftThreadViaDomainEvent(newThreadId);

      await mounted.router.navigate({
        to: "/draft/$draftId",
        params: { draftId: newDraftId },
      });

      await startPromotedServerThreadViaDomainEvent(newThreadId);

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(newThreadId),
        "Stale promoted draft routes should canonicalize to the server thread path.",
      );

      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        enableChatNewShortcut(nextFixture);
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            CHAT_NEW_KEYBINDING,
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
        };
      },
    });

    try {
      await createDraftFromChatNewShortcut(mounted);
    } finally {
      await mounted.cleanup();
    }
  });

  it("pins from the global shortcut and exposes the matching palette action", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-pin-shortcut-test" as MessageId,
        targetText: "thread pin shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [THREAD_PIN_TOGGLE_KEYBINDING],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      expect(useUiStateStore.getState().pinnedThreadKeys[THREAD_KEY]).not.toBe(true);

      dispatchThreadPinToggleShortcut();
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().pinnedThreadKeys[THREAD_KEY]).toBe(true);
      });

      useCommandPaletteStore.getState().setOpen(true);
      const palette = page.getByTestId("command-palette");
      const unpinAction = palette.getByText("Unpin current thread", { exact: true });
      await expect.element(unpinAction).toBeInTheDocument();
      await unpinAction.click();
      await vi.waitFor(() => {
        expect(useUiStateStore.getState().pinnedThreadKeys[THREAD_KEY]).not.toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not consume chat.new when there is no project context", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createProjectlessSnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      dispatchChatNewShortcut();
      await waitForLayout();

      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
      expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the configurable shortcut and runs a command from the sidebar trigger", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-shortcut-test" as MessageId,
        targetText: "command palette shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("New thread in Project", { exact: true }).click();

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the command palette.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("switches sidebar modes from command-palette actions", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-sidebar-mode" as MessageId,
        targetText: "command palette sidebar mode",
      }),
    });

    try {
      await openCommandPaletteFromTrigger();
      const palette = page.getByTestId("command-palette");
      await waitForWsRequestsToSettle();
      const requestCountBeforeInboxSwitch = wsRequests.length;
      await palette.getByText("Show Inbox sidebar", { exact: true }).click();

      await vi.waitFor(() => expect(useUiStateStore.getState().sidebarMode).toBe("inbox"));
      await expect.element(page.getByTestId("inbox-sidebar")).toBeInTheDocument();
      expect(useCommandPaletteStore.getState().open).toBe(false);
      expect(wsRequests).toHaveLength(requestCountBeforeInboxSwitch);

      useCommandPaletteStore.getState().setOpen(true);
      await waitForElement(
        () => document.querySelector('[data-testid="command-palette"]'),
        "Command palette should have reopened from Inbox mode.",
      );
      await waitForWsRequestsToSettle();
      const requestCountBeforeProjectsSwitch = wsRequests.length;
      await palette.getByText("Show Projects sidebar", { exact: true }).click();
      await vi.waitFor(() => expect(useUiStateStore.getState().sidebarMode).toBe("projects"));
      expect(
        document
          .querySelector<HTMLElement>('[data-testid="sidebar-add-project-trigger"]')
          ?.checkVisibility(),
      ).toBe(true);
      expect(wsRequests).toHaveLength(requestCountBeforeProjectsSwitch);
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters command palette results as the user types", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-search-test" as MessageId,
        targetText: "command palette search test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("settings");
      await expect.element(palette.getByText("Open settings", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("New thread in Project", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Enter when no directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-enter" as MessageId,
        targetText: "command palette add project enter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            projectMetadataDir: ".ryco",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows clone destination controls after resolving an add project repository", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-remote" as MessageId,
        targetText: "command palette add project remote",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === WS_METHODS.sourceControlLookupRepository) {
          return {
            provider: "github",
            nameWithOwner: "openai/codex",
            url: "https://github.com/openai/codex",
            sshUrl: "git@github.com:openai/codex.git",
          };
        }

        if (body._tag === WS_METHODS.sourceControlCloneRepository) {
          return {
            cwd: body.destinationPath,
            remoteUrl: body.remoteUrl,
            repository: null,
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("GitHub repository", { exact: true }).click();

      const repositoryInput = await waitForCommandPaletteInput(
        "Enter GitHub repository (owner/repo)",
      );
      await page.getByPlaceholder("Enter GitHub repository (owner/repo)").fill("openai/codex");
      await dispatchInputKey(repositoryInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const clonePathInput = document.querySelector<HTMLInputElement>(
            'input[placeholder="Enter path (e.g. ~/projects/my-app)"]',
          );
          expect(clonePathInput?.value).toBe("~/");
          expect(document.body.textContent).toContain("Repository");
          expect(document.body.textContent).toContain("openai/codex");
          expect(document.body.textContent).toContain("https://github.com/openai/codex");
          expect(document.body.textContent).toContain("Select where to clone");
          expect(document.body.textContent).toContain("Development");
          expect(document.body.textContent).toContain("Clone");
        },
        { timeout: 8_000, interval: 16 },
      );

      await page
        .getByPlaceholder("Enter path (e.g. ~/projects/my-app)")
        .fill("~/Development/codex");
      const clonePathInput = await waitForCommandPaletteInput(
        "Enter path (e.g. ~/projects/my-app)",
      );
      await dispatchInputKey(clonePathInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const cloneRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.sourceControlCloneRepository,
          ) as { destinationPath?: string; remoteUrl?: string } | undefined;
          expect(cloneRequest).toMatchObject({
            remoteUrl: "git@github.com:openai/codex.git",
            destinationPath: "~/Development/codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens add project browse mode from the sidebar add button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-trigger" as MessageId,
        targetText: "sidebar add project trigger",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse && request.partialPath === "~/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts add project browse mode from the configured base directory", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-custom-base-dir" as MessageId,
        targetText: "sidebar add project custom base directory",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            addProjectBaseDirectory: "~/Development",
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [{ name: "codething", fullPath: "~/Development/codething" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/Development/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("starts restricted browsing at the access root and hides parent navigation there", async () => {
    const workspaceAccessRoot = "/allowed/workspace";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sidebar-add-project-restricted-root" as MessageId,
        targetText: "sidebar add project restricted root",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          workspaceAccessRoot,
          settings: {
            ...nextFixture.serverConfig.settings,
            addProjectBaseDirectory: "~/Development",
          },
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          return {
            parentPath: workspaceAccessRoot,
            workspaceAccessRoot,
            entries: [{ name: "project", fullPath: `${workspaceAccessRoot}/project` }],
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue(`${workspaceAccessRoot}/`);
      await expect.element(palette.getByText("..", { exact: true })).not.toBeInTheDocument();

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === `${workspaceAccessRoot}/`,
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows create-folder affordances for missing project paths", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-create-missing-project" as MessageId,
        targetText: "command palette create missing project",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Desktop/") {
            return {
              parentPath: "~/Desktop/",
              entries: [{ name: "existing", fullPath: "~/Desktop/existing" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Desktop", fullPath: "~/Desktop" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Desktop/fresh-project");

      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .toBeInTheDocument();
      await expect.element(palette.getByText("Will create this folder")).not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
                createWorkspaceRootIfMissing?: boolean;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Desktop/fresh-project",
            projectMetadataDir: ".ryco",
            title: "fresh-project",
            createWorkspaceRootIfMissing: true,
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not show create affordances for an existing directory with a trailing slash", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-existing-trailing-directory" as MessageId,
        targetText: "command palette existing trailing directory",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/codex/") {
            return {
              parentPath: "~/Development/codex/",
              entries: [
                {
                  name: "Codex.app",
                  fullPath: "~/Development/codex/Codex.app",
                },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      const palette = page.getByTestId("command-palette");
      await page.getByTestId("sidebar-add-project-trigger").click();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/codex/");

      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.filesystemBrowse &&
                request.partialPath === "~/Development/codex/",
            ),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
        .not.toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development/codex",
            projectMetadataDir: ".ryco",
            title: "codex",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects an environment before browsing when multiple environments are available", async () => {
    const remoteBrowseMock = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "~/workspaces/") {
        return {
          parentPath: "~/workspaces/",
          entries: [{ name: "codething", fullPath: "~/workspaces/codething" }],
        };
      }

      return {
        parentPath: "~/",
        entries: [{ name: "workspaces", fullPath: "~/workspaces" }],
      };
    });
    const remoteDispatchMock = vi.fn(async () => ({
      sequence: fixture.snapshot.snapshotSequence + 1,
    }));

    __setEnvironmentApiOverrideForTests(
      REMOTE_ENVIRONMENT_ID,
      createMockEnvironmentApi({
        browse: remoteBrowseMock,
        dispatchCommand: remoteDispatchMock,
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-multi-env" as MessageId,
        targetText: "command palette add project multi env",
      }),
    });

    try {
      await waitForServerConfigToApply();
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId: REMOTE_ENVIRONMENT_ID,
        label: "Staging",
        httpBaseUrl: "https://staging.example.test",
        wsBaseUrl: "wss://staging.example.test/ws",
        createdAt: NOW_ISO,
        lastConnectedAt: NOW_ISO,
      });
      useSavedEnvironmentRuntimeStore.getState().patch(REMOTE_ENVIRONMENT_ID, {
        connectionState: "connected",
        authState: "authenticated",
        descriptor: {
          ...fixture.serverConfig.environment,
          environmentId: REMOTE_ENVIRONMENT_ID,
          label: "Staging",
        },
        serverConfig: {
          ...fixture.serverConfig,
          environment: {
            ...fixture.serverConfig.environment,
            environmentId: REMOTE_ENVIRONMENT_ID,
            label: "Staging",
          },
          settings: {
            ...fixture.serverConfig.settings,
            addProjectBaseDirectory: "~/workspaces",
          },
        },
        connectedAt: NOW_ISO,
      });

      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await expect.element(palette.getByText("Environments", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("Studio Mac", { exact: true }).first())
        .toBeInTheDocument();
      await palette.getByText("Staging", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await expect.element(browseInput).toHaveValue("~/workspaces/");

      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({
            partialPath: "~/workspaces/",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/workspaces/");
      await vi.waitFor(
        () => {
          expect(remoteBrowseMock).toHaveBeenCalledWith({
            partialPath: "~/workspaces/",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(palette.getByText("codething", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByRole("button", { name: "Add (Enter)" }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "Enter" });

      await vi.waitFor(
        () => {
          expect(remoteDispatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "project.create",
              workspaceRoot: "~/workspaces",
              projectMetadataDir: ".ryco",
              title: "workspaces",
            }),
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a remote project.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("picks a local project from the native file manager", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/Users/julius/Projects/finder-picked");

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-file-manager" as MessageId,
        targetText: "command palette add project file manager",
      }),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Applications/") {
            return {
              parentPath: "~/Applications/",
              entries: [{ name: "Utilities", fullPath: "~/Applications/Utilities" }],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Applications", fullPath: "~/Applications" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      window.desktopBridge = {
        pickFolder,
        setTheme: vi.fn().mockResolvedValue(undefined),
      } as unknown as NonNullable<typeof window.desktopBridge>;

      await page.getByTestId("sidebar-add-project-trigger").click();

      const palette = page.getByTestId("command-palette");
      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Local folder", { exact: true }).click();
      const browseInput = palette.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await browseInput.fill("~/Applications/access");

      const fileManagerLabel = isMacPlatform(navigator.platform)
        ? "Open in Finder"
        : navigator.platform.toLowerCase().startsWith("win")
          ? "Open in Explorer"
          : "Open in Files";
      await palette.getByRole("button", { name: fileManagerLabel }).click();

      await vi.waitFor(
        () => {
          expect(pickFolder).toHaveBeenCalledWith({
            initialPath: "~/Applications",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "/Users/julius/Projects/finder-picked",
            projectMetadataDir: ".ryco",
            title: "finder-picked",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project from the native file manager.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("adds a project from browse mode with Mod+Enter when a directory is highlighted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-add-project-mod-enter" as MessageId,
        targetText: "command palette add project mod enter",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.filesystemBrowse) {
          if (body.partialPath === "~/Development/") {
            return {
              parentPath: "~/Development/",
              entries: [
                { name: "alpha", fullPath: "~/Development/alpha" },
                { name: "beta", fullPath: "~/Development/beta" },
              ],
            };
          }

          return {
            parentPath: "~/",
            entries: [{ name: "Development", fullPath: "~/Development" }],
          };
        }

        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: fixture.snapshot.snapshotSequence + 1,
          };
        }

        return undefined;
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await palette.getByText("Add project", { exact: true }).click();
      await palette.getByText("Local folder", { exact: true }).click();

      const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
      await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
      await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

      await dispatchInputKey(browseInput, { key: "ArrowDown" });

      const addButtonLabel = isMacPlatform(navigator.platform)
        ? "Add (\u2318 Enter)"
        : "Add (Ctrl Enter)";
      await vi.waitFor(
        () => {
          const legendEntries = getCommandPaletteLegendEntries();
          expect(legendEntries).toContain("Enter Select");
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(palette.getByRole("button", { name: addButtonLabel }))
        .toBeInTheDocument();

      await dispatchInputKey(browseInput, {
        key: "Enter",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
      });

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "project.create",
          ) as
            | {
                _tag: string;
                type?: string;
                workspaceRoot?: string;
                title?: string;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "project.create",
            workspaceRoot: "~/Development",
            projectMetadataDir: ".ryco",
            title: "Development",
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread after adding a project with Mod+Enter.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps project-context thread matches available when searching by project name", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("Release checklist", { exact: true }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches projects by path and opens the latest thread for that project", async () => {
    useUiStateStore.setState({
      projectExpandedById: {
        [SECOND_PROJECT_LOGICAL_KEY]: false,
      },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath("thread-secondary-project" as ThreadId),
        "Route should have changed to the latest thread for the selected project.",
      );
      expect(nextPath).toBe(serverThreadPath("thread-secondary-project" as ThreadId));
      expect(useUiStateStore.getState().projectExpandedById[SECOND_PROJECT_LOGICAL_KEY]).toBe(true);
      expect(
        useComposerDraftStore
          .getState()
          .getDraftThread(threadRefFor("thread-secondary-project" as ThreadId)),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from project search when no active project thread exists", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject({
        includeSecondaryThread: false,
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          settings: {
            ...nextFixture.serverConfig.settings,
            defaultThreadEnvMode: "worktree",
          },
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("clients/docs");
      await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
      await expect
        .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
        .toBeInTheDocument();
      await palette.getByText("Docs Portal", { exact: true }).click();

      const nextPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the project search result.",
      );
      const nextDraftId = draftIdFromPath(nextPath);
      const draftThread = useComposerDraftStore.getState().getDraftSession(nextDraftId);
      expect(draftThread?.projectId).toBe(SECOND_PROJECT_ID);
      expect(draftThread?.envMode).toBe("worktree");
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters archived threads out of command palette search results", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithSecondaryProject(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "commandPalette.toggle",
              shortcut: {
                key: "k",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForCommandPaletteShortcutLabel();
      const palette = page.getByTestId("command-palette");
      await openCommandPaletteFromTrigger();

      await expect.element(palette).toBeInTheDocument();
      await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs-archive");
      await expect
        .element(palette.getByText("Archived Docs Notes", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
