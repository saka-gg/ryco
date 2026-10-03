import "../../index.css";

import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ToastProvider, toastManager } from "./toast";

vi.mock("@tanstack/react-router", () => ({
  useParams: (options?: { select?: (params: Record<string, string>) => unknown }) => {
    const params = {};
    return options?.select ? options.select(params) : params;
  },
}));

describe("semantic toast surfaces", () => {
  const toastIds: Array<ReturnType<typeof toastManager.add>> = [];
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  afterEach(async () => {
    for (const toastId of toastIds.splice(0)) {
      toastManager.close(toastId);
    }
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted);
    }
    mounted = null;
    document.body.innerHTML = "";
  });

  it("tints semantic glass surfaces while keeping loading neutral", async () => {
    mounted = await render(
      <ToastProvider>
        <span>Toast host</span>
      </ToastProvider>,
    );

    for (const type of ["success", "error", "warning", "info", "loading"] as const) {
      toastIds.push(
        toastManager.add({
          type,
          title: `${type} notification`,
          timeout: 0,
        }),
      );
    }

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-slot="toast-root"]')).toHaveLength(5);
    });

    const roots = new Map(
      [...document.querySelectorAll<HTMLElement>('[data-slot="toast-root"]')].map((root) => [
        root.dataset.type,
        root,
      ]),
    );
    const semanticTypes = ["success", "error", "warning", "info"] as const;
    const semanticBackgrounds = semanticTypes.map((type) => {
      const root = roots.get(type);
      expect(root).toBeDefined();
      const style = getComputedStyle(root!);
      expect(style.getPropertyValue("--app-toast-tone").trim()).not.toBe("");
      expect(style.getPropertyValue("--app-toast-tone-strength").trim()).toBe("8%");
      expect(style.getPropertyValue("--app-toast-tone-border-strength").trim()).toBe("32%");
      expect(root!.querySelectorAll(":scope > .liquid-glass-ring")).toHaveLength(0);
      const close = root!.querySelector<HTMLElement>('[data-slot="toast-close"]');
      expect(close).toBeDefined();
      expect(getComputedStyle(close!).getPropertyValue("--app-toast-tone").trim()).toBe(
        style.getPropertyValue("--app-toast-tone").trim(),
      );
      expect(close!.querySelectorAll(":scope > .liquid-glass-ring")).toHaveLength(0);
      return style.backgroundColor;
    });

    expect(new Set(semanticBackgrounds).size).toBe(semanticTypes.length);

    const loading = roots.get("loading");
    expect(loading).toBeDefined();
    const loadingStyle = getComputedStyle(loading!);
    expect(loadingStyle.getPropertyValue("--app-toast-tone").trim()).toBe("");
    expect(loadingStyle.getPropertyValue("--app-toast-tone-strength").trim()).toBe("");
    expect(loading!.querySelectorAll(":scope > .liquid-glass-ring")).toHaveLength(0);
    expect(semanticBackgrounds).not.toContain(loadingStyle.backgroundColor);
  });
});
