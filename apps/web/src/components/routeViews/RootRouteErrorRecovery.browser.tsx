import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { Route as AppRootRoute } from "../../routes/__root";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
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
});
