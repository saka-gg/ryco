import { EnvironmentId, type EnvironmentApi } from "@ryco/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { recordWsConnectionOpened } from "@ryco/client-runtime/rpc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import { PreviewFileNavigationGuard } from "./PreviewFileNavigationGuard";
import { createPreviewFileDocument } from "./PreviewFileEditSession";
import {
  getPreviewFileSession,
  hasUnsavedPreviewFiles,
  resetPreviewFileSessionsForTests,
} from "./previewFileSessions";

const environmentId = EnvironmentId.make("preview-navigation");
const scope = { environmentId, cwd: "/repo" };

async function mountGuard(write: EnvironmentApi["projects"]["writeFile"]) {
  recordWsConnectionOpened({ environmentId });
  const file = {
    relativePath: "app.ts",
    contents: "saved",
    version: "v1",
    encoding: "utf8" as const,
    lineEnding: "lf" as const,
  };
  __setEnvironmentApiOverrideForTests(environmentId, {
    projects: { writeFile: write, readFile: async () => file },
  } as unknown as EnvironmentApi);
  const owner = getPreviewFileSession(scope, createPreviewFileDocument(scope, file));
  const unsubscribe = owner.subscribe(() => {});
  const root = createRootRoute({
    component: () => (
      <>
        <PreviewFileNavigationGuard />
        <Outlet />
      </>
    ),
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div>Editor route</div>,
  });
  const next = createRoute({
    getParentRoute: () => root,
    path: "/statistics",
    component: () => <div>Next route</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, next]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const mounted = await render(<RouterProvider router={router} />);
  await vi.waitFor(() => expect(router.state.status).toBe("idle"));
  return {
    owner,
    router,
    cleanup: async () => {
      unsubscribe();
      await mounted.unmount();
    },
  };
}

afterEach(() => {
  resetPreviewFileSessionsForTests();
  __resetEnvironmentApiOverridesForTests();
});

describe("editor navigation barrier", () => {
  it("waits for a save and edits typed during it before navigating", async () => {
    let finish!: (value: { relativePath: string; version: string }) => void;
    const write = vi
      .fn<EnvironmentApi["projects"]["writeFile"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ relativePath: "app.ts", version: "v3" });
    const h = await mountGuard(write);
    try {
      h.owner.change("first");
      const navigation = h.router.navigate({ to: "/statistics" });
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      expect(h.router.state.location.pathname).toBe("/");
      h.owner.change("second");
      finish({ relativePath: "app.ts", version: "v2" });
      await navigation;
      expect(write).toHaveBeenCalledTimes(2);
      expect(h.router.state.location.pathname).toBe("/statistics");
      expect(hasUnsavedPreviewFiles()).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("blocks failed navigation and hard-close while retaining the draft after its view unsubscribes", async () => {
    const h = await mountGuard(
      vi.fn().mockRejectedValue({ reason: "conflict", message: "External edit" }),
    );
    try {
      h.owner.change("draft");
      void h.router.navigate({ to: "/statistics" });
      await vi.waitFor(() => expect(h.owner.getSnapshot().saveStatus).toBe("conflict"));
      expect(h.router.state.location.pathname).toBe("/");
      expect(h.owner.getSnapshot().contents).toBe("draft");
      const closing = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(closing);
      expect(closing.defaultPrevented).toBe(true);
      await h.owner.discard();
      const cleanClose = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(cleanClose);
      expect(cleanClose.defaultPrevented).toBe(false);
      await h.router.navigate({ to: "/statistics" });
      expect(h.router.state.location.pathname).toBe("/statistics");
    } finally {
      await h.cleanup();
    }
  });
});
