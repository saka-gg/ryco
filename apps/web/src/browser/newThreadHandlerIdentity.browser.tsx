import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";

describe("useNewThreadHandler", () => {
  it("keeps the handlers' identity across renders that change none of their inputs", async () => {
    const handlers = new Set<unknown>();
    const chatHandlers = new Set<unknown>();
    function Host() {
      const [count, setCount] = useState(0);
      const { handleNewThread, handleNewChat } = useNewThreadHandler();
      handlers.add(handleNewThread);
      chatHandlers.add(handleNewChat);
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          render {count}
        </button>
      );
    }
    const rootRoute = createRootRoute({ component: Host });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const mounted = await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
    );
    try {
      await expect.element(page.getByRole("button", { name: "render 0" })).toBeInTheDocument();
      const before = handlers.size;
      for (let index = 1; index <= 3; index += 1) {
        await page.getByRole("button").click();
        await expect
          .element(page.getByRole("button", { name: `render ${index}` }))
          .toBeInTheDocument();
      }
      // Sidebar passes the handler to every memoized project row.
      expect(handlers.size).toBe(before);
      expect(chatHandlers.size).toBe(before);
    } finally {
      await mounted.unmount();
    }
  });
});
