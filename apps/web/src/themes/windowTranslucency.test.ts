import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  WINDOW_MATERIAL_CHANGE_EVENT,
  WINDOW_TRANSLUCENCY_ATTRIBUTE,
  __resetWindowTranslucencyForTests,
  applyWindowTranslucencyToDocument,
  getDocumentWindowTranslucencyScope,
  isDesktopBlurUnavailable,
  isWindowTranslucencySupported,
} from "./windowTranslucency";

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly inline = new Map<string, string>();
  readonly style = {
    removeProperty: (name: string) => this.inline.delete(name),
  };
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

function install(bridge: Record<string, unknown> | undefined) {
  const root = new FakeElement();
  const body = new FakeElement();
  root.inline.set("background-color", "#0b0b0c");
  body.inline.set("background-color", "#0b0b0c");
  const events: string[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: root, body },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { desktopBridge: bridge, dispatchEvent: (event: Event) => events.push(event.type) },
  });
  return { root, body, events };
}

/** Lets the bridge promise and its continuation run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("window translucency", () => {
  beforeEach(() => {
    __resetWindowTranslucencyForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "window");
  });

  it("paints the scope and asks the host for the blur once per change", () => {
    const setWindowMaterial = vi.fn(() => Promise.resolve(true));
    const { root, body } = install({ windowTranslucencySupported: true, setWindowMaterial });

    applyWindowTranslucencyToDocument({ scope: "window", blurRadius: 64 });
    applyWindowTranslucencyToDocument({ scope: "window", blurRadius: 64 });

    expect(root.getAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE)).toBe("window");
    expect(getDocumentWindowTranslucencyScope()).toBe("window");
    // The browser-chrome inline fill would cover the glass.
    expect(root.inline.has("background-color")).toBe(false);
    expect(body.inline.has("background-color")).toBe(false);
    expect(setWindowMaterial).toHaveBeenCalledTimes(1);
    expect(setWindowMaterial).toHaveBeenLastCalledWith({ material: "translucent", blurRadius: 64 });

    applyWindowTranslucencyToDocument({ scope: "sidebar", blurRadius: 30 });
    expect(root.getAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE)).toBe("sidebar");
    expect(setWindowMaterial).toHaveBeenLastCalledWith({ material: "translucent", blurRadius: 30 });

    applyWindowTranslucencyToDocument({ scope: "none", blurRadius: 30 });
    expect(root.getAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE)).toBeNull();
    expect(setWindowMaterial).toHaveBeenLastCalledWith({ material: "opaque", blurRadius: 30 });
    expect(setWindowMaterial).toHaveBeenCalledTimes(3);
  });

  it("does not resend an opaque material when only the blur changes", () => {
    const setWindowMaterial = vi.fn(() => Promise.resolve(true));
    install({ windowTranslucencySupported: true, setWindowMaterial });

    applyWindowTranslucencyToDocument({ scope: "none", blurRadius: 64 });
    applyWindowTranslucencyToDocument({ scope: "none", blurRadius: 20 });

    // The first apply of a document re-syncs the host, opaque included.
    expect(setWindowMaterial).toHaveBeenCalledTimes(1);
    expect(setWindowMaterial).toHaveBeenCalledWith({ material: "opaque", blurRadius: 64 });
  });

  it("reports when the host falls back from the custom blur", async () => {
    const setWindowMaterial = vi.fn(() => Promise.resolve(false));
    const { events } = install({ windowTranslucencySupported: true, setWindowMaterial });

    applyWindowTranslucencyToDocument({ scope: "window", blurRadius: 64 });
    await settle();

    expect(isDesktopBlurUnavailable()).toBe(true);
    expect(events).toEqual([WINDOW_MATERIAL_CHANGE_EVENT]);
  });

  it("stays opaque on hosts without the capability", () => {
    const setWindowMaterial = vi.fn(() => Promise.resolve(false));
    const { root } = install({ windowTranslucencySupported: false, setWindowMaterial });

    expect(isWindowTranslucencySupported()).toBe(false);
    applyWindowTranslucencyToDocument({ scope: "window", blurRadius: 64 });

    expect(root.getAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE)).toBeNull();
    expect(setWindowMaterial).not.toHaveBeenCalled();
  });

  it("stays opaque in a plain browser", () => {
    const { root } = install(undefined);

    applyWindowTranslucencyToDocument({ scope: "window", blurRadius: 64 });

    expect(root.getAttribute(WINDOW_TRANSLUCENCY_ATTRIBUTE)).toBeNull();
  });
});
