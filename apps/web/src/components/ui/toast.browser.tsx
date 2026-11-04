import "../../index.css";

import { useEffect, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { ToastProvider, toastManager } from "./toast";

vi.mock("@tanstack/react-router", () => ({
  // Imported through the hosted node routes; never called by these tests.
  createBrowserHistory: vi.fn(),
  useParams: (options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = {};
    return options?.select ? options.select(params) : params;
  },
}));

describe("semantic toast surfaces", () => {
  const toastIds: Array<ReturnType<typeof toastManager.add>> = [];
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    for (const toastId of toastIds.splice(0)) {
      toastManager.close(toastId);
    }
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted);
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("tints semantic glass surfaces while keeping loading neutral", async () => {
    mounted = await render(
      <ToastProvider>
        <span>Toast host</span>
      </ToastProvider>,
    );

    for (const type of ["success", "error", "warning", "info", "loading"] as const) {
      toastIds.push(
        toastManager.add({
          type,
          title: `${type} notification`,
          timeout: 0,
        }),
      );
    }

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-slot="toast-root"]')).toHaveLength(5);
    });

    const roots = new Map(
      [...document.querySelectorAll<HTMLElement>('[data-slot="toast-root"]')].map((root) => [
        root.dataset.type,
        root,
      ]),
    );
    const semanticTypes = ["success", "error", "warning", "info"] as const;
    const semanticBackgrounds = semanticTypes.map((type) => {
      const root = roots.get(type);
      expect(root).toBeDefined();
      const style = getComputedStyle(root!);
      expect(style.getPropertyValue("--app-toast-tone").trim()).not.toBe("");
      expect(style.getPropertyValue("--app-toast-tone-strength").trim()).toBe("8%");
      expect(style.getPropertyValue("--app-toast-tone-border-strength").trim()).toBe("32%");
      expect(root!.querySelectorAll(":scope > .liquid-glass-ring")).toHaveLength(0);
      const close = root!.querySelector<HTMLElement>('[data-slot="toast-close"]');
      expect(close).toBeDefined();
      expect(getComputedStyle(close!).getPropertyValue("--app-toast-tone").trim()).toBe(
        style.getPropertyValue("--app-toast-tone").trim(),
      );
      expect(close!.querySelectorAll(":scope > .liquid-glass-ring")).toHaveLength(0);
      return style.backgroundColor;
    });

    expect(new Set(semanticBackgrounds).size).toBe(semanticTypes.length);

    const loading = roots.get("loading");
    expect(loading).toBeDefined();
    const loadingStyle = getComputedStyle(loading!);
    expect(loadingStyle.getPropertyValue("--app-toast-tone").trim()).toBe("");
    expect(loadingStyle.getPropertyValue("--app-toast-tone-strength").trim()).toBe("");
    expect(loading!.querySelectorAll(":scope > .liquid-glass-ring")).toHaveLength(0);
    expect(semanticBackgrounds).not.toContain(loadingStyle.backgroundColor);
  });

  it("holds a deferrable notice while a dialog or picker is open, not an urgent one", async () => {
    let setDialogOpen: (open: boolean) => void = () => undefined;
    function Host() {
      const [dialogOpen, setOpen] = useState(false);
      useEffect(() => {
        setDialogOpen = setOpen;
      }, []);
      return (
        <ToastProvider>
          <Dialog open={dialogOpen} onOpenChange={setOpen}>
            <DialogPopup>
              <DialogTitle>Copy ryco to another node</DialogTitle>
            </DialogPopup>
          </Dialog>
          {/* Below the toasts, which would take its clicks. */}
          <div className="mt-80">
            <Popover>
              <PopoverTrigger>Pick a project</PopoverTrigger>
              <PopoverPopup>Projects</PopoverPopup>
            </Popover>
          </div>
        </ToastProvider>
      );
    }
    mounted = await render(<Host />);
    const titles = () =>
      [...document.querySelectorAll('[data-slot="toast-root"]')].map(
        (root) => root.querySelector('[data-slot="toast-title"]')?.textContent ?? "",
      );

    setDialogOpen(true);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    toastIds.push(
      toastManager.add({
        type: "warning",
        title: "Updates Available: 2 providers",
        timeout: 0,
        data: { deferWhileOverlayOpen: true },
      }),
      toastManager.add({ type: "error", title: "The copy failed", timeout: 0 }),
    );
    // The urgent toast shows over the dialog; the update notice waits.
    await vi.waitFor(() => expect(titles()).toEqual(["The copy failed"]));

    // Once the dialog has closed, the notice shows.
    setDialogOpen(false);
    await vi.waitFor(() =>
      expect(titles()).toEqual(["The copy failed", "Updates Available: 2 providers"]),
    );

    // A picker popup holds it too, until it closes.
    await page.getByRole("button", { name: "Pick a project" }).click();
    await expect.element(page.getByText("Projects")).toBeVisible();
    await vi.waitFor(() => expect(titles()).toEqual(["The copy failed"]));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(titles()).toEqual(["The copy failed", "Updates Available: 2 providers"]),
    );
  });
});
