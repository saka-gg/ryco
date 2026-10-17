import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  GLASS_IN_PAGE_ATTRIBUTE,
  installGlassOverlayCutout,
  registerInPageGlassOverlay,
} from "../lib/glassOverlayCutout";
import { WINDOW_TRANSLUCENCY_ATTRIBUTE } from "./windowTranslucency";

const nextFrames = (count: number) =>
  new Promise<void>((resolve) => {
    let remaining = count;
    const step = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe("in-page glass overlay cutout", () => {
  let root: HTMLElement;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    root.innerHTML = `
      <div data-testid="column" style="position:relative;width:600px;height:400px">
        <header data-testid="header" style="height:40px"></header>
        <div data-testid="content" style="height:360px"></div>
        <aside data-testid="panel" style="position:absolute;top:12px;right:12px;width:200px;height:300px;border-radius:16px"></aside>
      </div>`;
    document.body.append(root);
    document.documentElement.setAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE, "window");
    dispose = installGlassOverlayCutout(root);
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    root.remove();
    document.documentElement.removeAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE);
  });

  const byTestId = (id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

  it("cuts the panel's siblings out from under it and restores them on unregister", async () => {
    const panel = byTestId("panel");
    const unregister = registerInPageGlassOverlay(panel);
    expect(panel.hasAttribute(GLASS_IN_PAGE_ATTRIBUTE)).toBe(true);

    await vi.waitFor(() => {
      expect(byTestId("header").style.clipPath).toContain("path(evenodd");
      expect(byTestId("content").style.clipPath).toContain("path(evenodd");
    });
    // The hole follows the panel's box and corner radius, in the sibling's own space.
    expect(byTestId("content").style.clipPath).toContain("M 404 -28");
    expect(panel.style.clipPath).toBe("");

    unregister();
    expect(panel.hasAttribute(GLASS_IN_PAGE_ATTRIBUTE)).toBe(false);
    await vi.waitFor(() => {
      expect(byTestId("header").style.clipPath).toBe("");
      expect(byTestId("content").style.clipPath).toBe("");
    });
  });

  it("only cuts on whole-window glass", async () => {
    document.documentElement.setAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE, "sidebar");
    const unregister = registerInPageGlassOverlay(byTestId("panel"));
    await nextFrames(3);
    expect(byTestId("content").style.clipPath).toBe("");
    unregister();
  });

  it("stops measuring once an open panel's geometry settles", async () => {
    const unregister = registerInPageGlassOverlay(byTestId("panel"));
    await vi.waitFor(() => expect(byTestId("content").style.clipPath).not.toBe(""));
    // Let the settle window pass, then count the cutout's own frame requests.
    await nextFrames(40);
    const originalRequest = window.requestAnimationFrame;
    let cutoutFrames = 0;
    window.requestAnimationFrame = (callback) => {
      if (new Error().stack?.includes("glassOverlayCutout")) cutoutFrames += 1;
      return originalRequest.call(window, callback);
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(cutoutFrames).toBe(0);
      // A resize restarts it, and the hole follows the new geometry.
      byTestId("panel").style.width = "240px";
      await vi.waitFor(() => expect(byTestId("content").style.clipPath).toContain("M 364 -28"));
      expect(cutoutFrames).toBeGreaterThan(0);
    } finally {
      window.requestAnimationFrame = originalRequest;
      unregister();
    }
  });
});
