import { ComposerSettings } from "./ComposerSettings";
import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  ACTIVE_THEME_STORAGE_KEY,
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_STYLE_ELEMENT_ID,
} from "../../themes/registry";
import {
  APPEARANCE_PREFERENCES_STORAGE_KEY,
  APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID,
  FONT_FAMILY_MONO_OPTIONS,
  FONT_FAMILY_SANS_OPTIONS,
  PRIMARY_COLOR_OPTIONS,
  SURFACE_TRANSPARENCY_OPTIONS,
} from "../../themes/appearancePreferences";
import { useUiStateStore } from "../../uiStateStore";
import { AppearanceSettingsPanel } from "./AppearanceSettings";

describe("AppearanceSettingsPanel", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    document.getElementById(THEME_STYLE_ELEMENT_ID)?.remove();
    document.getElementById(APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID)?.remove();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    useUiStateStore.getState().setWideComposerControlsAutoCollapse(true);
    useUiStateStore.getState().setAlwaysUseBuildMode(true);
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
    document.documentElement.className = "";
    document.getElementById(THEME_STYLE_ELEMENT_ID)?.remove();
    document.getElementById(APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID)?.remove();
    useUiStateStore.getState().setWideComposerControlsAutoCollapse(true);
    useUiStateStore.getState().setAlwaysUseBuildMode(true);
  });

  it("previews color modes and theme palettes at desktop size", async () => {
    await page.viewport(1100, 780);
    mounted = await render(
      <div style={{ width: 850, height: 720, overflow: "auto", margin: "20px auto" }}>
        <AppearanceSettingsPanel />
      </div>,
    );
    const dark = page.getByRole("button", { name: "Dark", exact: true });
    await dark.click();
    await expect.element(dark).toHaveAttribute("aria-pressed", "true");
    const gallery = page.getByRole("radiogroup", { name: "Theme palette" }).element();
    const previews = gallery.querySelectorAll<HTMLElement>('[aria-hidden="true"][style]');
    expect(previews.length).toBeGreaterThan(3);
    expect(
      new Set(Array.from(previews, (preview) => getComputedStyle(preview).backgroundColor)).size,
    ).toBeGreaterThan(3);
  });

  it("previews and remembers the selected diff style", async () => {
    await page.viewport(1100, 780);
    mounted = await render(
      <div style={{ width: 800 }}>
        <AppearanceSettingsPanel />
      </div>,
    );
    await expect
      .element(page.getByRole("button", { name: "Unified diff style" }))
      .toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Split diff style" }).click();
    await expect
      .element(page.getByRole("button", { name: "Split diff style" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(
      JSON.parse(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY) ?? "{}").diffLayout,
    ).toBe("split");
  });

  it("lists built-in themes and applies a selected built-in theme", async () => {
    mounted = await render(<AppearanceSettingsPanel />);

    await expect.element(page.getByRole("radio", { name: /Default/ })).toBeInTheDocument();
    await expect.element(page.getByText("Midnight Graphite", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Nord", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("One Dark Pro", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Dracula", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("GitHub", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Catppuccin", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Tokyo Night", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("Cursor Dark Inspired", { exact: true }))
      .not.toBeInTheDocument();

    await page.getByRole("radio", { name: /Midnight Graphite/ }).click();

    expect(localStorage.getItem(ACTIVE_THEME_STORAGE_KEY)).toBe("midnight-graphite");
    await vi.waitFor(() => {
      expect(document.getElementById(THEME_STYLE_ELEMENT_ID)?.textContent).toContain("#040404");
    });

    await page.getByRole("radio", { name: /One Dark Pro/ }).click();

    expect(localStorage.getItem(ACTIVE_THEME_STORAGE_KEY)).toBe("one-dark-pro");
    await vi.waitFor(() => {
      expect(document.getElementById(THEME_STYLE_ELEMENT_ID)?.textContent).toContain("#282c34");
    });
  });

  it("adds, duplicates, and deletes custom themes", async () => {
    mounted = await render(<AppearanceSettingsPanel />);

    await page.getByRole("button", { name: "Create a new theme" }).click();
    await expect.element(page.getByRole("radio", { name: /New theme/ })).toBeInTheDocument();
    expect(localStorage.getItem(ACTIVE_THEME_STORAGE_KEY)).toBe("custom-new");

    await page.getByRole("button", { name: "Theme actions for Default", exact: true }).click();
    await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
    await expect.element(page.getByRole("radio", { name: /Default \(Copy\)/ })).toBeInTheDocument();

    await page.getByRole("button", { name: "Theme actions for New theme", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect.element(page.getByText("Delete custom theme?")).toBeInTheDocument();
    await page.getByRole("button", { name: "Delete theme" }).click();

    await expect.element(page.getByRole("radio", { name: /New theme/ })).not.toBeInTheDocument();
    expect(localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)).not.toContain("custom-new");
  });

  it("persists global interface controls outside the active theme", async () => {
    mounted = await render(<AppearanceSettingsPanel />);

    const interfaceFontLabel = "Geist";
    const codeFontLabel = "Geist Mono";
    const interfaceFontValue = FONT_FAMILY_SANS_OPTIONS.find(
      (option) => option.label === interfaceFontLabel,
    )?.value;
    const codeFontValue = FONT_FAMILY_MONO_OPTIONS.find(
      (option) => option.label === codeFontLabel,
    )?.value;
    const transparencyValue = SURFACE_TRANSPARENCY_OPTIONS.find(
      (option) => option.label === "High",
    )?.value;
    const primaryColorValue = PRIMARY_COLOR_OPTIONS.find(
      (option) => option.label === "Teal",
    )?.value;

    await expect.element(page.getByText("Typography", { exact: true })).toBeInTheDocument();
    await page.getByRole("radio", { name: `Use ${interfaceFontLabel} for interface font` }).click();
    await page.getByRole("radio", { name: `Use ${codeFontLabel} for code font` }).click();
    await page.getByRole("button", { name: "Set text size to Large" }).click();
    await page.getByRole("button", { name: "Set corner radius to Square" }).click();
    expect(
      JSON.parse(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY) ?? "{}").primaryColorMode,
    ).toBeUndefined();
    await page.getByText("Use theme", { exact: true }).click();
    await page.getByRole("radio", { name: "Use Teal as primary color" }).click();
    await page.getByRole("button", { name: "Set transparency to High" }).click();

    await vi.waitFor(() => {
      expect(interfaceFontValue).toBeDefined();
      expect(codeFontValue).toBeDefined();
      expect(transparencyValue).toBeDefined();
      expect(primaryColorValue).toBeDefined();
      expect(JSON.parse(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual(
        expect.objectContaining({
          fontFamilySans: interfaceFontValue,
          fontFamilyMono: codeFontValue,
          fontSizeBase: "18px",
          radius: "0rem",
          primaryColorMode: "custom",
          primaryColor: primaryColorValue,
          surfaceTransparency: transparencyValue,
        }),
      );
    });

    const style = document.getElementById(APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID);
    expect(style?.textContent).toContain('--font-family-sans: "Geist"');
    expect(style?.textContent).toContain('--font-family-mono: "Geist Mono"');
    expect(style?.textContent).toContain("--font-size-base: 18px");
    expect(style?.textContent).toContain("--radius: 0rem");
    expect(style?.textContent).toContain(`--primary: ${primaryColorValue}`);
    expect(style?.textContent).toContain("--app-surface-opacity: 82.4%");

    await expect
      .element(page.getByRole("button", { name: "Reset interface font to default" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Reset code font to default" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Reset text size to default" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Reset corner radius to default" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Reset primary color to default" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Reset transparency to default" }))
      .toBeInTheDocument();
  });

  it("toggles and resets wide composer auto-collapse", async () => {
    mounted = await render(<ComposerSettings />);

    const autoCollapseSwitch = page.getByLabelText("Auto-collapse wide composer labels");
    await expect.element(autoCollapseSwitch).toBeChecked();

    await autoCollapseSwitch.click();
    await expect.element(autoCollapseSwitch).not.toBeChecked();
    expect(useUiStateStore.getState().wideComposerControlsAutoCollapse).toBe(false);

    await expect
      .element(page.getByRole("button", { name: "Reset wide composer labels to default" }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Reset wide composer labels to default" }).click();
    await expect.element(autoCollapseSwitch).toBeChecked();
    expect(useUiStateStore.getState().wideComposerControlsAutoCollapse).toBe(true);
  });

  it("omits reasoning and token mode style controls", async () => {
    mounted = await render(<AppearanceSettingsPanel />);

    await expect.element(page.getByText("Panel layout", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Reasoning chip style", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Dots only", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Icon + dots", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Token mode style", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("toggles and resets always use Build mode", async () => {
    mounted = await render(<ComposerSettings />);

    const buildModeSwitch = page.getByLabelText("Always use Build mode", { exact: true });
    await expect.element(buildModeSwitch).toBeChecked();

    await buildModeSwitch.click();
    await expect.element(buildModeSwitch).not.toBeChecked();
    expect(useUiStateStore.getState().alwaysUseBuildMode).toBe(false);

    await expect
      .element(page.getByRole("button", { name: "Reset always use Build mode to default" }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Reset always use Build mode to default" }).click();
    await expect.element(buildModeSwitch).toBeChecked();
    expect(useUiStateStore.getState().alwaysUseBuildMode).toBe(true);
  });
});
