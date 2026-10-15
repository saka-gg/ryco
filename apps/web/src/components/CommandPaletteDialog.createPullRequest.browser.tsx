import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const prHostChunk = vi.hoisted(() => ({
  load: vi.fn<() => Promise<never>>(() =>
    Promise.reject(new Error("Failed to fetch dynamically imported module")),
  ),
  notify: vi.fn<(surface: string, error: unknown, retry: () => void) => void>(),
}));

// The palette's "New pull request…" host chunk fails to load (offline, or a
// deploy replaced it).
vi.mock("./pullRequests/create/lazyCreatePullRequestDialogHost", async () => {
  const { preloadableLazy } = await import("../lib/preloadableLazy");
  return { LazyCreatePullRequestDialogHost: preloadableLazy(prHostChunk.load) };
});
vi.mock("./ui/surfaceLoadFailure", () => ({
  notifySurfaceLoadFailure: prHostChunk.notify,
}));

import { CommandPaletteDialog } from "./CommandPaletteDialog";
import {
  useCreatePullRequestDialogStore,
  type CreatePullRequestRequest,
} from "./pullRequests/create/createPullRequestDialogStore";

const request: CreatePullRequestRequest = {
  environmentId: EnvironmentId.make("environment-local"),
  projectId: ProjectId.make("project-1"),
  cwd: "/repo",
  repositoryName: "ryco",
};

describe("CommandPaletteDialog pull request host", () => {
  it("drops a request whose dialog chunk fails to load and repeats it on retry", async () => {
    const mounted = await render(<CommandPaletteDialog />);

    useCreatePullRequestDialogStore.getState().openFor(request);

    await vi.waitFor(() => expect(prHostChunk.notify).toHaveBeenCalledOnce());
    expect(prHostChunk.notify.mock.calls[0]?.[0]).toBe("pull request dialog");
    // The request is cleared, so nothing waits on the host, and nothing threw
    // to an error boundary.
    expect(useCreatePullRequestDialogStore.getState()).toMatchObject({
      open: false,
      request: null,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Retry repeats the captured request, which loads the host again.
    prHostChunk.notify.mock.calls[0]?.[2]();
    expect(useCreatePullRequestDialogStore.getState()).toMatchObject({ open: true, request });

    await vi.waitFor(() => expect(prHostChunk.notify).toHaveBeenCalledTimes(2));
    expect(prHostChunk.load).toHaveBeenCalledTimes(2);
    await mounted.unmount();
  });
});
