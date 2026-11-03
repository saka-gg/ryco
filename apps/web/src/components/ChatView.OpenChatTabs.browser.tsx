import { type MessageId, ThreadId } from "@ryco/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@ryco/contracts/settings";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  decodeOpenChatTabs,
  OPEN_CHAT_TABS_STORAGE_KEY,
} from "@ryco/client-runtime/state/threads/openChatTabs";
import { describe, expect, it, vi } from "vite-plus/test";

import { useChatPanesStore } from "../chatPanesStore";
import { isMacPlatform } from "../lib/utils";
import { useOpenChatTabsStore } from "../openChatTabsStore";
import {
  DEFAULT_VIEWPORT,
  LOCAL_ENVIRONMENT_ID,
  THREAD_ID,
  THREAD_TITLE,
  addThreadToSnapshot,
  createSnapshotForTargetUser,
  mountChatView,
  nextFrame,
  serverThreadPath,
  setupChatViewBrowserSuite,
  waitForLayout,
  waitForURL,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

const SECOND_ID = ThreadId.make("thread-tab-second");
const THIRD_ID = ThreadId.make("thread-tab-third");
const SECOND_TITLE = "Second tab";
const THIRD_TITLE = "Third tab";
const WIDE_VIEWPORT = { ...DEFAULT_VIEWPORT, width: 1600, height: 1000 };

const refOf = (threadId: ThreadId) => scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);

function tabsSnapshot() {
  let snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-open-chat-tabs" as MessageId,
    targetText: "open chat tabs",
  });
  snapshot = addThreadToSnapshot(addThreadToSnapshot(snapshot, SECOND_ID), THIRD_ID);
  const titles = new Map<string, string>([
    [SECOND_ID, SECOND_TITLE],
    [THIRD_ID, THIRD_TITLE],
  ]);
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      Object.assign({}, thread, { title: titles.get(thread.id) ?? thread.title }),
    ),
  };
}

const STRIP = 'header nav[aria-label="Open chats"]';

function tabLabelButtons(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      `${STRIP} [data-content-tab] > button:not([aria-label])`,
    ),
  ];
}

const tabLabels = () => tabLabelButtons().map((button) => button.textContent);

const activeTabLabel = () =>
  document.querySelector(`${STRIP} button[aria-current="page"]`)?.textContent ?? null;

function tabChip(title: string): HTMLElement {
  const chip = tabLabelButtons()
    .find((button) => button.textContent === title)
    ?.closest<HTMLElement>("[data-content-tab]");
  if (!chip) throw new Error(`No tab named ${title}.`);
  return chip;
}

const storedThreadIds = () => useOpenChatTabsStore.getState().refs.map((ref) => ref.threadId);

