import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { hasOpenDialogShortcutTarget } from "../keybindings";
import { isMacPlatform } from "../lib/utils";
import { useUiStateStore } from "../uiStateStore";
import {
  dispatchedCommandTypes,
  mountLifecycleThread,
  pressComposerKey,
  pressComposerUndo,
  pressLifecycleChord,
  setupChatViewBrowserSuite,
  waitForComposerEditor,
  waitForComposerText,
  waitForElement,
  waitForLayout,
  waitForServerConfigToApply,
} from "./ChatView.browser.helpers";

vi.mock("../lib/gitStatusState", () => import("../../test/gitStatusStateMock"));

/** ⌘Z (Ctrl+Z off macOS), pressed in `target`. */
function pressUndoKey(target: Element): KeyboardEvent {
  const useMetaForMod = isMacPlatform(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key: "z",
    code: "KeyZ",
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/** Settles the open thread from its shortcut and waits for the Undo notice. */
async function settleOpenThread(): Promise<void> {
  pressLifecycleChord("D");
  await expect.element(page.getByText("Thread settled", { exact: true })).toBeInTheDocument();
}

describe("ChatView thread Undo shortcut (full app)", () => {
  setupChatViewBrowserSuite();

  it("undoes a settle from the composer before anything is typed there", async () => {
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      await page.getByTestId("composer-editor").fill("keep this draft");
      await waitForComposerText("keep this draft");
      await settleOpenThread();

      expect(pressUndoKey(await waitForComposerEditor()).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(dispatchedCommandTypes()).toContain("thread.sidebar.undo"));
      await waitForLayout();
      await waitForComposerText("keep this draft");
    } finally {
      await mounted.cleanup();
    }
  });

  it("hands the key back to the composer's own undo once you type there", async () => {
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      (await waitForComposerEditor()).focus();
      await settleOpenThread();

      await pressComposerKey("x");
      await waitForComposerText("x");
      await pressComposerUndo();
      await waitForComposerText("");
      expect(dispatchedCommandTypes()).not.toContain("thread.sidebar.undo");
      await expect.element(page.getByText("Thread settled", { exact: true })).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves other text fields and dialogs their own undo, and undoes from anywhere else", async () => {
    useUiStateStore.setState({ sidebarMode: "inbox" });
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      await settleOpenThread();

      const field = page.getByRole("combobox", { name: "Filter inbox" });
      await field.click();
      expect(pressUndoKey(field.element()).defaultPrevented).toBe(false);

      useCommandPaletteStore.getState().setOpen(true);
      await waitForElement(
        () => document.querySelector('[data-testid="command-palette"]'),
        "The command palette should open.",
      );
      expect(pressUndoKey(document.body).defaultPrevented).toBe(false);
      useCommandPaletteStore.getState().setOpen(false);
      await vi.waitFor(() => expect(hasOpenDialogShortcutTarget()).toBe(false));
      expect(dispatchedCommandTypes()).not.toContain("thread.sidebar.undo");

      expect(pressUndoKey(document.body).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(dispatchedCommandTypes()).toContain("thread.sidebar.undo"));
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the key alone without an Undo notice", async () => {
    const mounted = await mountLifecycleThread();

    try {
      await waitForServerConfigToApply();
      expect(pressUndoKey(document.body).defaultPrevented).toBe(false);
      expect(dispatchedCommandTypes()).not.toContain("thread.sidebar.undo");
    } finally {
      await mounted.cleanup();
    }
  });
});
