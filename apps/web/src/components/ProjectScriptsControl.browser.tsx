import "../index.css";

import type { ProjectScript, ResolvedKeybindingsConfig } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { StrictMode } from "react";
import { render } from "vitest-browser-react";

import { syncDocumentPresentationTier } from "../lib/presentationTier";
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";

const BUILD_SCRIPT: ProjectScript = {
  id: "build",
  name: "Build",
  command: "bun run build",
  icon: "build",
  runOnWorktreeCreate: false,
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** The alpha of an element's background colour (`rgba()` or `color()` syntax). */
function scrimAlpha(element: HTMLElement): number {
  const color = getComputedStyle(element).backgroundColor;
  const alpha =
    /\/\s*([\d.]+)\)$/.exec(color)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)?.[1];
  if (alpha !== undefined) return Number(alpha);
  return color === "transparent" ? 0 : 1;
}

function ghosts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="morph-ghost"]'));
}

describe("ProjectScriptsControl action dialog", () => {
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
    stopTierSync?.();
    stopTierSync = null;
    document.body.innerHTML = "";
  });

  function renderControl(
    scripts: ProjectScript[],
    onAddScript: (input: NewProjectScriptInput) => Promise<void> | void = vi.fn(),
  ) {
    // StrictMode like the dev app: it attaches the morph twice per open.
    return render(
      <StrictMode>
        <div className="@container/header-actions flex items-center gap-2 p-4">
          <ProjectScriptsControl
            scripts={scripts}
            keybindings={{} as ResolvedKeybindingsConfig}
            preferredScriptId={null}
            onRunScript={vi.fn()}
            onAddScript={onAddScript}
            onUpdateScript={vi.fn()}
            onDeleteScript={vi.fn()}
          />
        </div>
      </StrictMode>,
    );
  }

  it("grows out of the Add action button and folds back into it when dismissed", async () => {
    mounted = await renderControl([]);
    const addButton = document.querySelector<HTMLButtonElement>('button[title="Add action"]')!;

    await page.getByRole("button", { name: "Add action" }).click();

    // Mid-grow: a ghost of the dialog surface travels from the button, inside
    // the dialog viewport (above the scrim, beneath the popup).
    expect(ghosts()).toHaveLength(1);
    const growGhost = ghosts()[0]!;
    expect(growGhost.parentElement?.dataset.slot).toBe("dialog-viewport");
    const popup = growGhost.nextElementSibling as HTMLElement;
    expect(popup.dataset.slot).toBe("dialog-popup");
    // While the ghost carries the surface the popup paints only content, so
    // translucent plates never stack (and then snap clear at the hand-off).
    expect(popup.hasAttribute("data-surface-morphing")).toBe(true);
    expect(scrimAlpha(popup)).toBe(0);

    await vi.waitFor(() => expect(ghosts()).toHaveLength(0), { timeout: 2_000 });
    expect(popup.hasAttribute("data-surface-morphing")).toBe(false);
    expect(scrimAlpha(popup)).toBeGreaterThan(0.5);
    expect(Number(getComputedStyle(addButton).opacity)).toBe(0);
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    // The fold keeps the popup mounted until the ghost has landed, but the
    // scrim follows the close itself: the page is already clear mid-fold.
    await sleep(150);
    expect(document.querySelector('[data-slot="dialog-popup"]')).not.toBeNull();
    expect(ghosts()).toHaveLength(1);
    const viewport = document.querySelector<HTMLElement>('[data-slot="dialog-viewport"]')!;
    expect(scrimAlpha(viewport)).toBeLessThan(0.08);

    await vi.waitFor(
      () => {
        expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull();
        expect(ghosts()).toHaveLength(0);
        expect(Number(getComputedStyle(addButton).opacity)).toBe(1);
      },
      { timeout: 2_000 },
    );
  });

  it("picks the icon inline and saves it with the action", async () => {
    const onAddScript = vi.fn();
    mounted = await renderControl([BUILD_SCRIPT], onAddScript);

    await page.getByRole("button", { name: "Script actions" }).click();
    await page.getByRole("menuitem", { name: "Add action" }).click();

    const tile = page.getByRole("button", { name: "Choose icon" });
    await expect.element(tile).toHaveAttribute("aria-expanded", "false");
    await tile.click();
    await expect.element(tile).toHaveAttribute("aria-expanded", "true");

    await page.getByRole("radio", { name: "Lint" }).click();
    await expect
      .element(page.getByRole("radio", { name: "Lint" }))
      .toHaveAttribute("aria-checked", "true");
    // The row folds away once the pick has settled.
    await expect.element(tile).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("textbox", { name: "Name" }).fill("Lint");
    await page.getByRole("textbox", { name: "Command" }).fill("bun lint");
    await page.getByRole("button", { name: "Save action" }).click();

    await vi.waitFor(() => expect(onAddScript).toHaveBeenCalledTimes(1));
    expect(onAddScript.mock.calls[0]?.[0]).toMatchObject({
      name: "Lint",
      command: "bun lint",
      icon: "lint",
    });
    await vi.waitFor(
      () => expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull(),
      {
        timeout: 2_000,
      },
    );
  });

  it("shows the dialog without a morph under reduced motion", async () => {
    document.documentElement.style.setProperty("--app-motion-duration-pop", "0ms");
    const matchMedia = window.matchMedia.bind(window);
    const stub = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      const list = matchMedia(query);
      if (query.includes("prefers-reduced-motion")) {
        Object.defineProperty(list, "matches", { value: true });
      }
      return list;
    });
    try {
      mounted = await renderControl([]);
      await page.getByRole("button", { name: "Add action" }).click();
      expect(ghosts()).toHaveLength(0);
      await expect.element(page.getByRole("textbox", { name: "Name" })).toBeVisible();
    } finally {
      stub.mockRestore();
      document.documentElement.style.removeProperty("--app-motion-duration-pop");
    }
  });
});