function mousePointerEvent(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

/** The default next/previous chord of this platform (Cmd+Ctrl+arrows on macOS). */
function pressTabKey(direction: "next" | "previous") {
  const mac = isMacPlatform(navigator.platform);
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: mac
        ? direction === "next"
          ? "ArrowRight"
          : "ArrowLeft"
        : direction === "next"
          ? "PageDown"
          : "PageUp",
      metaKey: mac,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function mountWithTabs(
  open: readonly ThreadId[],
  options: { viewport?: typeof DEFAULT_VIEWPORT } = {},
) {
  useOpenChatTabsStore.setState({ refs: open.map(refOf) });
  const mounted = await mountChatView({
    viewport: options.viewport ?? DEFAULT_VIEWPORT,
    snapshot: tabsSnapshot(),
  });
  await vi.waitFor(() => expect(tabLabels()).toHaveLength(open.length));
  await waitForLayout();
  return mounted;
}

describe("ChatView open chat tabs (full app)", () => {
  setupChatViewBrowserSuite();

  it("opens the chat on screen as a tab, and every chat it goes to as another", async () => {
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot: tabsSnapshot() });
    try {
      await vi.waitFor(() => expect(tabLabels()).toEqual([THREAD_TITLE]));
      expect(activeTabLabel()).toBe(THREAD_TITLE);

      await mounted.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: LOCAL_ENVIRONMENT_ID, threadId: SECOND_ID },
      });
      await vi.waitFor(() => expect(tabLabels()).toEqual([THREAD_TITLE, SECOND_TITLE]));
      await vi.waitFor(() => expect(activeTabLabel()).toBe(SECOND_TITLE));
      // The stored list holds references only, in tab order (a JSON string in UI storage).
      const stored = JSON.parse(localStorage.getItem(OPEN_CHAT_TABS_STORAGE_KEY)!) as string;
      expect(decodeOpenChatTabs(stored)).toEqual([refOf(THREAD_ID), refOf(SECOND_ID)]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens a tab's chat when the tab is clicked", async () => {
    const mounted = await mountWithTabs([THREAD_ID, SECOND_ID, THIRD_ID]);
    try {
      tabLabelButtons()[2]!.click();
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THIRD_ID),
        "Clicking a tab should open its chat.",
      );
      await vi.waitFor(() => expect(activeTabLabel()).toBe(THIRD_TITLE));
      expect(tabLabels()).toEqual([THREAD_TITLE, SECOND_TITLE, THIRD_TITLE]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes the active tab into its right neighbour, dropping it only once the route left", async () => {
    const mounted = await mountWithTabs([THREAD_ID, SECOND_ID, THIRD_ID]);
    try {
      document
        .querySelector<HTMLButtonElement>(`${STRIP} button[aria-label="Close ${THREAD_TITLE}"]`)!
        .click();
      // The close waits for the navigation: the chat still on screen keeps its tab.
      expect(storedThreadIds()).toContain(THREAD_ID);
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(SECOND_ID),
        "Closing the active tab should open its right neighbour.",
      );
      await vi.waitFor(() => expect(tabLabels()).toEqual([SECOND_TITLE, THIRD_TITLE]));
      expect(activeTabLabel()).toBe(SECOND_TITLE);
      expect(storedThreadIds()).toEqual([SECOND_ID, THIRD_ID]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes a background tab with a middle click and stays on the chat", async () => {
    const mounted = await mountWithTabs([THREAD_ID, SECOND_ID, THIRD_ID]);
    try {
      const chip = tabChip(THIRD_TITLE);
      chip.dispatchEvent(
        new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }),
      );
      chip.dispatchEvent(
        new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
      );
      await vi.waitFor(() => expect(tabLabels()).toEqual([THREAD_TITLE, SECOND_TITLE]));
      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
      expect(activeTabLabel()).toBe(THREAD_TITLE);
    } finally {
      await mounted.cleanup();
    }
  });

  it("reorders a tab by dragging it past the activation distance, and a short press does not", async () => {
    const mounted = await mountWithTabs([THREAD_ID, SECOND_ID, THIRD_ID]);
    try {
      // A press that travels less than 6 px stays a press.
      const still = tabLabelButtons()[2]!.getBoundingClientRect();
      const stillX = still.left + still.width / 2;
      const y = still.top + still.height / 2;
      tabLabelButtons()[2]!.dispatchEvent(mousePointerEvent("pointerdown", stillX, y));
      document.dispatchEvent(mousePointerEvent("pointermove", stillX - 4, y));
      await nextFrame();
      document.dispatchEvent(mousePointerEvent("pointerup", stillX - 4, y));
      await waitForLayout();
      expect(storedThreadIds()).toEqual([THREAD_ID, SECOND_ID, THIRD_ID]);

      const source = tabLabelButtons()[2]!.getBoundingClientRect();
      const x = source.left + source.width / 2;
      tabLabelButtons()[2]!.dispatchEvent(mousePointerEvent("pointerdown", x, y));
      document.dispatchEvent(mousePointerEvent("pointermove", x - 8, y));
      await waitForLayout();
      const target = tabLabelButtons()[0]!.getBoundingClientRect();
      const targetX = target.left + target.width / 2;
      document.dispatchEvent(mousePointerEvent("pointermove", targetX, y));
      await waitForLayout();
      document.dispatchEvent(mousePointerEvent("pointermove", targetX - 1, y));
      await nextFrame();
      document.dispatchEvent(mousePointerEvent("pointerup", targetX - 1, y));

      await vi.waitFor(() => expect(storedThreadIds()).toEqual([THIRD_ID, THREAD_ID, SECOND_ID]));
      await vi.waitFor(() =>
        expect(tabLabels()).toEqual([THIRD_TITLE, THREAD_TITLE, SECOND_TITLE]),
      );
      // Dragging is not a click: the chat on screen stays.
      expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
      expect(activeTabLabel()).toBe(THREAD_TITLE);
    } finally {
      await mounted.cleanup();
    }
  });

  it("steps through the tabs with the next and previous keys, wrapping at the ends", async () => {
    const mounted = await mountWithTabs([THREAD_ID, SECOND_ID, THIRD_ID]);
    try {
      pressTabKey("previous");
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THIRD_ID),
        "Previous from the first tab should wrap to the last one.",
      );
      await vi.waitFor(() => expect(activeTabLabel()).toBe(THIRD_TITLE));

      pressTabKey("next");
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THREAD_ID),
        "Next from the last tab should wrap to the first one.",
      );
      pressTabKey("next");
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(SECOND_ID),
        "Next should open the following tab.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes the other tabs from a tab's menu, opening the kept one", async () => {
    const mounted = await mountWithTabs([THREAD_ID, SECOND_ID, THIRD_ID]);
    try {
      const chip = tabChip(SECOND_TITLE);
      const rect = chip.getBoundingClientRect();
      chip.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 8,
          clientY: rect.top + 8,
        }),
      );
      // The browser's DOM context menu (the desktop app shows the native one).
      const menuButtons = () => [
        ...document.querySelectorAll<HTMLButtonElement>("body > div[data-level] > button"),
      ];
      await vi.waitFor(() =>
        expect(menuButtons().map((button) => button.textContent)).toEqual([
          "Close Tabs to the Left",
          "Close Tabs to the Right",
          "Close Other Tabs",
        ]),
      );
      menuButtons()
        .find((button) => button.textContent === "Close Other Tabs")!
        .click();

      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(SECOND_ID),
        "Closing the chat on screen with its neighbours should open the kept tab.",
      );
      await vi.waitFor(() => expect(tabLabels()).toEqual([SECOND_TITLE]));
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides and then forgets a chat that no longer exists once its machine has loaded", async () => {
    const gone = ThreadId.make("thread-tab-gone");
    useOpenChatTabsStore.setState({ refs: [refOf(THREAD_ID), refOf(gone), refOf(SECOND_ID)] });
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot: tabsSnapshot() });
    try {
      await vi.waitFor(() => expect(tabLabels()).toEqual([THREAD_TITLE, SECOND_TITLE]));
      await vi.waitFor(() => expect(storedThreadIds()).toEqual([THREAD_ID, SECOND_ID]));
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the plain title when the setting is off", async () => {
    localStorage.setItem(
      "ryco:client-settings:v1",
      JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, openChatTabs: false }),
    );
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot: tabsSnapshot() });
    try {
      await vi.waitFor(() =>
        expect(
          document.querySelector('header nav[aria-label="Breadcrumb"]')?.textContent,
        ).toContain(THREAD_TITLE),
      );
      await waitForLayout();
      expect(document.querySelector(STRIP)).toBeNull();
      expect(storedThreadIds()).toEqual([]);
    } finally {
      localStorage.removeItem("ryco:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("shows the tabs over the focused pane of a split, focusing a pane's chat from its tab", async () => {
    const mounted = await mountWithTabs([THREAD_ID, SECOND_ID, THIRD_ID], {
      viewport: WIDE_VIEWPORT,
    });
    try {
      useChatPanesStore.getState().open(refOf(SECOND_ID), "right", refOf(THREAD_ID));
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-pane-thread]:not([hidden])")).toHaveLength(2),
      );
      // One strip: the header of the pane you type into.
      await vi.waitFor(() => expect(document.querySelectorAll(STRIP)).toHaveLength(1));
      const focusedPane = () => document.querySelector<HTMLElement>('[data-pane-focused="true"]');
      expect(focusedPane()?.querySelector(STRIP)).not.toBeNull();

      tabLabelButtons()[1]!.click();
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(SECOND_ID),
        "A tab of a chat in the split should focus its pane.",
      );
      await vi.waitFor(() =>
        expect(focusedPane()?.dataset.paneThread).toBe(`${LOCAL_ENVIRONMENT_ID}:${SECOND_ID}`),
      );
      expect(document.querySelectorAll("[data-pane-thread]:not([hidden])")).toHaveLength(2);
      await vi.waitFor(() => expect(focusedPane()?.querySelector(STRIP)).not.toBeNull());

      // A chat outside the split opens on its own; the split stays saved.
      tabLabelButtons()[2]!.click();
      await waitForURL(
        mounted.router,
        (path) => path === serverThreadPath(THIRD_ID),
        "A tab of a chat outside the split should open it.",
      );
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-pane-thread]:not([hidden])")).toHaveLength(1),
      );
      expect(useChatPanesStore.getState().root?.kind).toBe("split");
    } finally {
      await mounted.cleanup();
    }
  });
});
