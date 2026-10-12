import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { lazyScreen } from "./lazyScreen";

describe("lazy route screens", () => {
  it("does not load the screen module until it renders or is preloaded", () => {
    const Screen = (props: { readonly label: string }) => createElement("Text", null, props.label);
    const load = vi.fn(() => Screen);
    const Lazy = lazyScreen("Probe", load);

    expect(load).not.toHaveBeenCalled();
    expect(Lazy.displayName).toBe("Probe");

    const element = Lazy({ label: "hello" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(element.type).toBe(Screen);
    expect(element.props).toEqual({ label: "hello" });
  });

  it("evaluates the module once across renders and preloads", () => {
    const load = vi.fn(() => () => null);
    const Lazy = lazyScreen("Probe", load);

    Lazy.preload();
    Lazy.preload();
    Lazy({});

    expect(load).toHaveBeenCalledTimes(1);
  });
});
