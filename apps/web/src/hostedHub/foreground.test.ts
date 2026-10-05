import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { subscribeWebForeground } from "./foreground";

afterEach(() => vi.unstubAllGlobals());

describe("hosted foreground subscription", () => {
  it("waits through hidden events and invokes recovery once when visible", () => {
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", document);
    const listener = vi.fn();
    subscribeWebForeground(listener);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("cancels the pending foreground listener on disposal", () => {
    const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("document", document);
    const listener = vi.fn();
    const dispose = subscribeWebForeground(listener);
    dispose();
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
  });
});
