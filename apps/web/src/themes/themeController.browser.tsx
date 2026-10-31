import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { __resetThemeControllerForTests, useTheme } from "../hooks/useTheme";
import {
  APPEARANCE_PREFERENCES_CHANGE_EVENT,
  APPEARANCE_PREFERENCES_STORAGE_KEY,
} from "./appearancePreferences";
import {
  ACTIVE_DARK_THEME_STORAGE_KEY,
  ACTIVE_THEME_STORAGE_KEY,
  DEFAULT_THEME,
  THEME_STYLE_ELEMENT_ID,
  applyThemeToDocument,
  buildThemeDocumentCss,
  findTheme,
} from "./registry";

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

function ThemePicker() {
  const { activeThemeId, setActiveTheme } = useTheme();
  return (
    <>
      <button type="button" onClick={() => setActiveTheme("nord")}>
        use nord
      </button>
      <button type="button" onClick={() => setActiveTheme(activeThemeId)}>
        reselect theme
      </button>
    </>
  );
}

describe("theme controller", () => {
  afterEach(() => {
    localStorage.removeItem("ryco:theme");
    localStorage.removeItem(ACTIVE_THEME_STORAGE_KEY);
    localStorage.removeItem(ACTIVE_DARK_THEME_STORAGE_KEY);
    localStorage.removeItem(APPEARANCE_PREFERENCES_STORAGE_KEY);
    applyThemeToDocument(DEFAULT_THEME);
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

  it("does not rewrite the theme sheet on a light/dark flip", async () => {
    const mounted = await render(
      <>
        <ThemePicker />
        <ThemeConsumer index={0} />
      </>,
    );
    await page.getByRole("button", { name: "use nord" }).click();
    const style = document.getElementById(THEME_STYLE_ELEMENT_ID);
    expect(style).toBeInstanceOf(HTMLStyleElement);
    await nextFrames(3);

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(style!, { childList: true, subtree: true, characterData: true });
    try {
      await page.getByRole("button", { name: "consumer 0", exact: true }).click();
      await vi.waitFor(() =>
        expect(document.documentElement.classList.contains("dark")).toBe(true),
      );
      await nextFrames(3);
      // The sheet holds both variants; only the dark class changes.
      expect(mutations).toHaveLength(0);
      expect(document.getElementById(THEME_STYLE_ELEMENT_ID)).toBe(style);
    } finally {
      observer.disconnect();
      await mounted.unmount();
    }
  });

  it("skips the transition guard when an apply changes nothing", async () => {
    const mounted = await render(<ThemePicker />);
    // A non-default theme, so the theme sheet exists and must stay untouched.
    await page.getByRole("button", { name: "use nord" }).click();
    await nextFrames(3);

    const rootMutations: MutationRecord[] = [];
    const headMutations: MutationRecord[] = [];
    const rootObserver = new MutationObserver((records) => rootMutations.push(...records));
    const headObserver = new MutationObserver((records) => headMutations.push(...records));
    rootObserver.observe(document.documentElement, { attributes: true });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    try {
      // Re-selecting the active theme.
      await page.getByRole("button", { name: "reselect theme" }).click();
      // Another tab changes a preference that emits no CSS.
      localStorage.setItem(
        APPEARANCE_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ diffLayout: "split" }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: APPEARANCE_PREFERENCES_STORAGE_KEY }),
      );
      await nextFrames(3);
      expect(rootMutations).toHaveLength(0);
      expect(headMutations).toHaveLength(0);
      expect(document.documentElement.classList.contains("no-transitions")).toBe(false);
    } finally {
      rootObserver.disconnect();
      headObserver.disconnect();
      await mounted.unmount();
    }
  });

  it("catches up with any theme input changed before the first consumer mounts", async () => {
    // No consumer and no listener yet: another tab switches the active theme
    // and the light/dark mode stays the same.
    expect(document.getElementById(THEME_STYLE_ELEMENT_ID)).toBeNull();
    localStorage.setItem(ACTIVE_THEME_STORAGE_KEY, "nord");

    const mounted = await render(<ThemeConsumer index={0} />);
    const style = document.getElementById(THEME_STYLE_ELEMENT_ID);
    expect(style?.textContent).toBe(buildThemeDocumentCss(findTheme("nord")));
    await nextFrames(3);
    await mounted.unmount();
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

  it("shows dark mode's own palette, and follows another tab's pick", async () => {
    localStorage.setItem("ryco:theme", "dark");
    localStorage.setItem(ACTIVE_THEME_STORAGE_KEY, "nord");
    localStorage.setItem(ACTIVE_DARK_THEME_STORAGE_KEY, "dracula");
    __resetThemeControllerForTests();
    render(<ThemeConsumer index={1} />);
    const background = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
    const probe = document.createElement("div");
    probe.style.color = findTheme("dracula").dark?.background ?? "";
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.style.color = background();
    expect(getComputedStyle(probe).color).toBe(expected);

    // Another tab goes back to "Same as light".
    localStorage.removeItem(ACTIVE_DARK_THEME_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE_DARK_THEME_STORAGE_KEY }));
    await nextFrames();
    probe.style.color = findTheme("nord").dark?.background ?? "";
    const nordDark = getComputedStyle(probe).color;
    probe.style.color = background();
    expect(getComputedStyle(probe).color).toBe(nordDark);
    probe.remove();
  });
});
