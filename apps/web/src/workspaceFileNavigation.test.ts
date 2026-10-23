import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createWorkspaceFileOpener } from "./workspaceFileNavigation";

const paneA = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-a") };
const paneB = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-b") };

function fakeRouter(params: Record<string, string>) {
  const navigate = vi.fn(async (_options: Record<string, unknown>) => undefined);
  const router = { state: { matches: [{ params }] }, navigate } as unknown as Parameters<
    typeof createWorkspaceFileOpener
  >[0];
  return { router, navigate };
}

function navigation(navigate: ReturnType<typeof fakeRouter>["navigate"]) {
  const options = navigate.mock.calls.at(-1)?.[0] as {
    to: string;
    params: Record<string, string>;
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
  };
  return {
    to: options.to,
    params: options.params,
    search: options.search({ workspaceOpen: "1", workspaceTab: "review", workspacePr: "7" }),
  };
}

describe("createWorkspaceFileOpener", () => {
  it("opens the routed thread's Files panel at the line", () => {
    const { router, navigate } = fakeRouter({ environmentId: "env-1", threadId: "thread-a" });
    const opener = createWorkspaceFileOpener(router, null);
    expect(opener.canOpen({ path: "src/app.ts" })).toBe(true);
    expect(opener.open({ path: "src/app.ts", line: 12 })).toBe(true);
    expect(navigation(navigate)).toMatchObject({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-a" },
      search: {
        workspaceTab: "files",
        workspaceFile: "src/app.ts",
        workspaceFileLine: 12,
        workspacePr: undefined,
      },
    });
  });

  it("opens a split pane's link in that pane's thread, not the focused one", () => {
    // Pane A is routed (focused); the link sits in pane B.
    const { router, navigate } = fakeRouter({ environmentId: "env-1", threadId: "thread-a" });
    const opener = createWorkspaceFileOpener(router, paneB);
    expect(opener.open({ path: "lib/b.ts" })).toBe(true);
    expect(navigation(navigate)).toMatchObject({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-b" },
      search: { workspaceTab: "files", workspaceFile: "lib/b.ts" },
    });
    expect(createWorkspaceFileOpener(router, paneA).open({ path: "a.ts" })).toBe(true);
    expect(navigation(navigate).params.threadId).toBe("thread-a");
  });

  it("opens a draft's Files panel on its own route", () => {
    const { router, navigate } = fakeRouter({ draftId: "draft-1" });
    expect(createWorkspaceFileOpener(router, null).open({ path: "a.ts" })).toBe(true);
    expect(navigation(navigate)).toMatchObject({
      to: "/draft/$draftId",
      params: { draftId: "draft-1" },
    });
  });

  it("refuses off a thread, without a router, and for paths the route cannot carry", () => {
    const { router, navigate } = fakeRouter({});
    expect(createWorkspaceFileOpener(router, null).canOpen({ path: "a.ts" })).toBe(false);
    expect(createWorkspaceFileOpener(router, null).open({ path: "a.ts" })).toBe(false);
    expect(createWorkspaceFileOpener(null, paneA).open({ path: "a.ts" })).toBe(false);
    const routed = fakeRouter({ environmentId: "env-1", threadId: "thread-a" }).router;
    expect(createWorkspaceFileOpener(routed, null).canOpen({ path: "~cache/a.ts" })).toBe(false);
    expect(createWorkspaceFileOpener(routed, null).open({ path: "~cache/a.ts" })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
