import type { AnyRouter } from "@tanstack/react-router";

import type { FileRoutesById } from "../routeTree.gen";

/**
 * Warms route component chunks outside a navigation.
 *
 * Route bodies are split with `lazyRouteComponent`, whose chunk the router
 * awaits before it commits a match, so a navigation never shows a Suspense
 * fallback. Starting that same load earlier — at idle after the shell paints,
 * when the welcome names the bootstrap thread, or when a click is about to
 * navigate — takes the download off the navigation's critical path.
 *
 * The document has exactly one router; `getRouter` registers it here so
 * callers outside React (route `beforeLoad`, action helpers) can reach it.
 */
export type AppRouteId = keyof FileRoutesById;

const NOOP = () => undefined;

let registeredRouter: AnyRouter | null = null;

export function registerRouteChunkRouter(router: AnyRouter): void {
  registeredRouter = router;
}

function loadRouteChunks(router: AnyRouter, routes: ReadonlyArray<AnyRouter["routeTree"]>) {
  const loads: Promise<void>[] = [];
  for (const route of routes) {
    try {
      const loading = router.loadRouteChunk(route);
      if (loading) loads.push(loading.then(NOOP, NOOP));
    } catch {
      // Preloading is advisory; the navigation that needs the chunk reports failures.
    }
  }
  return loads.length === 0 ? Promise.resolve() : Promise.all(loads).then(NOOP);
}

/** Starts (or joins) the component chunk load of one route. Never rejects. */
export function preloadRouteChunk(routeId: AppRouteId): Promise<void> {
  const router = registeredRouter;
  const route = router?.routesById[routeId] as AnyRouter["routeTree"] | undefined;
  if (!router || !route) return Promise.resolve();
  return loadRouteChunks(router, [route]);
}

/**
 * Starts the component chunks of every route matching `pathname`, so a
 * deep-linked document downloads the page body while the root `beforeLoad`
 * is still authenticating. Never rejects.
 */
export function preloadMatchedRouteChunks(pathname: string): Promise<void> {
  const router = registeredRouter;
  if (!router) return Promise.resolve();
  let matched: ReadonlyArray<AnyRouter["routeTree"]>;
  try {
    [matched] = router.getMatchedRoutes(pathname);
  } catch {
    return Promise.resolve();
  }
  return loadRouteChunks(router, matched);
}

export function resetRouteChunkPreloadForTests(): void {
  registeredRouter = null;
}
