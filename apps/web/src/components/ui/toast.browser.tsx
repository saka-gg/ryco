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

  it("keeps one neutral plate and carries the tone in the icon", async () => {
    mounted = await render(
      <ToastProvider limit={5}>
        <span>Toast host</span>
      </ToastProvider>,
    );

    for (const type of ["success", "error", "warning", "info", "loading"] as const) {
      toastIds.push(toastManager.add({ type, title: `${type} notification`, timeout: 0 }));
    }

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-slot="toast-root"]')).toHaveLength(5);
    });

    const roots = [...document.querySelectorAll<HTMLElement>('[data-slot="toast-root"]')];
    const plates = new Set(roots.map((root) => getComputedStyle(root).backgroundColor));
    const iconTones = new Set(
      roots.map((root) => getComputedStyle(root.querySelector('[data-slot="toast-icon"]')!).color),
    );
    // One opaque plate for every type; five distinct icon tones.
    expect(plates.size).toBe(1);
    expect([...plates][0]).not.toMatch(/\/ 0?\.\d+\)$|rgba\(/);
    expect(iconTones.size).toBe(5);
  });

  it("shows the title and main action at rest and opens the details on demand", async () => {
    mounted = await render(
      <ToastProvider>
        <span>Toast host</span>
      </ToastProvider>,
    );
    const onRetry = vi.fn();
    toastIds.push(
      toastManager.add({
        type: "error",
        title: "Push failed",
        description: "The branch is protected.",
        timeout: 0,
        actionProps: { children: "Retry", onClick: onRetry },
        data: { secondaryActionProps: { children: "Details" } },
      }),
    );

    // At rest: the main action is one click away, the details inert.
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
    const detail = () => document.querySelector<HTMLElement>('[data-slot="toast-detail"]')!;
    expect(detail().inert).toBe(true);
    expect(detail().getBoundingClientRect().height).toBe(0);
    // An error waits to be dismissed: no countdown ring.
    expect(document.querySelector('[data-slot="toast-countdown"]')).toBeNull();

    await userEvent.click(page.getByText("Push failed"));
    await vi.waitFor(() => {
      expect(detail().inert).toBe(false);
      expect(detail().getBoundingClientRect().height).toBeGreaterThan(20);
    });
    await expect.element(page.getByText("The branch is protected.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Details" })).toBeVisible();
    // The main action never moves: it is still the one in the row.
    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("counts the toasts folded under the front one and draws a countdown for timed ones", async () => {
    mounted = await render(
      <ToastProvider>
        <span>Toast host</span>
      </ToastProvider>,
    );
    toastIds.push(toastManager.add({ type: "success", title: "First", timeout: 60_000 }));
    toastIds.push(toastManager.add({ type: "info", title: "Second", timeout: 60_000 }));
    toastIds.push(toastManager.add({ type: "loading", title: "Third", timeout: 0 }));

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-slot="toast-root"]')).toHaveLength(3);
    });
    const more = [...document.querySelectorAll('[data-slot="toast-more"]')];
    expect(more.map((element) => element.textContent)).toEqual(["+2"]);
    // The two timed toasts carry a ring; the running task does not.
    expect(document.querySelectorAll('[data-slot="toast-countdown"]')).toHaveLength(2);
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
