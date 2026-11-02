import { createElement } from "react";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { registerRouteChunkRouter } from "./lib/routeChunkPreload";
import { parseRouterSearch, stringifyRouterSearch } from "./lib/routerSearch";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: {},
    // Route bodies are split with `lazyRouteComponent`; hovering or focusing a
    // `<Link>` warms the target's chunk so the click commits without waiting.
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    // A prompt link's text must reach its view as written (`lib/routerSearch.ts`).
    parseSearch: parseRouterSearch,
    stringifySearch: stringifyRouterSearch,
    Wrap: ({ children }) => createElement(AppAtomRegistryProvider, undefined, children),
  });
  registerRouteChunkRouter(router);
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
