import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  pathnameMatchesRoute,
  preloadMatchedRouteChunks,
  preloadRouteChunk,
  registerRouteChunkRouter,
  resetRouteChunkPreloadForTests,
} from "./routeChunkPreload";

function fakeRouter(input: {
  readonly loadRouteChunk: (route: { readonly id: string }) => Promise<void> | undefined;
  readonly matched?: ReadonlyArray<{ readonly id: string }>;
}) {
  const routes = {
    "/_chat/$environmentId/$threadId": { id: "/_chat/$environmentId/$threadId" },
    "/_chat/draft/$draftId": { id: "/_chat/draft/$draftId" },
  };
  return {
    routesById: routes,
    loadRouteChunk: vi.fn(input.loadRouteChunk),
    getMatchedRoutes: vi.fn(() => [input.matched ?? [], {}, undefined]),
  };
}

describe("route chunk preloading", () => {
  afterEach(() => {
    resetRouteChunkPreloadForTests();
  });

  it("is a no-op before a router is registered", async () => {
    await expect(preloadRouteChunk("/_chat/draft/$draftId")).resolves.toBeUndefined();
    await expect(preloadMatchedRouteChunks("/statistics")).resolves.toBeUndefined();
  });

  it("loads the chunk of a route by id", async () => {
    const router = fakeRouter({ loadRouteChunk: () => Promise.resolve() });
    registerRouteChunkRouter(router as unknown as AnyRouter);

    await preloadRouteChunk("/_chat/draft/$draftId");

    expect(router.loadRouteChunk).toHaveBeenCalledWith(router.routesById["/_chat/draft/$draftId"]);
  });

  it("never rejects, even when a chunk fails to load or the router throws", async () => {
    const failing = fakeRouter({ loadRouteChunk: () => Promise.reject(new Error("offline")) });
    registerRouteChunkRouter(failing as unknown as AnyRouter);
    await expect(preloadRouteChunk("/_chat/$environmentId/$threadId")).resolves.toBeUndefined();

    const throwing = fakeRouter({
      loadRouteChunk: () => {
        throw new Error("no chunk");
      },
    });
    registerRouteChunkRouter(throwing as unknown as AnyRouter);
    await expect(preloadRouteChunk("/_chat/$environmentId/$threadId")).resolves.toBeUndefined();
  });

  it("loads every matched route of a deep link", async () => {
    const matched = [{ id: "__root__" }, { id: "/statistics" }];
    const router = fakeRouter({ loadRouteChunk: () => Promise.resolve(), matched });
    registerRouteChunkRouter(router as unknown as AnyRouter);

    await preloadMatchedRouteChunks("/statistics");

    expect(router.getMatchedRoutes).toHaveBeenCalledWith("/statistics");
    expect(router.loadRouteChunk).toHaveBeenCalledTimes(2);
  });

  describe("pathnameMatchesRoute", () => {
    // The app's chat layout, enough to tell a thread from a draft or the index.
    function registerChatRouter() {
      const rootRoute = createRootRoute();
      const chatRoute = createRoute({ getParentRoute: () => rootRoute, id: "_chat" });
      const routeTree = rootRoute.addChildren([
        chatRoute.addChildren([
          createRoute({ getParentRoute: () => chatRoute, path: "/" }),
          createRoute({ getParentRoute: () => chatRoute, path: "draft/$draftId" }),
          createRoute({ getParentRoute: () => chatRoute, path: "$environmentId/$threadId" }),
        ]),
      ]);
      const router = createRouter({ routeTree, history: createMemoryHistory() });
      registerRouteChunkRouter(router as unknown as AnyRouter);
    }

    it("is false before a router is registered", () => {
      expect(pathnameMatchesRoute("/env-1/thread-1", "/_chat/$environmentId/$threadId")).toBe(
        false,
      );
    });

    it("matches a thread path to the thread route, and drafts and the index to nothing of it", () => {
      registerChatRouter();

      expect(pathnameMatchesRoute("/env-1/thread-1", "/_chat/$environmentId/$threadId")).toBe(true);
      expect(pathnameMatchesRoute("/draft/draft-1", "/_chat/$environmentId/$threadId")).toBe(false);
      expect(pathnameMatchesRoute("/draft/draft-1", "/_chat/draft/$draftId")).toBe(true);
      expect(pathnameMatchesRoute("/", "/_chat/$environmentId/$threadId")).toBe(false);
    });

    it("is false when the router cannot match the path", () => {
      const router = fakeRouter({ loadRouteChunk: () => undefined });
      router.getMatchedRoutes.mockImplementation(() => {
        throw new Error("no match");
      });
      registerRouteChunkRouter(router as unknown as AnyRouter);

      expect(pathnameMatchesRoute("/env-1/thread-1", "/_chat/$environmentId/$threadId")).toBe(
        false,
      );
    });
  });
});
