import "../../index.css";

import { StrictMode, useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { SURFACE_HANDOFF_ATTRIBUTE } from "./surfaceMorph";

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function ghosts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="morph-ghost"]'));
}

function opacityOf(element: Element): number {
  return Number(getComputedStyle(element).opacity);
}

function PickerHarness() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="p-10">
      <Popover>
        <PopoverTrigger ref={triggerRef} render={<button type="button" />}>
          Model
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          morph={{ origin: () => triggerRef.current }}
          className="border-0 bg-transparent p-0 shadow-none before:hidden"
        >
          <div data-morph-surface="" className="selection-glass-surface w-64 rounded-lg border">
            <div className="p-3">Models</div>
            <div className="border-t p-3">Tuning</div>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

let openConfirm: (() => void) | null = null;

function ConfirmHarness() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openConfirm = () => setOpen(true);
    return () => {
      openConfirm = null;
    };
  }, []);
  return (
    <div className="p-10">
      <button type="button" onClick={() => setOpen(true)}>
        Delete item
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogTitle>Delete this item?</AlertDialogTitle>
          <AlertDialogClose render={<button type="button" />}>Cancel</AlertDialogClose>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

describe("surface morph", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;
  let stopTierSync: (() => void) | null = null;

  beforeEach(async () => {
    await page.viewport(1_280, 800);
    stopTierSync = syncDocumentPresentationTier();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    openConfirm = null;
    stopTierSync?.();
    stopTierSync = null;
    document.body.innerHTML = "";
  });

  it("grows a popover's marked surface out of its trigger, beside the positioner", async () => {
    mounted = await render(
      <StrictMode>
        <PickerHarness />
      </StrictMode>,
    );
    const trigger = document.querySelector<HTMLButtonElement>("button")!;

    await page.getByRole("button", { name: "Model" }).click();
    await nextFrame();
    await nextFrame();

    // The grow starts a frame after mount, once the positioner is placed. The
    // ghost lives beside the (possibly transformed) positioner, at its z-index
    // and before it in DOM order, so the popup paints over it.
    expect(ghosts()).toHaveLength(1);
    const ghost = ghosts()[0]!;
    const positioner = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]')!;
    expect(ghost.nextElementSibling).toBe(positioner);
    expect(ghost.style.zIndex).toBe(getComputedStyle(positioner).zIndex);
    const surface = document.querySelector<HTMLElement>("[data-morph-surface]")!;
    expect(surface.hasAttribute(SURFACE_HANDOFF_ATTRIBUTE)).toBe(true);
    // A popover's trigger labels what it changes: it stays visible.
    expect(opacityOf(trigger)).toBe(1);

    await vi.waitFor(() => expect(ghosts()).toHaveLength(0), { timeout: 2_000 });
    expect(surface.hasAttribute(SURFACE_HANDOFF_ATTRIBUTE)).toBe(false);

    await userEvent.keyboard("{Escape}");
    await sleep(60);
    // The fold keeps the popup mounted until the ghost lands in the trigger.
    expect(document.querySelector('[data-slot="popover-popup"]')).not.toBeNull();
    expect(ghosts()).toHaveLength(1);
    await vi.waitFor(
      () => {
        expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
        expect(ghosts()).toHaveLength(0);
      },
      { timeout: 2_000 },
    );
  });

  it("grows a confirmation out of the button that asked for it", async () => {
    mounted = await render(
      <StrictMode>
        <ConfirmHarness />
      </StrictMode>,
    );
    const button = document.querySelector<HTMLButtonElement>("button")!;

    await page.getByRole("button", { name: "Delete item" }).click();

    expect(ghosts()).toHaveLength(1);
    expect(ghosts()[0]!.parentElement?.dataset.slot).toBe("alert-dialog-viewport");
    await vi.waitFor(() => expect(ghosts()).toHaveLength(0), { timeout: 2_000 });
    // A dialog's origin became the dialog: hidden while it is open.
    expect(opacityOf(button)).toBe(0);

    await userEvent.keyboard("{Escape}");
    await sleep(150);
    expect(ghosts()).toHaveLength(1);
    await vi.waitFor(
      () => {
        expect(document.querySelector('[data-slot="alert-dialog-popup"]')).toBeNull();
        expect(opacityOf(button)).toBe(1);
      },
      { timeout: 2_000 },
    );
  });

  it("falls back to a plain fade when nothing was just activated", async () => {
    mounted = await render(
      <StrictMode>
        <ConfirmHarness />
      </StrictMode>,
    );
    // Opened by code (a shortcut, a server event) well after any click.
    await sleep(1_300);
    openConfirm?.();
    await expect.element(page.getByRole("heading", { name: "Delete this item?" })).toBeVisible();
    expect(ghosts()).toHaveLength(0);
    expect(opacityOf(document.querySelector("button")!)).toBe(1);
  });
});
