import "../../index.css";

import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const activeDesktopTurns = vi.hoisted(() => ({ count: 1 }));

vi.mock("../../desktopRelaunchGuard.logic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../desktopRelaunchGuard.logic")>()),
  countActiveDesktopTurns: () => activeDesktopTurns.count,
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: (options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = {};
    return options?.select ? options.select(params) : params;
  },
}));

import { ToastProvider, toastManager } from "../ui/toast";
import { desktopRelaunchScheduler } from "./useDesktopRelaunchGuard";

const toastRoots = () => document.querySelectorAll('[data-slot="toast-root"]');

describe("desktop relaunch waiting notice", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    desktopRelaunchScheduler.cancel();
    vi.restoreAllMocks();
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted);
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("stops waiting however the notice is dismissed", async () => {
    mounted = await render(
      <ToastProvider>
        <span>Toast host</span>
      </ToastProvider>,
    );
    const add = vi.spyOn(toastManager, "add");

    await desktopRelaunchScheduler.scheduleAfterActiveTurns(async () => undefined);
    await vi.waitFor(() => expect(toastRoots()).toHaveLength(1));
    expect(desktopRelaunchScheduler.pending()).toBe(true);

    // A swipe or Escape closes the toast through its manager, never through
    // the close button's handler; it must stop the wait all the same.
    toastManager.close(add.mock.results[0]!.value as string);
    await vi.waitFor(() => expect(desktopRelaunchScheduler.pending()).toBe(false));

    // A later wait shows its own notice rather than updating the dismissed one.
    await desktopRelaunchScheduler.scheduleAfterActiveTurns(async () => undefined);
    await vi.waitFor(() => expect(toastRoots()).toHaveLength(1));
    expect(add).toHaveBeenCalledTimes(2);
  });
});
