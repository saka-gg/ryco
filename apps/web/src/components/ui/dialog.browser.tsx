import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { useEffect, useState } from "react";

import {
  hasOpenDialogShortcutTarget,
  isDifferentDialogShortcutTarget,
  matchesExactModShortcut,
  shouldIgnoreGlobalNavigationShortcut,
} from "../../keybindings";
import { installVisualViewportStub } from "../../../test/browserVisualViewport";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { syncDocumentVisualViewportInsets } from "../../lib/visualViewportInsets";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./dialog";

function DialogHarness() {
  const [open, setOpen] = useState(true);
  const [globalNavigationCount, setGlobalNavigationCount] = useState(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalNavigationShortcut(event)) return;
      if (!matchesExactModShortcut(event, "1", { platform: "MacIntel" })) return;
      setGlobalNavigationCount((count) => count + 1);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <div data-testid="dialog-state">{open ? "open" : "closed"}</div>
      <div data-testid="global-navigation-count">{globalNavigationCount}</div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Issue details</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <textarea aria-label="Comment body" className="min-h-24 w-full" />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function NestedDialogShortcutHarness() {
  const [parentShortcutCount, setParentShortcutCount] = useState(0);

  return (
    <>
      <div data-testid="parent-shortcut-count">{parentShortcutCount}</div>
      <Dialog open onOpenChange={() => undefined}>
        <DialogPopup
          onKeyDown={(event) => {
            if (
              isDifferentDialogShortcutTarget({
                currentTarget: event.currentTarget,
                target: event.target,
              })
            ) {
              return;
            }
            if (!matchesExactModShortcut(event, "1", { platform: "MacIntel" })) return;
            setParentShortcutCount((count) => count + 1);
          }}
        >
          <DialogHeader>
            <DialogTitle>Parent dialog</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <textarea aria-label="Parent body" className="min-h-24 w-full" />
            <Dialog open onOpenChange={() => undefined}>
              <DialogPopup>
                <DialogHeader>
                  <DialogTitle>Nested dialog</DialogTitle>
                </DialogHeader>
                <DialogPanel>
                  <textarea aria-label="Nested body" className="min-h-24 w-full" />
                </DialogPanel>
              </DialogPopup>
            </Dialog>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function BottomStickDialogHarness() {
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Confirm change</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <textarea aria-label="Reason" className="min-h-24 w-full" />
        </DialogPanel>
        <DialogFooter>
          <button type="button">Confirm</button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

describe("Dialog", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("keeps the top-right close button clickable and keyboard activatable", async () => {
    mounted = await render(<DialogHarness />);

    const closeButton = page.getByRole("button", { name: "Close" });
    await expect.element(closeButton).toBeInTheDocument();

    const closeRect = closeButton.element().getBoundingClientRect();
    const closeHitTarget = document.elementFromPoint(
      closeRect.left + closeRect.width / 2,
      closeRect.top + closeRect.height / 2,
    );
    expect(closeHitTarget?.closest("button")).toBe(closeButton.element());

    await userEvent.type(closeButton, "{Enter}");
    await expect.element(page.getByTestId("dialog-state")).toMatchTextContent("closed");

    await page.getByRole("button", { name: "Reopen" }).click();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId("dialog-state")).toMatchTextContent("closed");

    await page.getByRole("button", { name: "Reopen" }).click();
    await page.getByRole("button", { name: "Close" }).click();
    await expect.element(page.getByTestId("dialog-state")).toMatchTextContent("closed");
  });

  it("keeps outside app controls behind the modal hit target", async () => {
    mounted = await render(<DialogHarness />);

    const outsideButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Reopen",
    );
    if (!(outsideButton instanceof HTMLButtonElement)) {
      throw new Error("Expected outside Reopen button to be rendered.");
    }
    const outsideRect = outsideButton.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(
      outsideRect.left + outsideRect.width / 2,
      outsideRect.top + outsideRect.height / 2,
    );

    expect(hitTarget).not.toBe(outsideButton);
    expect(
      hitTarget?.closest(
        "[data-slot=dialog-popup],[data-slot=dialog-viewport],[data-slot=dialog-backdrop]",
      ),
    ).not.toBeNull();
  });

  it("does not let dialog keyboard events reach global navigation handlers", async () => {
    mounted = await render(<DialogHarness />);

    const textarea = page.getByLabelText("Comment body");
    await userEvent.click(textarea);

    textarea.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Meta",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Alt",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    textarea.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "1",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect.element(page.getByTestId("dialog-state")).toMatchTextContent("open");
    await expect.element(page.getByTestId("global-navigation-count")).toMatchTextContent("0");
  });

  it("treats editable targets as global navigation shortcut boundaries", () => {
    const input = document.createElement("input");
    document.body.append(input);

    expect(
      shouldIgnoreGlobalNavigationShortcut({
        type: "keydown",
        key: "1",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: input,
      }),
    ).toBe(true);
  });

  it("ignores hidden dialog nodes when checking global shortcut boundaries", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Hidden dialog focus";
    dialog.append(button);
    document.body.append(dialog);

    button.focus();
    expect(hasOpenDialogShortcutTarget()).toBe(true);

    dialog.hidden = true;
    expect(hasOpenDialogShortcutTarget()).toBe(false);
  });

  it("does not treat a visible toast as an open dialog unless it holds focus", () => {
    const toast = document.createElement("div");
    toast.setAttribute("role", "dialog");
    toast.dataset.slot = "toast-root";
    const action = document.createElement("button");
    action.textContent = "Update";
    toast.append(action);
    document.body.append(toast);
    try {
      expect(hasOpenDialogShortcutTarget()).toBe(false);
      action.focus();
      expect(hasOpenDialogShortcutTarget()).toBe(true);
    } finally {
      toast.remove();
    }
  });

  it("does not let nested dialog keyboard events trigger parent dialog shortcuts", async () => {
    mounted = await render(<NestedDialogShortcutHarness />);

    const nestedTextarea = page.getByLabelText("Nested body");
    await userEvent.click(nestedTextarea);

    nestedTextarea.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "1",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect.element(page.getByTestId("parent-shortcut-count")).toMatchTextContent("0");
  });

  it("keeps the bottom-stuck mobile dialog footer above a stubbed software keyboard", async () => {
    const initialWidth = window.innerWidth;
    const initialHeight = window.innerHeight;
    const viewportStub = installVisualViewportStub();
    const stopAdapter = syncDocumentVisualViewportInsets();
    // Bottom-stick is a phone-tier behavior, keyed off the data-tier root
    // attribute stamped by the presentation-tier sync (in the app: main.tsx).
    syncDocumentPresentationTier();
    try {
      await page.viewport(390, 844);
      await vi.waitFor(() => {
        expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
      });
      mounted = await render(<BottomStickDialogHarness />);

      const confirmButton = page.getByRole("button", { name: "Confirm" });
      await expect.element(confirmButton).toBeInTheDocument();
      const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
      expect(popup).not.toBeNull();

      // Keyboard-closed baseline: the popup sticks to the viewport bottom.
      await vi.waitFor(() => {
        expect(popup!.getBoundingClientRect().bottom).toBeGreaterThan(843);
      });

      viewportStub.setKeyboardInset(300);
      await vi.waitFor(() => {
        const popupRect = popup!.getBoundingClientRect();
        const buttonRect = confirmButton.element().getBoundingClientRect();
        expect(popupRect.bottom).toBeLessThanOrEqual(544.5);
        expect(buttonRect.height).toBeGreaterThan(0);
        expect(buttonRect.bottom).toBeLessThanOrEqual(544.5);
      });

      // Hiding the keyboard restores the bottom-stuck geometry.
      viewportStub.setKeyboardInset(0);
      await vi.waitFor(() => {
        expect(popup!.getBoundingClientRect().bottom).toBeGreaterThan(843);
      });
    } finally {
      stopAdapter();
      viewportStub.restore();
      await page.viewport(initialWidth, initialHeight);
    }
  });
});
