import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import type { HostedPwaSnapshot, HostedPwaUpdateState } from "../../pwa/lifecycle";
import { Route as AppRootRoute } from "../../routes/__root";

/** The hosted PWA lifecycle the error view reads, with a settable update state. */
const pwa = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot: HostedPwaSnapshot = {
    errorMessage: null,
    installState: "hidden",
    platform: "other",
    registrationState: "ready",
    updateState: "idle",
  };
  const lifecycle = {
    activateUpdate: vi.fn(),
    dismissInstall: vi.fn(),
    getSnapshot: () => snapshot,
    promptInstall: vi.fn(async () => undefined),
    reloadApp: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    lifecycle,
    setUpdateState(updateState: HostedPwaUpdateState) {
      snapshot = { ...snapshot, updateState };
      listeners.forEach((listener) => listener());
    },
  };
});

vi.mock("../../pwa/lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pwa/lifecycle")>()),
  hostedPwaLifecycle: pwa.lifecycle,
}));

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  pwa.setUpdateState("idle");
  pwa.lifecycle.reloadApp.mockClear();
});

/**
 * The app's root error view, mounted under a root route whose `beforeLoad`
 * fails the way the bootstrap reads now fail: with a timeout after their
 * transient-retry budget, instead of hanging on the boot surface forever.
 */
async function mountFailingRoot(failures: number) {
  let attempts = 0;
  const root = createRootRoute({
    beforeLoad: async () => {
      attempts += 1;
      if (attempts <= failures) {
        const error = new Error("The server did not answer in time.");
        error.name = "TimeoutError";
        throw error;
      }
    },
    errorComponent: AppRootRoute.options.errorComponent,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div data-testid="ready">Ready</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = await render(<RouterProvider router={router} />);
  cleanup = () => screen.unmount();
  return { attempts: () => attempts };
}

describe("root route error recovery", () => {
  it("offers Try again and Reload when the bootstrap reads time out", async () => {
    await mountFailingRoot(1);

    await expect.element(page.getByText("Something went wrong.")).toBeVisible();
    await expect.element(page.getByText("The server did not answer in time.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload app" })).toBeVisible();
  });

  it("re-runs the root beforeLoad on Try again instead of re-rendering the failed match", async () => {
    const root = await mountFailingRoot(1);
    await expect.element(page.getByText("Something went wrong.")).toBeVisible();
    expect(root.attempts()).toBe(1);

    await page.getByRole("button", { name: "Try again" }).click();

    await expect.element(page.getByTestId("ready")).toBeVisible();
    expect(root.attempts()).toBe(2);
    expect(document.body.textContent).not.toContain("Something went wrong.");
  });

  it("stays on the error view when the retry fails again, and can retry once more", async () => {
    const root = await mountFailingRoot(2);
    await expect.element(page.getByText("Something went wrong.")).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => root.attempts()).toBe(2);
    await expect.element(page.getByText("Something went wrong.")).toBeVisible();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect.element(page.getByTestId("ready")).toBeVisible();
    expect(root.attempts()).toBe(3);
  });

  it("reloads through the PWA lifecycle, which owns switching to a waiting build", async () => {
    await mountFailingRoot(1);

    await page.getByRole("button", { name: "Reload app" }).click();
    expect(pwa.lifecycle.reloadApp).toHaveBeenCalledOnce();
  });

  it("offers the waiting update in place of a reload into the stale build", async () => {
    await mountFailingRoot(1);
    await expect.element(page.getByRole("button", { name: "Reload app" })).toBeVisible();

    pwa.setUpdateState("ready");

    await expect
      .element(page.getByText("A new version of the app is ready. Update to continue."))
      .toBeVisible();
    await page.getByRole("button", { name: "Update app" }).click();
    expect(pwa.lifecycle.reloadApp).toHaveBeenCalledOnce();

    pwa.setUpdateState("activating");
    await expect.element(page.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });
});
