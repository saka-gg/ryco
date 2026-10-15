import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("./toast", async () => ({
  toastManager: { add },
  stackedThreadToast: (await import("./toastHelpers")).stackedThreadToast,
}));

import { notifySurfaceLoadFailure } from "./surfaceLoadFailure";

describe("notifySurfaceLoadFailure", () => {
  afterEach(() => {
    add.mockReset();
    vi.restoreAllMocks();
  });

  it("offers the retry in an error toast", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const retry = vi.fn();

    notifySurfaceLoadFailure("side chat", new Error("chunk failed"), retry);

    expect(add).toHaveBeenCalledOnce();
    const toast = add.mock.calls[0]?.[0];
    expect(toast).toMatchObject({ type: "error", title: "Couldn't load the side chat" });
    expect(toast.data?.threadRef).toBeUndefined();
    toast.actionProps.onClick();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("scopes the toast to the thread its retry reopens a surface over", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-a"),
      ThreadId.make("thread-a"),
    );

    notifySurfaceLoadFailure("pull request dialog", new Error("chunk failed"), vi.fn(), threadRef);

    // A thread-scoped toast only shows while that thread is open, so its Retry
    // never reopens the dialog over a different thread.
    expect(add.mock.calls[0]?.[0].data?.threadRef).toEqual(threadRef);
  });
});
