import type { AnyRouter } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
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
});
