import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  GLASS_BACKED_ATTRIBUTE,
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

  it("lets go of a panel that registered before the cutout installed", async () => {
    // The cutout loads on demand, so the side chat can register first.
    dispose?.();
    const panel = byTestId("panel");
    const unregister = registerInPageGlassOverlay(panel);
    dispose = installGlassOverlayCutout(root);
    await vi.waitFor(() => expect(byTestId("content").style.clipPath).toContain("path(evenodd"));

    unregister();
    await vi.waitFor(() => expect(byTestId("content").style.clipPath).toBe(""));
    await nextFrames(40);
    const originalRequest = window.requestAnimationFrame;
    let cutoutFrames = 0;
    window.requestAnimationFrame = (callback) => {
      if (new Error().stack?.includes("glassOverlayCutout")) cutoutFrames += 1;
      return originalRequest.call(window, callback);
    };
    try {
      // Its column no longer wakes the cutout when it resizes.
      byTestId("column").style.height = "420px";
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(cutoutFrames).toBe(0);
    } finally {
      window.requestAnimationFrame = originalRequest;
    }
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

describe("portaled glass overlay cutout", () => {
  let root: HTMLElement;
  let portal: HTMLElement;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    root.innerHTML = `<div style="width:600px;height:400px">Page text</div>`;
    portal = document.createElement("div");
    document.body.append(root, portal);
    document.documentElement.setAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE, "window");
    dispose = installGlassOverlayCutout(root);
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    root.remove();
    portal.remove();
    document.documentElement.removeAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE);
  });

  const overlay = (className: string, style: string) => {
    const element = document.createElement("div");
    element.className = className;
    element.style.cssText = `position:fixed;${style}`;
    portal.append(element);
    return element;
  };

  it("cuts the page out under a popup that sits on a painted scrim", async () => {
    // The command palette: an empty backdrop dims the page, the popup floats on it.
    overlay("", "inset:0;background:rgb(0 0 0 / 0.6)");
    const popup = overlay("selection-glass-surface", "top:40px;left:40px;width:300px;height:200px");

    await vi.waitFor(() => expect(root.style.clipPath).toContain("path(evenodd"));
    expect(popup.hasAttribute(GLASS_BACKED_ATTRIBUTE)).toBe(false);
  });

  it("marks a popup on another portaled layer as backed instead of cutting the page", async () => {
    const dialog = overlay("", "inset:0;background:rgb(20 20 20)");
    dialog.textContent = "Dialog text";
    const select = overlay(
      "selection-glass-surface",
      "top:40px;left:40px;width:300px;height:200px",
    );

    await vi.waitFor(() => expect(select.hasAttribute(GLASS_BACKED_ATTRIBUTE)).toBe(true));
    expect(root.style.clipPath).toBe("");
  });

  it("never cuts the page out under a toast", async () => {
    overlay("app-toast-surface", "top:12px;left:40px;width:300px;height:80px");
    await nextFrames(3);
    expect(root.style.clipPath).toBe("");
  });
});
