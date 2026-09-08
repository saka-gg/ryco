import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { useIsIntersectingViewport } from "./useHasIntersectedViewport";

class IntersectionObserverHarness {
  static current: IntersectionObserverHarness | null = null;

  private target: Element | null = null;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    IntersectionObserverHarness.current = this;
  }

  observe(target: Element): void {
    this.target = target;
  }

  disconnect(): void {
    this.target = null;
  }

  emit(isIntersecting: boolean): void {
    if (!this.target) throw new Error("No viewport target is being observed.");
    this.callback(
      [{ target: this.target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function IntersectionProbe(props: { readonly offscreen?: boolean }) {
  const [setNode, isIntersecting] = useIsIntersectingViewport();
  return (
    <div
      ref={setNode}
      data-testid="intersection-probe"
      data-intersecting={isIntersecting}
      style={{ height: 1, ...(props.offscreen ? { position: "fixed", top: "200vh" } : {}) }}
    />
  );
}

describe("useIsIntersectingViewport", () => {
  afterEach(() => {
    IntersectionObserverHarness.current = null;
    vi.unstubAllGlobals();
  });

  it("tracks both viewport entry and exit instead of retaining one-way visibility", async () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverHarness);
    const mounted = await render(<IntersectionProbe />);
    const probe = page.getByTestId("intersection-probe");

    await vi.waitFor(() => expect(IntersectionObserverHarness.current).not.toBeNull());
    expect(IntersectionObserverHarness.current?.options?.rootMargin).toBe("160px 0px");
    await expect.element(probe).toHaveAttribute("data-intersecting", "false");

    IntersectionObserverHarness.current?.emit(true);
    await expect.element(probe).toHaveAttribute("data-intersecting", "true");

    IntersectionObserverHarness.current?.emit(false);
    await expect.element(probe).toHaveAttribute("data-intersecting", "false");

    await mounted.unmount();
  });

  it("falls back to viewport geometry when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const mounted = await render(<IntersectionProbe />);

    await expect
      .element(page.getByTestId("intersection-probe"))
      .toHaveAttribute("data-intersecting", "true");

    await mounted.rerender(<IntersectionProbe offscreen />);
    window.dispatchEvent(new Event("scroll"));
    await expect
      .element(page.getByTestId("intersection-probe"))
      .toHaveAttribute("data-intersecting", "false");

    await mounted.unmount();
  });
});
