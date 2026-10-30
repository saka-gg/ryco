import "../../index.css";

import { StrictMode, useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { AlertDialog, AlertDialogClose, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
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

interface GhostTravel {
  readonly from: { readonly left: number; readonly top: number };
  readonly to: { readonly left: number; readonly top: number };
}

/**
 * Records every ghost travel as it starts: where the ghost sets out and where it lands. A
 * ghost lives only for its travel, so a test that reads its rect after a fixed sleep or a
 * frame races the animation; the travel's own keyframes say the same thing at any time.
 */
function recordGhostTravels() {
  const travels: GhostTravel[] = [];
  const animate = Element.prototype.animate;
  const spy = vi.spyOn(Element.prototype, "animate").mockImplementation(function (
    this: Element,
    keyframes,
    options,
  ) {
    const frames = Array.isArray(keyframes) ? keyframes : [];
    const first = frames[0];
    const last = frames.at(-1);
    if (
      this instanceof HTMLElement &&
      this.dataset.slot === "morph-ghost" &&
      frames.length === 2 &&
      typeof first?.left === "string" &&
      typeof last?.left === "string"
    ) {
      const point = (frame: Keyframe) => ({
        left: Number.parseFloat(String(frame.left)),
        top: Number.parseFloat(String(frame.top)),
      });
      travels.push({ from: point(first), to: point(last) });
    }
    return animate.call(this, keyframes, options);
  });
  return { travels, restore: () => spy.mockRestore() };
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

function MenuDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div className="p-10">
      <Menu>
        <MenuTrigger render={<button type="button" />}>Project actions</MenuTrigger>
        <MenuPopup>
          <MenuItem onClick={() => setOpen(true)}>Rename project</MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogTitle>Rename project</DialogTitle>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

let openFromContextMenu: (() => void) | null = null;

function ContextMenuHarness() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openFromContextMenu = () => setOpen(true);
    return () => {
      openFromContextMenu = null;
    };
  }, []);
  return (
    <div className="p-10">
      <button type="button" onContextMenu={(event) => event.preventDefault()}>
        Project row
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogTitle>Project settings</DialogTitle>
        </DialogPopup>
      </Dialog>
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
    // The control that opened the dialog stays put (a sidebar row keeps its label).
    expect(opacityOf(button)).toBe(1);

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

  it("folds a dialog opened from a menu item back into the menu's trigger", async () => {
    mounted = await render(
      <StrictMode>
        <MenuDialogHarness />
      </StrictMode>,
    );
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    await page.getByRole("button", { name: "Project actions" }).click();
    await page.getByRole("menuitem", { name: "Rename project" }).click();

    // Dialogs default to `"auto"`: it grows out of the menu item.
    expect(ghosts()).toHaveLength(1);
    await vi.waitFor(() => expect(ghosts()).toHaveLength(0), { timeout: 2_000 });

    const folds = recordGhostTravels();
    try {
      await userEvent.keyboard("{Escape}");
      // The item went away with its menu, so the fold lands on the trigger. The fold is over
      // 430 ms after the key, possibly before the keyboard command has even returned here.
      const triggerRect = trigger.getBoundingClientRect();
      await vi.waitFor(() => expect(folds.travels.length).toBeGreaterThan(0), { timeout: 2_000 });
      const landing = folds.travels.at(-1)!.to;
      expect(Math.abs(landing.left - triggerRect.left)).toBeLessThan(24);
      expect(Math.abs(landing.top - triggerRect.top)).toBeLessThan(24);
    } finally {
      folds.restore();
    }
  });

  it("grows a dialog picked from a context menu out of the right-clicked row", async () => {
    mounted = await render(
      <StrictMode>
        <ContextMenuHarness />
      </StrictMode>,
    );
    const row = document.querySelector<HTMLButtonElement>("button")!;
    await userEvent.click(row, { button: "right" });
    // A native menu fires no DOM event when an item is picked; the dialog
    // opens whenever the person gets to it — here, after the click window.
    await sleep(1_400);
    const grows = recordGhostTravels();
    try {
      openFromContextMenu?.();
      // The dialog mounts when React gets to it, and its ghost lives only for the grow.
      // (StrictMode attaches twice, so the live grow is the last one.)
      await vi.waitFor(() => expect(grows.travels.length).toBeGreaterThan(0), { timeout: 2_000 });
      // One ghost grows the dialog (it may already be gone): never one per attach.
      expect(ghosts().length).toBeLessThanOrEqual(1);
      const start = grows.travels.at(-1)!.from;
      const rowRect = row.getBoundingClientRect();
      expect(Math.abs(start.left - rowRect.left)).toBeLessThan(40);
      expect(Math.abs(start.top - rowRect.top)).toBeLessThan(40);
    } finally {
      grows.restore();
    }
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
