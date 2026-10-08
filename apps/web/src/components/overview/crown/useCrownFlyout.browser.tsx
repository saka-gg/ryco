import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

import { CROWN_FLYOUT_CLOSE_DELAY_MS } from "./crownLayout";
import { useCrownFlyout } from "./useCrownFlyout";

describe("useCrownFlyout", () => {
  const first = document.createElement("button");
  const second = document.createElement("button");

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(enabled = true) {
    return renderHook((props?: { enabled: boolean }) => useCrownFlyout(props ?? { enabled }), {
      initialProps: { enabled },
    });
  }

  it("opens on hover and retargets between icons", async () => {
    const hook = await setup();
    await hook.act(() => hook.result.current.onRailPointerOver("checks", first));
    expect(hook.result.current.openKey).toBe("checks");
    expect(hook.result.current.anchorEl).toBe(first);
    await hook.act(() => hook.result.current.onRailPointerOver("plan", second));
    expect(hook.result.current.openKey).toBe("plan");
    expect(hook.result.current.anchorEl).toBe(second);
  });

  it("closes after the delay once the pointer leaves", async () => {
    const hook = await setup();
    await hook.act(() => hook.result.current.onRailPointerOver("checks", first));
    await hook.act(() => hook.result.current.onRailPointerLeave());
    await hook.act(() => vi.advanceTimersByTime(CROWN_FLYOUT_CLOSE_DELAY_MS - 1));
    expect(hook.result.current.openKey).toBe("checks");
    await hook.act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.openKey).toBeNull();
  });

  it("stays open while the pointer moves onto the flyout", async () => {
    const hook = await setup();
    await hook.act(() => hook.result.current.onRailPointerOver("checks", first));
    await hook.act(() => hook.result.current.onRailPointerLeave());
    await hook.act(() => hook.result.current.onFlyoutPointerEnter());
    await hook.act(() => vi.advanceTimersByTime(CROWN_FLYOUT_CLOSE_DELAY_MS * 2));
    expect(hook.result.current.openKey).toBe("checks");
    await hook.act(() => hook.result.current.onFlyoutPointerLeave());
    await hook.act(() => vi.advanceTimersByTime(CROWN_FLYOUT_CLOSE_DELAY_MS));
    expect(hook.result.current.openKey).toBeNull();
  });

  it("cancels a pending close when the rail is re-entered", async () => {
    const hook = await setup();
    await hook.act(() => hook.result.current.onRailPointerOver("checks", first));
    await hook.act(() => hook.result.current.onRailPointerLeave());
    await hook.act(() => hook.result.current.onRailPointerOver("checks", first));
    await hook.act(() => vi.advanceTimersByTime(CROWN_FLYOUT_CLOSE_DELAY_MS * 2));
    expect(hook.result.current.openKey).toBe("checks");
  });

  it("closes at once when disabled and ignores hover while disabled", async () => {
    const hook = await setup();
    await hook.act(() => hook.result.current.onRailPointerOver("checks", first));
    await hook.rerender({ enabled: false });
    expect(hook.result.current.openKey).toBeNull();
    await hook.act(() => hook.result.current.onRailPointerOver("plan", second));
    expect(hook.result.current.openKey).toBeNull();
  });

  it("closes on demand", async () => {
    const hook = await setup();
    await hook.act(() => hook.result.current.onRailPointerOver("checks", first));
    await hook.act(() => hook.result.current.close());
    expect(hook.result.current.anchorEl).toBeNull();
  });
});
