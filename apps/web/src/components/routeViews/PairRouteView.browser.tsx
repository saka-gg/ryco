import "../../index.css";

import type { AuthSessionState } from "@ryco/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  type RouteComponent,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import type { RootAuthGateState } from "../../routes/__root";
import { Route as AppPairRoute } from "../../routes/pair";

const auth: AuthSessionState["auth"] = {
  bootstrapMethods: ["one-time-token"],
  policy: "remote-reachable",
  sessionCookieName: "ryco_session",
  sessionMethods: ["browser-session-cookie"],
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

/**
 * The app's `/pair` route (its guard, its split body and its pending surface)
 * under a root whose session check resolved to `authGateState`, navigated to
 * as a fresh document's first navigation.
 */
/** The app route's guard: it redirects a paired browser and passes the gate state on. */
const pairGuard = AppPairRoute.options.beforeLoad as unknown as (options: {
  readonly context: { readonly authGateState: RootAuthGateState };
}) => Promise<{ readonly authGateState: RootAuthGateState }>;

async function mountPairRoute(authGateState: RootAuthGateState) {
  const root = createRootRoute({ beforeLoad: () => ({ authGateState }) });
  const pair = createRoute({
    getParentRoute: () => root,
    path: "/pair",
    beforeLoad: ({ context }) => pairGuard({ context }),
    component: AppPairRoute.options.component as RouteComponent,
    pendingComponent: AppPairRoute.options.pendingComponent as RouteComponent,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div data-testid="home">Home</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([pair, home]),
    history: createMemoryHistory({ initialEntries: ["/pair"] }),
  });
  const screen = await render(<RouterProvider router={router} />);
  cleanup = () => screen.unmount();
  return router;
}

describe("the /pair route", () => {
  it("splits its body, so a paired launch never loads the pairing form", () => {
    const component = AppPairRoute.options.component as { readonly preload?: unknown };
    expect(typeof component.preload).toBe("function");
  });

  it("renders the pairing form on the first navigation once its chunk has loaded", async () => {
    await mountPairRoute({ status: "requires-auth", auth });

    await expect
      .element(page.getByRole("heading", { name: "Pair with this environment" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(document.body.textContent).not.toContain("Something went wrong");
  });

  it("shows the session check's pairing error on the first render of the form", async () => {
    await mountPairRoute({
      status: "requires-auth",
      auth,
      errorMessage: "The pairing token was rejected by this environment.",
    });

    await expect
      .element(page.getByText("The pairing token was rejected by this environment."))
      .toBeVisible();
  });

  it("renders the hosted pairing surface for a hosted pairing request", async () => {
    await mountPairRoute({ status: "hosted-pairing" });

    // Without a pairing request in the URL the hosted surface says so itself.
    await expect.element(page.getByRole("heading", { name: "Pairing failed" })).toBeVisible();
  });

  it("still sends a paired browser home without loading the form", async () => {
    const router = await mountPairRoute({ status: "authenticated" });

    await expect.element(page.getByTestId("home")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    expect(document.body.textContent).not.toContain("Pair with this environment");
  });
});
