import { WS_METHODS, type MessageId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { formatShortcutLabel } from "../keybindings";
import {
  DEFAULT_VIEWPORT,
  createSnapshotForTargetUser,
  dispatchedCommandTypes,
  mountChatView,
  mountLifecycleThread,
  setupChatViewBrowserSuite,
  waitForElement,
  waitForServerConfigToApply,
  waitForURL,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/** Opens the command palette, once the last one has closed, with `query` typed. */
async function searchPalette(query: string) {
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="command-palette"]')).toBeNull(),
  );
  useCommandPaletteStore.getState().setOpen(true);
  await page.getByPlaceholder("Search commands, projects, and threads...").fill(query);
  return page.getByTestId("command-palette");
}

describe("ChatView command palette lifecycle actions (full app)", () => {
  setupChatViewBrowserSuite();

  it("settles the open thread from the palette, showing its shortcut", async () => {
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      const palette = await searchPalette("settle");
      const settle = palette.getByText("Settle current thread", { exact: true });
      await expect.element(settle).toBeInTheDocument();
      const shortcut = formatShortcutLabel({
        key: "d",
        modKey: true,
        altKey: true,
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
      });
      await expect.element(palette.getByText(shortcut, { exact: true })).toBeInTheDocument();

      await settle.click();
      await vi.waitFor(() => expect(dispatchedCommandTypes()).toContain("thread.settle"));
      expect(useCommandPaletteStore.getState().open).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("says why a running thread's actions cannot run and sends nothing", async () => {
    const mounted = await mountLifecycleThread({ running: true });

    try {
      await waitForServerConfigToApply();
      const palette = await searchPalette("current thread");
      await expect
        .element(palette.getByText("Nothing to mark unread yet.", { exact: true }))
        .toBeInTheDocument();
      // Settle, snooze and archive all wait for the turn.
      expect(
        palette.getByText("Wait for the running work to finish.", { exact: true }).all(),
      ).toHaveLength(3);

      await palette.getByText("Settle current thread", { exact: true }).click();
      expect(useCommandPaletteStore.getState().open).toBe(true);
      expect(dispatchedCommandTypes()).not.toContain("thread.settle");
    } finally {
      useCommandPaletteStore.getState().setOpen(false);
      await mounted.cleanup();
    }
  });

  it("snoozes the open thread until a time picked from its submenu", async () => {
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      const palette = await searchPalette("snooze");
      await palette.getByText("Snooze current thread…", { exact: true }).click();
      await expect.element(palette.getByText("Snooze until", { exact: true })).toBeInTheDocument();
      await palette.getByText("Next week", { exact: true }).click();
      await vi.waitFor(() => expect(dispatchedCommandTypes()).toContain("thread.snooze"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks the open thread unread and archives it from the palette", async () => {
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      await (
        await searchPalette("unread")
      )
        .getByText("Mark current thread unread", { exact: true })
        .click();
      await expect
        .element(page.getByText("Thread marked unread", { exact: true }))
        .toBeInTheDocument();

      await (
        await searchPalette("archive")
      )
        .getByText("Archive current thread", { exact: true })
        .click();
      await vi.waitFor(() => expect(dispatchedCommandTypes()).toContain("thread.archive"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the Tasks page when the sidebar offers it", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-tasks" as MessageId,
        targetText: "command palette tasks",
      }),
      configureFixture: (nextFixture) => {
        const environment = {
          ...nextFixture.serverConfig.environment,
          capabilities: { ...nextFixture.serverConfig.environment.capabilities, localTasks: true },
        };
        nextFixture.serverConfig = { ...nextFixture.serverConfig, environment };
        nextFixture.welcome = { ...nextFixture.welcome, environment };
      },
      resolveRpc: (body) =>
        body._tag === WS_METHODS.serverListLocalTasks ? { tasks: [], nextCursor: null } : undefined,
    });

    try {
      await waitForServerConfigToApply();
      await waitForElement(
        () => document.querySelector('[data-testid="sidebar-tasks-link"]'),
        "The sidebar should offer the Tasks page.",
      );
      await (await searchPalette("tasks")).getByText("Open tasks", { exact: true }).click();
      await waitForURL(mounted.router, (path) => path === "/tasks", "Tasks should open.");
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers no Tasks page on a node without tasks", async () => {
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      const palette = await searchPalette("tasks");
      await expect
        .element(palette.getByText("Show Inbox sidebar", { exact: true }))
        .toBeInTheDocument();
      expect(palette.element().textContent).not.toContain("Open tasks");
    } finally {
      useCommandPaletteStore.getState().setOpen(false);
      await mounted.cleanup();
    }
  });
});
