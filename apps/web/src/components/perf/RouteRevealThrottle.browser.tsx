import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  type RouteComponent,
} from "@tanstack/react-router";
import { lazy, Suspense, type ComponentType } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { preloadableLazy, useLazyComponentReady } from "../../lib/preloadableLazy";
import { routeTree } from "../../routeTree.gen";

/**
 * Guards against React 19's Suspense reveal throttle on navigation paths.
 *
 * When a Suspense fallback commits, React holds the retry commit until 300 ms
 * after that fallback, even when the code arrives a few milliseconds later.
 * Route bodies split with `lazyRouteComponent` and the root shell loaded through
 * `preloadableLazy` in `beforeLoad` never commit a fallback, so content commits
 * right after its chunk resolves. The `React.lazy` control proves the harness
 * detects the throttle.
 */
const CHUNK_DELAY_MS = 40;
const REVEAL_BUDGET_MS = 50;

interface DeferredModule<P> {
  readonly load: () => Promise<{ readonly View: ComponentType<P> }>;
  /** `performance.now()` when the module promise resolved. */
  readonly resolvedAt: () => number | null;
}

function deferredModule<P extends object>(View: ComponentType<P>): DeferredModule<P> {
  let resolvedAt: number | null = null;
  return {
    load: () =>
      new Promise((resolve) => {
        window.setTimeout(() => {
          resolvedAt = performance.now();
          resolve({ View });
        }, CHUNK_DELAY_MS);
      }),
    resolvedAt: () => resolvedAt,
  };
}

/** Records the first commit of the element carrying `testId`. */
function observeCommit(testId: string): Promise<number> {
  return new Promise((resolve) => {
    const check = () => {
      if (document.querySelector(`[data-testid="${testId}"]`)) {
        observer.disconnect();
        resolve(performance.now());
        return true;
      }
      return false;
    };
    const observer = new MutationObserver(() => {
      check();
    });
    if (!check()) observer.observe(document.body, { childList: true, subtree: true });
  });
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function mountRouter(input: {
  readonly rootBeforeLoad?: () => Promise<void> | void;
  readonly RootView: RouteComponent;
  readonly pageComponent: RouteComponent;
}) {
  const rootBeforeLoad = input.rootBeforeLoad;
  const root = createRootRoute({
    beforeLoad: () => rootBeforeLoad?.(),
    component: input.RootView,
    pendingComponent: () => <div data-testid="root-pending">Loading</div>,
    pendingMs: 0,
    pendingMinMs: 0,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div data-testid="home">Home</div>,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/statistics",
    component: input.pageComponent,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = await render(<RouterProvider router={router} />);
  cleanup = () => screen.unmount();
  return router;
}

describe("route reveal throttle", () => {
  it("commits the root shell right after its chunk resolves", async () => {
    const shell = deferredModule(() => (
      <div data-testid="shell">
        <Outlet />
      </div>
    ));
    const Shell = preloadableLazy(() => shell.load().then((module) => module.View));
    const committed = observeCommit("shell");

    await mountRouter({
      rootBeforeLoad: () => Shell.preload(),
      RootView: () => (
        <Suspense fallback={<div data-testid="shell-fallback" />}>
          <Shell />
        </Suspense>
      ),
      pageComponent: () => null,
    });

    const commitAt = await committed;
    expect(shell.resolvedAt()).not.toBeNull();
    expect(commitAt - shell.resolvedAt()!).toBeLessThan(REVEAL_BUDGET_MS);
  });

  it("commits a route-level split page right after its chunk resolves", async () => {
    const statistics = deferredModule(() => <div data-testid="statistics">Statistics</div>);
    const router = await mountRouter({
      RootView: () => <Outlet />,
      pageComponent: lazyRouteComponent(statistics.load, "View"),
    });
    await observeCommit("home");

    const committed = observeCommit("statistics");
    void router.navigate({ to: "/statistics" });
    // While the chunk loads, the previous page stays up instead of a blank fallback.
    await new Promise((resolve) => window.setTimeout(resolve, CHUNK_DELAY_MS / 2));
    expect(statistics.resolvedAt()).toBeNull();
    expect(document.querySelector('[data-testid="home"]')).not.toBeNull();
    const commitAt = await committed;

    expect(statistics.resolvedAt()).not.toBeNull();
    expect(commitAt - statistics.resolvedAt()!).toBeLessThan(REVEAL_BUDGET_MS);
    expect(document.querySelector('[data-testid="home"]')).toBeNull();
  });

  it("detects the throttle on a React.lazy route body (control)", async () => {
    const statistics = deferredModule(() => <div data-testid="statistics">Statistics</div>);
    const LazyStatistics = lazy(() =>
      statistics.load().then((module) => ({ default: module.View })),
    );
    const router = await mountRouter({
      RootView: () => <Outlet />,
      pageComponent: () => (
        <Suspense fallback={null}>
          <LazyStatistics />
        </Suspense>
      ),
    });
    await observeCommit("home");

    const committed = observeCommit("statistics");
    void router.navigate({ to: "/statistics" });
    const commitAt = await committed;

    expect(commitAt - statistics.resolvedAt()!).toBeGreaterThan(150);
  });
});

describe("on-demand lazy surfaces", () => {
  it("mounts a surface preloaded after its first render on the pass that wants it", async () => {
    // The hook runs through React Compiler here, as in the app: a cached
    // `isLoaded()` answer from the first render would cost an extra commit.
    const dialog = deferredModule(() => <div data-testid="dialog">Dialog</div>);
    const Dialog = preloadableLazy(() => dialog.load().then((module) => module.View));
    const renders: Array<{ readonly wanted: boolean; readonly ready: boolean }> = [];
    function DialogMount({ wanted }: { readonly wanted: boolean }) {
      const ready = useLazyComponentReady(Dialog, wanted);
      renders.push({ wanted, ready });
      return wanted && ready ? <Dialog /> : null;
    }

    const screen = await render(<DialogMount wanted={false} />);
    cleanup = () => screen.unmount();
    // An idle preload lands while the surface is mounted but not wanted.
    await Dialog.preload();
    await screen.rerender(<DialogMount wanted />);

    expect(document.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(renders.find((entry) => entry.wanted)).toEqual({ wanted: true, ready: true });
  });
});

describe("app route tree", () => {
  it("splits every page body at the route level, so the reveal guarantees above apply to it", () => {
    // Route shells that render without a code-split body: the root (which
    // loads its shell in `beforeLoad`), the chat layout and index, and the
    // pairing surface, which must render on the first navigation.
    const EAGER_ROUTE_IDS = ["/_chat", "/_chat/", "/pair", "__root__"];
    // Building the router only initialises the route objects; nothing loads.
    const router = createRouter({ routeTree, history: createMemoryHistory() });
    const eager: string[] = [];
    const split: string[] = [];
    for (const route of Object.values(router.routesById)) {
      const component = route.options.component as { readonly preload?: unknown } | undefined;
      if (!component) continue;
      (typeof component.preload === "function" ? split : eager).push(route.id);
    }

    expect(eager.toSorted()).toEqual(EAGER_ROUTE_IDS);
    expect(split).toEqual(
      expect.arrayContaining([
        "/_chat/$environmentId/$threadId",
        "/_chat/draft/$draftId",
        "/statistics",
        "/projects",
        "/pull-requests",
        "/settings",
      ]),
    );
  });
});
