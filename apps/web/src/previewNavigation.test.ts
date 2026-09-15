import { describe, expect, it } from "vite-plus/test";
import { navigateWithPreviewGuard, reportPreviewNavigationBlocked } from "./previewNavigation";
describe("pane navigation outcomes", () => {
  it("settles a rejected history navigation even when the router promise stays pending", async () => {
    const controller = new AbortController();
    const result = navigateWithPreviewGuard(
      "/thread/b",
      () => new Promise<void>(() => {}),
      controller.signal,
    );
    reportPreviewNavigationBlocked("/unrelated");
    reportPreviewNavigationBlocked("/thread/b");
    expect(await result).toBe(false);
  });
  it("releases an unmounted pane and propagates navigation failures", async () => {
    const controller = new AbortController();
    const result = navigateWithPreviewGuard(
      "/thread/b",
      () => new Promise<void>(() => {}),
      controller.signal,
    );
    controller.abort();
    expect(await result).toBe(false);
    await expect(
      navigateWithPreviewGuard(
        "/thread/b",
        () => Promise.reject(new Error("Navigation failed")),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Navigation failed");
  });
  it("accepts completed navigation", async () => {
    expect(
      await navigateWithPreviewGuard("/thread/b", async () => {}, new AbortController().signal),
    ).toBe(true);
  });
});
