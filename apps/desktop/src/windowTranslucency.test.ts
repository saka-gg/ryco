import { describe, expect, it, vi } from "vite-plus/test";

import {
  WINDOW_TRANSLUCENCY_FALLBACK_VIBRANCY,
  createWindowTranslucencyController,
  parseDesktopWindowMaterial,
} from "./windowTranslucency.ts";

const HANDLE = Buffer.alloc(8);

function makeWindow() {
  return {
    getNativeWindowHandle: vi.fn(() => HANDLE),
    isDestroyed: vi.fn(() => false),
    setBackgroundColor: vi.fn(),
    setVibrancy: vi.fn(),
  };
}

function makeController(addonResult: boolean | null, platform: NodeJS.Platform = "darwin") {
  const setBackgroundBlurRadius = vi.fn((_handle: Buffer, _radius: number) => addonResult === true);
  const loadAddon = vi.fn(() => (addonResult === null ? null : { setBackgroundBlurRadius }));
  const controller = createWindowTranslucencyController({
    platform,
    opaqueBackgroundColor: () => "#0b0b0c",
    loadAddon,
  });
  return { controller, setBackgroundBlurRadius, loadAddon };
}

describe("parseDesktopWindowMaterial", () => {
  it("accepts a material and clamps the blur radius", () => {
    expect(parseDesktopWindowMaterial({ material: "translucent", blurRadius: 400 })).toEqual({
      material: "translucent",
      blurRadius: 64,
    });
    expect(parseDesktopWindowMaterial({ material: "translucent", blurRadius: 0 })).toEqual({
      material: "translucent",
      blurRadius: 1,
    });
    expect(parseDesktopWindowMaterial({ material: "opaque", blurRadius: 12.6 })).toEqual({
      material: "opaque",
      blurRadius: 13,
    });
  });

  it("rejects anything else", () => {
    expect(parseDesktopWindowMaterial(null)).toBeNull();
    expect(parseDesktopWindowMaterial({ material: "glass", blurRadius: 10 })).toBeNull();
    expect(parseDesktopWindowMaterial({ material: "opaque", blurRadius: "10" })).toBeNull();
    expect(parseDesktopWindowMaterial({ material: "opaque", blurRadius: Number.NaN })).toBeNull();
  });
});

describe("createWindowTranslucencyController", () => {
  it("blurs the desktop behind a clear window without a vibrancy material", () => {
    const { controller, setBackgroundBlurRadius } = makeController(true);
    const window = makeWindow();

    expect(controller.apply(window, { material: "translucent", blurRadius: 64 })).toBe(true);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    expect(setBackgroundBlurRadius).toHaveBeenLastCalledWith(HANDLE, 64);
    expect(window.setVibrancy).not.toHaveBeenCalled();
    // The background write must precede the blur call, which installs its own backing.
    expect(window.setBackgroundColor.mock.invocationCallOrder[0]).toBeLessThan(
      setBackgroundBlurRadius.mock.invocationCallOrder[0]!,
    );

    expect(controller.apply(window, { material: "translucent", blurRadius: 20 })).toBe(true);
    expect(setBackgroundBlurRadius).toHaveBeenLastCalledWith(HANDLE, 20);

    expect(controller.apply(window, { material: "opaque", blurRadius: 20 })).toBe(true);
    expect(setBackgroundBlurRadius).toHaveBeenLastCalledWith(HANDLE, 0);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#0b0b0c");
    expect(controller.backgroundColorFor(window)).toBe("#0b0b0c");
  });

  it("skips a repeat of the current material", () => {
    const { controller, setBackgroundBlurRadius } = makeController(true);
    const window = makeWindow();

    controller.apply(window, { material: "opaque", blurRadius: 64 });
    controller.apply(window, { material: "translucent", blurRadius: 64 });
    controller.apply(window, { material: "translucent", blurRadius: 64 });

    expect(setBackgroundBlurRadius).toHaveBeenCalledTimes(1);
    expect(window.setBackgroundColor).toHaveBeenCalledTimes(1);
  });

  it("falls back to vibrancy when the window server refuses the blur", () => {
    const { controller } = makeController(false);
    const window = makeWindow();

    expect(controller.apply(window, { material: "translucent", blurRadius: 64 })).toBe(false);
    expect(window.setVibrancy).toHaveBeenLastCalledWith(WINDOW_TRANSLUCENCY_FALLBACK_VIBRANCY);

    controller.apply(window, { material: "opaque", blurRadius: 64 });
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#0b0b0c");
  });

  it("falls back to vibrancy without the addon and loads it only once", () => {
    const { controller, loadAddon } = makeController(null);
    const first = makeWindow();
    const second = makeWindow();

    expect(controller.apply(first, { material: "translucent", blurRadius: 64 })).toBe(false);
    expect(controller.apply(second, { material: "translucent", blurRadius: 64 })).toBe(false);
    expect(first.setVibrancy).toHaveBeenLastCalledWith(WINDOW_TRANSLUCENCY_FALLBACK_VIBRANCY);
    expect(loadAddon).toHaveBeenCalledTimes(1);
  });

  it("keeps the clear backing and blur through a background repaint", () => {
    const { controller, setBackgroundBlurRadius } = makeController(true);
    const window = makeWindow();
    controller.apply(window, { material: "translucent", blurRadius: 40 });

    controller.syncBackground(window);

    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    expect(setBackgroundBlurRadius).toHaveBeenLastCalledWith(HANDLE, 40);
  });

  it("keeps windows opaque off macOS", () => {
    const { controller, loadAddon } = makeController(true, "win32");
    const window = makeWindow();

    expect(controller.supported).toBe(false);
    expect(controller.apply(window, { material: "translucent", blurRadius: 64 })).toBe(false);
    expect(loadAddon).not.toHaveBeenCalled();
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("ignores destroyed windows", () => {
    const { controller, loadAddon } = makeController(true);
    const window = makeWindow();
    window.isDestroyed.mockReturnValue(true);

    expect(controller.apply(window, { material: "translucent", blurRadius: 64 })).toBe(false);
    expect(loadAddon).not.toHaveBeenCalled();
  });
});
