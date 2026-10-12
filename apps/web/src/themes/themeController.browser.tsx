import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { __resetThemeControllerForTests, useTheme } from "../hooks/useTheme";
import { APPEARANCE_PREFERENCES_CHANGE_EVENT } from "./appearancePreferences";

async function nextFrames(count = 2) {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function ThemeConsumer(props: { readonly index: number }) {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button type="button" data-theme={resolvedTheme} onClick={() => setTheme("dark")}>
      consumer {props.index}
    </button>
  );
}

describe("theme controller", () => {
  afterEach(() => {
    localStorage.removeItem("ryco:theme");
    document.documentElement.classList.remove("dark");
    __resetThemeControllerForTests();
  });

  it("applies the theme once per change, not once per consumer", async () => {
    // The module applied the stored (default) theme when it loaded.
    const appearanceEvents = vi.fn();
    window.addEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, appearanceEvents);
    const addListener = vi.spyOn(window, "addEventListener");
    const headMutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => headMutations.push(...records));
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    try {
      const mounted = await render(
        <>
          {Array.from({ length: 25 }, (_, index) => (
            <ThemeConsumer key={index} index={index} />
          ))}
        </>,
      );
      await nextFrames();
      // Mounting 25 consumers rewrites nothing and installs one listener set.
      expect(appearanceEvents).not.toHaveBeenCalled();
      expect(headMutations).toHaveLength(0);
      expect(addListener.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);

      await page.getByRole("button", { name: "consumer 3", exact: true }).click();
      await vi.waitFor(() =>
        expect(document.documentElement.classList.contains("dark")).toBe(true),
      );
      expect(appearanceEvents).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(document.querySelectorAll('button[data-theme="dark"]')).toHaveLength(25),
      );
      // The transition guard lifts without a forced synchronous reflow.
      await nextFrames(3);
      expect(document.documentElement.classList.contains("no-transitions")).toBe(false);
      await mounted.unmount();
    } finally {
      observer.disconnect();
      addListener.mockRestore();
      window.removeEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, appearanceEvents);
    }
  });

  it("keeps applying theme changes while no consumer is mounted", async () => {
    const mounted = await render(<ThemeConsumer index={0} />);
    await mounted.unmount();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // Another tab switches to dark while this page shows no themed component.
    localStorage.setItem("ryco:theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "ryco:theme", newValue: "dark" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await nextFrames(3);
  });
});
