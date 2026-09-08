import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { environment } = vi.hoisted(() => ({
  environment: { tier: "desktop" as "desktop" | "phone" },
}));

// The tier is the single presentation classification; stubbing it here keeps
// this unit test free of a DOM media-query implementation while exercising the
// real tier-dependent resolution.
vi.mock("../lib/presentationTier", () => ({
  getPresentationTier: () => environment.tier,
  subscribeToPresentationTier: () => () => {},
}));

import {
  APPEARANCE_PREFERENCES_STORAGE_KEY,
  APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID,
  DEFAULT_APPEARANCE_PREFERENCES,
  PHONE_DEFAULT_SURFACE_TRANSPARENCY,
  PHONE_MATERIAL_OPTIONS,
  PRIMARY_COLOR_OPTIONS,
  SURFACE_TRANSPARENCY_OPTIONS,
  applyAppearancePreferencesToDocument,
  getAppearancePreferences,
  getEffectiveSurfaceTransparency,
  hasAppearancePreferenceOverride,
  isSurfaceTransparencyReducedBySystem,
  normalizePrimaryColor,
  resetAppearancePreference,
  setAppearancePreference,
} from "./appearancePreferences";

/**
 * Stubs the media queries the effective preferences read. Only the queries
 * listed resolve to `true`; everything else resolves to `false`.
 */
function installMatchMedia(matching: ReadonlyArray<string>) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: (query: string) => ({ matches: matching.includes(query) }) },
  });
}

function uninstallMatchMedia() {
  Reflect.deleteProperty(globalThis, "window");
}

class FakeStyle {
  id = "";
  textContent = "";
}

/** Installs a minimal document so the injected style element can be inspected. */
function installStyleDocument(): { read: () => string } {
  const appended: FakeStyle[] = [];
  Object.defineProperty(globalThis, "HTMLStyleElement", { configurable: true, value: FakeStyle });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: (id: string) => appended.find((node) => node.id === id) ?? null,
      createElement: () => new FakeStyle(),
      head: {
        append: (node: FakeStyle) => {
          const existingIndex = appended.indexOf(node);
          if (existingIndex >= 0) appended.splice(existingIndex, 1);
          appended.push(node);
        },
      },
    },
  });
  return {
    read: () =>
      appended.find((node) => node.id === APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID)?.textContent ??
      "",
  };
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function installLocalStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
}

function uninstallLocalStorage() {
  Reflect.deleteProperty(globalThis, "localStorage");
}

describe("appearance preferences", () => {
  beforeEach(() => {
    installLocalStorage();
    environment.tier = "desktop";
  });

  afterEach(() => {
    uninstallLocalStorage();
    uninstallMatchMedia();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLStyleElement");
  });

  it("persists and validates the diff layout independently of theme colors", () => {
    expect(getAppearancePreferences().diffLayout).toBe("stacked");
    setAppearancePreference("diffLayout", "split");
    expect(getAppearancePreferences().diffLayout).toBe("split");
    expect(hasAppearancePreferenceOverride("diffLayout")).toBe(true);
    localStorage.setItem(
      APPEARANCE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ diffLayout: "invalid" }),
    );
    expect(getAppearancePreferences().diffLayout).toBe("stacked");
    setAppearancePreference("diffLayout", "split");
    resetAppearancePreference("diffLayout");
    expect(getAppearancePreferences().diffLayout).toBe("stacked");
  });

  it("returns defaults when no overrides are stored", () => {
    expect(getAppearancePreferences()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(hasAppearancePreferenceOverride("fontFamilySans")).toBe(false);
    expect(hasAppearancePreferenceOverride("fontFamilyMono")).toBe(false);
    expect(hasAppearancePreferenceOverride("fontSizeBase")).toBe(false);
    expect(hasAppearancePreferenceOverride("radius")).toBe(false);
    expect(hasAppearancePreferenceOverride("primaryColorMode")).toBe(false);
    expect(hasAppearancePreferenceOverride("primaryColor")).toBe(false);
    expect(hasAppearancePreferenceOverride("surfaceTransparency")).toBe(false);
  });

  it("persists only non-default values and removes defaults", () => {
    setAppearancePreference("fontSizeBase", "18px");
    expect(getAppearancePreferences().fontSizeBase).toBe("18px");
    expect(hasAppearancePreferenceOverride("fontSizeBase")).toBe(true);
    expect(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY)).toContain("18px");

    setAppearancePreference("fontSizeBase", DEFAULT_APPEARANCE_PREFERENCES.fontSizeBase);
    expect(getAppearancePreferences().fontSizeBase).toBe(
      DEFAULT_APPEARANCE_PREFERENCES.fontSizeBase,
    );
    expect(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it("ignores invalid stored values and invalid writes", () => {
    localStorage.setItem(
      APPEARANCE_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        fontFamilySans: "Comic Sans MS",
        fontFamilyMono: "Papyrus",
        fontSizeBase: "500px",
        radius: "url(javascript:alert(1))",
        primaryColorMode: "always",
        primaryColor: "url(javascript:alert(1))",
        surfaceTransparency: "invisible",
      }),
    );
    expect(getAppearancePreferences()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);

    setAppearancePreference("fontFamilySans", "serif");
    setAppearancePreference("radius", "999rem");
    setAppearancePreference("primaryColorMode", "always");
    setAppearancePreference("primaryColor", "not-a-color");
    setAppearancePreference("surfaceTransparency", "opaque");
    expect(getAppearancePreferences().fontFamilySans).toBe(
      DEFAULT_APPEARANCE_PREFERENCES.fontFamilySans,
    );
    expect(getAppearancePreferences().radius).toBe(DEFAULT_APPEARANCE_PREFERENCES.radius);
    expect(getAppearancePreferences().primaryColorMode).toBe(
      DEFAULT_APPEARANCE_PREFERENCES.primaryColorMode,
    );
    expect(getAppearancePreferences().primaryColor).toBe(
      DEFAULT_APPEARANCE_PREFERENCES.primaryColor,
    );
    expect(getAppearancePreferences().surfaceTransparency).toBe(
      DEFAULT_APPEARANCE_PREFERENCES.surfaceTransparency,
    );
  });

  it("normalizes custom primary colors", () => {
    expect(normalizePrimaryColor("#ABC")).toBe("#aabbcc");
    expect(normalizePrimaryColor("0EA5E9")).toBe("#0ea5e9");
    expect(normalizePrimaryColor("transparent")).toBeNull();
  });

  it("resets a single preference without touching the other", () => {
    setAppearancePreference(
      "fontFamilySans",
      '"Geist", "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    );
    setAppearancePreference("fontSizeBase", "18px");
    setAppearancePreference("radius", "0rem");
    setAppearancePreference("surfaceTransparency", "high");

    resetAppearancePreference("radius");

    expect(getAppearancePreferences()).toEqual({
      ...DEFAULT_APPEARANCE_PREFERENCES,
      fontFamilySans:
        '"Geist", "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSizeBase: "18px",
      surfaceTransparency: "high",
    });
  });

  it("applies preferences through a dedicated style tag", () => {
    const style = installStyleDocument();

    setAppearancePreference("fontSizeBase", "18px");
    setAppearancePreference("radius", "0rem");
    setAppearancePreference("primaryColorMode", "custom");
    setAppearancePreference("primaryColor", "#0EA5E9");
    setAppearancePreference("surfaceTransparency", "high");
    applyAppearancePreferencesToDocument();

    const css = style.read();
    expect(css).toContain(
      '--font-family-sans: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
    );
    expect(css).toContain(
      '--font-family-mono: "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;',
    );
    expect(css).toContain("--radius: 0rem;");
    expect(css).toContain("--radius-sm: 0px !important;");
    expect(css).toContain("--radius-4xl: 0px !important;");
    expect(css).toContain("--font-size-base: 18px;");
    expect(css).toContain(
      ":root, :root.dark { --primary: #0ea5e9; --ring: #0ea5e9; --primary-foreground: #ffffff; }",
    );
    expect(css).toContain("--app-surface-opacity: 82.4%;");
    expect(css).toContain("--app-glass-light-popover-alpha: 71.4%;");
    expect(css).toContain("--app-dialog-viewport-light-alpha: 37%;");
  });

  it("keeps floating surfaces solid at the default transparency setting", () => {
    const style = installStyleDocument();

    applyAppearancePreferencesToDocument();

    const css = style.read();
    expect(css).toContain("--app-surface-opacity: 100%;");
    expect(css).not.toContain(`--primary: ${PRIMARY_COLOR_OPTIONS[0].value};`);
    expect(css).toContain("--app-muted-surface-opacity: 100%;");
    expect(css).toContain("--app-glass-light-start-alpha: 0%;");
    expect(css).toContain("--app-glass-light-popover-alpha: 100%;");
    expect(css).toContain("--app-glass-dark-popover-alpha: 100%;");
  });
});

describe("phone Material step resolution", () => {
  beforeEach(() => {
    installLocalStorage();
    environment.tier = "desktop";
  });

  afterEach(() => {
    uninstallLocalStorage();
    uninstallMatchMedia();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLStyleElement");
  });

  it("exposes a three-option subset of the one transparency scale", () => {
    const scale = new Set(SURFACE_TRANSPARENCY_OPTIONS.map((option) => option.value));
    expect(PHONE_MATERIAL_OPTIONS).toHaveLength(3);
    for (const option of PHONE_MATERIAL_OPTIONS) {
      expect(scale.has(option.value)).toBe(true);
    }
    expect(PHONE_MATERIAL_OPTIONS.map((option) => option.value)).toEqual([
      "default",
      "medium",
      "glass",
    ]);
  });

  it("defaults to Standard on the phone tier and Solid on desktop when nothing is stored", () => {
    expect(getEffectiveSurfaceTransparency()).toBe(
      DEFAULT_APPEARANCE_PREFERENCES.surfaceTransparency,
    );

    environment.tier = "phone";
    expect(getEffectiveSurfaceTransparency()).toBe(PHONE_DEFAULT_SURFACE_TRANSPARENCY);
    // A tier default, not a stored value.
    expect(hasAppearancePreferenceOverride("surfaceTransparency")).toBe(false);
    expect(getAppearancePreferences().surfaceTransparency).toBe(
      DEFAULT_APPEARANCE_PREFERENCES.surfaceTransparency,
    );
  });

  it("honours an explicit selection exactly on both tiers, including Solid on a phone", () => {
    // Solid equals the desktop default, so it would be indistinguishable from
    // "never chose" if it were not persisted.
    environment.tier = "phone";
    setAppearancePreference("surfaceTransparency", "default");
    expect(hasAppearancePreferenceOverride("surfaceTransparency")).toBe(true);
    expect(getEffectiveSurfaceTransparency()).toBe("default");

    setAppearancePreference("surfaceTransparency", "glass");
    expect(getEffectiveSurfaceTransparency()).toBe("glass");
    environment.tier = "desktop";
    expect(getEffectiveSurfaceTransparency()).toBe("glass");

    // Resetting returns each tier to its own unstored default.
    resetAppearancePreference("surfaceTransparency");
    expect(getEffectiveSurfaceTransparency()).toBe("default");
    environment.tier = "phone";
    expect(getEffectiveSurfaceTransparency()).toBe(PHONE_DEFAULT_SURFACE_TRANSPARENCY);
  });

  it("reports prefers-reduced-transparency without folding it into the selection", () => {
    environment.tier = "phone";
    setAppearancePreference("surfaceTransparency", "glass");
    installMatchMedia(["(prefers-reduced-transparency: reduce)"]);

    // The OS setting is enforced in CSS, so the selection is untouched: the
    // settings UI reads the real choice and therefore cannot write the forced
    // step back over it, and the desktop scrim variables do not move.
    expect(isSurfaceTransparencyReducedBySystem()).toBe(true);
    expect(getEffectiveSurfaceTransparency()).toBe("glass");
    const style = installStyleDocument();
    applyAppearancePreferencesToDocument();
    expect(style.read()).toContain("--app-surface-opacity: 80%;");

    expect(getAppearancePreferences().surfaceTransparency).toBe("glass");
    expect(JSON.parse(localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual(
      expect.objectContaining({ surfaceTransparency: "glass" }),
    );
    uninstallMatchMedia();
    expect(isSurfaceTransparencyReducedBySystem()).toBe(false);
    expect(getEffectiveSurfaceTransparency()).toBe("glass");
  });

  it("emits the phone tier's unstored default into the document variables", () => {
    environment.tier = "phone";
    const style = installStyleDocument();
    applyAppearancePreferencesToDocument();
    // The `medium` step: 87.2% surface opacity, and the sheet tier at its floor.
    expect(style.read()).toContain("--app-surface-opacity: 87.2%;");
    expect(style.read()).toContain("--app-glass-sheet-dark-alpha: 96%;");
    expect(style.read()).toContain("--app-glass-sheet-dark-scrim-alpha: 0%;");
  });
});

describe("material and motion tokens", () => {
  beforeEach(() => {
    installLocalStorage();
    environment.tier = "desktop";
  });

  afterEach(() => {
    uninstallLocalStorage();
    uninstallMatchMedia();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLStyleElement");
  });

  it("keeps both tiers opaque and unblurred at the Solid step", () => {
    const style = installStyleDocument();
    applyAppearancePreferencesToDocument();
    const css = style.read();
    for (const tier of ["sheet", "chip"]) {
      // `none`, not a zero-radius filter: `Solid` must not force a backdrop root.
      expect(css).toContain(`--app-glass-${tier}-filter: none;`);
      expect(css).toContain(`--app-glass-${tier}-light-alpha: 100%;`);
      expect(css).toContain(`--app-glass-${tier}-dark-alpha: 100%;`);
      expect(css).toContain(`--app-glass-${tier}-light-scrim-alpha: 0%;`);
      expect(css).toContain(`--app-glass-${tier}-dark-scrim-alpha: 0%;`);
    }
  });

  it("splits the Glass step into a thin material plus a scrim that restores the coverage", () => {
    setAppearancePreference("surfaceTransparency", "glass");
    const style = installStyleDocument();
    applyAppearancePreferencesToDocument();
    const css = style.read();

    expect(css).toContain("--app-glass-sheet-filter: blur(28px) saturate(142%);");
    expect(css).toContain("--app-glass-chip-filter: blur(14px) saturate(132.2%);");

    // The composite of the material and the scrim is the tier's guaranteed
    // coverage; `GlassSurface.browser.tsx` proves that coverage clears AA.
    const readPercent = (name: string) => {
      const match = new RegExp(`${name}: ([\\d.]+)%;`).exec(css);
      expect(match, `missing ${name}`).not.toBeNull();
      return Number.parseFloat(match![1]!) / 100;
    };
    const coverage = (tier: string, scheme: string) =>
      1 -
      (1 - readPercent(`--app-glass-${tier}-${scheme}-alpha`)) *
        (1 - readPercent(`--app-glass-${tier}-${scheme}-scrim-alpha`));
    // Both tiers are held to their own contrast floors, which at this step are
    // what binds rather than the step's own 72%. They differ per tier because
    // they are derived per tier from the roles that tier can render.
    expect(coverage("sheet", "light")).toBeCloseTo(0.92, 4);
    expect(coverage("sheet", "dark")).toBeCloseTo(0.96, 4);
    expect(coverage("chip", "light")).toBeCloseTo(0.9, 4);
    expect(coverage("chip", "dark")).toBeCloseTo(0.82, 4);
    // The material layer itself is genuinely thinner than the coverage.
    expect(readPercent("--app-glass-sheet-dark-alpha")).toBeLessThan(0.96);
  });

  it("collapses the motion durations for the preference and for the OS setting", () => {
    const style = installStyleDocument();
    applyAppearancePreferencesToDocument();
    expect(style.read()).toContain("--app-motion-ease: cubic-bezier(0.16, 1, 0.3, 1);");
    expect(style.read()).toContain("--app-motion-duration-sheet: 200ms;");
    expect(style.read()).toContain("--app-motion-duration-stack: 260ms;");
    expect(style.read()).toContain("--app-motion-duration-chip: 120ms;");
    expect(style.read()).toContain("--app-motion-activity-play-state: running;");

    setAppearancePreference("motion", "reduce");
    applyAppearancePreferencesToDocument();
    expect(style.read()).toContain("--app-motion-duration-sheet: 0ms;");
    expect(style.read()).toContain("--app-motion-duration-stack: 0ms;");
    expect(style.read()).toContain("--app-motion-duration-chip: 0ms;");
    expect(style.read()).toContain("--app-motion-activity-play-state: paused;");

    resetAppearancePreference("motion");
    installMatchMedia(["(prefers-reduced-motion: reduce)"]);
    applyAppearancePreferencesToDocument();
    expect(style.read()).toContain("--app-motion-duration-sheet: 0ms;");
    expect(style.read()).toContain("--app-motion-activity-play-state: paused;");
  });
});

/**
 * The desktop tier must not move. This pins the five options, the unstored
 * desktop default, and the exact value of every `--app-*` variable that existed
 * before the phone material system, at every step.
 */
describe("desktop appearance regression", () => {
  const EXISTING_SURFACE_VARIABLES: Record<string, ReadonlyArray<string>> = {
    default: [
      "--app-surface-opacity: 100%;",
      "--app-surface-dark-opacity: 100%;",
      "--app-surface-filter: none;",
      "--app-composer-alpha: 93%;",
      "--app-composer-dark-alpha: 92%;",
      "--app-composer-filter: blur(10px) saturate(158%);",
      "--app-glass-popover-filter: none;",
      "--app-glass-panel-filter: none;",
      "--app-glass-panel-light-alpha: 100%;",
      "--app-glass-panel-dark-alpha: 100%;",
      "--app-muted-surface-opacity: 100%;",
      "--app-dialog-viewport-light-alpha: 48%;",
      "--app-dialog-viewport-dark-alpha: 28%;",
      "--app-sheet-backdrop-alpha: 32%;",
      "--app-command-backdrop-opacity: 60%;",
      "--app-glass-light-start-alpha: 0%;",
      "--app-glass-light-end-alpha: 0%;",
      "--app-glass-foreground-alpha: 0%;",
      "--app-glass-light-popover-alpha: 100%;",
      "--app-glass-dark-start-alpha: 0%;",
      "--app-glass-dark-end-alpha: 0%;",
      "--app-glass-dark-popover-alpha: 100%;",
    ],
    light: [
      "--app-surface-opacity: 93.6%;",
      "--app-surface-dark-opacity: 93.6%;",
      "--app-surface-filter: blur(8px) saturate(158%);",
      "--app-composer-alpha: 93%;",
      "--app-composer-dark-alpha: 92%;",
      "--app-composer-filter: blur(10px) saturate(158%);",
      "--app-glass-popover-filter: blur(14px) saturate(158%);",
      "--app-glass-panel-filter: blur(10px) saturate(158%);",
      "--app-glass-panel-light-alpha: 92.4%;",
      "--app-glass-panel-dark-alpha: 92.4%;",
      "--app-muted-surface-opacity: 94%;",
      "--app-dialog-viewport-light-alpha: 44%;",
      "--app-dialog-viewport-dark-alpha: 25.12%;",
      "--app-sheet-backdrop-alpha: 28.64%;",
      "--app-command-backdrop-opacity: 55.2%;",
      "--app-glass-light-start-alpha: 6%;",
      "--app-glass-light-end-alpha: 2.56%;",
      "--app-glass-foreground-alpha: 1.44%;",
      "--app-glass-light-popover-alpha: 89.6%;",
      "--app-glass-dark-start-alpha: 1.44%;",
      "--app-glass-dark-end-alpha: 0.4%;",
      "--app-glass-dark-popover-alpha: 89.6%;",
    ],
    medium: [
      "--app-surface-opacity: 87.2%;",
      "--app-surface-dark-opacity: 87.2%;",
      "--app-surface-filter: blur(12px) saturate(158%);",
      "--app-composer-alpha: 87.2%;",
      "--app-composer-dark-alpha: 87.2%;",
      "--app-composer-filter: blur(12px) saturate(158%);",
      "--app-glass-popover-filter: blur(18px) saturate(158%);",
      "--app-glass-panel-filter: blur(14px) saturate(158%);",
      "--app-glass-panel-light-alpha: 84.8%;",
      "--app-glass-panel-dark-alpha: 84.8%;",
      "--app-muted-surface-opacity: 88%;",
      "--app-dialog-viewport-light-alpha: 40%;",
      "--app-dialog-viewport-dark-alpha: 22.24%;",
      "--app-sheet-backdrop-alpha: 25.28%;",
      "--app-command-backdrop-opacity: 50.4%;",
      "--app-glass-light-start-alpha: 12%;",
      "--app-glass-light-end-alpha: 5.12%;",
      "--app-glass-foreground-alpha: 2.88%;",
      "--app-glass-light-popover-alpha: 79.2%;",
      "--app-glass-dark-start-alpha: 2.88%;",
      "--app-glass-dark-end-alpha: 0.8%;",
      "--app-glass-dark-popover-alpha: 79.2%;",
    ],
    high: [
      "--app-surface-opacity: 82.4%;",
      "--app-surface-dark-opacity: 82.4%;",
      "--app-surface-filter: blur(14px) saturate(158%);",
      "--app-composer-alpha: 82.4%;",
      "--app-composer-dark-alpha: 82.4%;",
      "--app-composer-filter: blur(14px) saturate(158%);",
      "--app-glass-popover-filter: blur(22px) saturate(158%);",
      "--app-glass-panel-filter: blur(18px) saturate(158%);",
      "--app-glass-panel-light-alpha: 79.1%;",
      "--app-glass-panel-dark-alpha: 79.1%;",
      "--app-muted-surface-opacity: 83.5%;",
      "--app-dialog-viewport-light-alpha: 37%;",
      "--app-dialog-viewport-dark-alpha: 20.08%;",
      "--app-sheet-backdrop-alpha: 22.76%;",
      "--app-command-backdrop-opacity: 46.8%;",
      "--app-glass-light-start-alpha: 16.5%;",
      "--app-glass-light-end-alpha: 7.04%;",
      "--app-glass-foreground-alpha: 3.96%;",
      "--app-glass-light-popover-alpha: 71.4%;",
      "--app-glass-dark-start-alpha: 3.96%;",
      "--app-glass-dark-end-alpha: 1.1%;",
      "--app-glass-dark-popover-alpha: 71.4%;",
    ],
    glass: [
      "--app-surface-opacity: 80%;",
      "--app-surface-dark-opacity: 77.6%;",
      "--app-surface-filter: blur(16px) saturate(158%);",
      "--app-composer-alpha: 80%;",
      "--app-composer-dark-alpha: 77.6%;",
      "--app-composer-filter: blur(16px) saturate(158%);",
      "--app-glass-popover-filter: blur(26px) saturate(158%);",
      "--app-glass-panel-filter: blur(22px) saturate(158%);",
      "--app-glass-panel-light-alpha: 76%;",
      "--app-glass-panel-dark-alpha: 73.4%;",
      "--app-muted-surface-opacity: 79%;",
      "--app-dialog-viewport-light-alpha: 34%;",
      "--app-dialog-viewport-dark-alpha: 17.92%;",
      "--app-sheet-backdrop-alpha: 20.24%;",
      "--app-command-backdrop-opacity: 43.2%;",
      "--app-glass-light-start-alpha: 21%;",
      "--app-glass-light-end-alpha: 8.96%;",
      "--app-glass-foreground-alpha: 5.04%;",
      "--app-glass-light-popover-alpha: 66%;",
      "--app-glass-dark-start-alpha: 5.04%;",
      "--app-glass-dark-end-alpha: 1.4%;",
      "--app-glass-dark-popover-alpha: 63.6%;",
    ],
  };

  beforeEach(() => {
    installLocalStorage();
    environment.tier = "desktop";
  });

  afterEach(() => {
    uninstallLocalStorage();
    uninstallMatchMedia();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLStyleElement");
  });

  it("keeps the five desktop options and the unstored desktop default", () => {
    expect(SURFACE_TRANSPARENCY_OPTIONS.map((option) => option.value)).toEqual([
      "default",
      "light",
      "medium",
      "high",
      "glass",
    ]);
    expect(SURFACE_TRANSPARENCY_OPTIONS.map((option) => option.label)).toEqual([
      "Solid",
      "Light",
      "Medium",
      "High",
      "Glass",
    ]);
    expect(DEFAULT_APPEARANCE_PREFERENCES.surfaceTransparency).toBe("default");
    expect(getEffectiveSurfaceTransparency()).toBe("default");
  });

  it("keeps every pre-existing --app-* value at every step", () => {
    for (const [step, expected] of Object.entries(EXISTING_SURFACE_VARIABLES)) {
      const style = installStyleDocument();
      setAppearancePreference("surfaceTransparency", step);
      applyAppearancePreferencesToDocument();
      const css = style.read();
      for (const declaration of expected) {
        expect(css, `step "${step}"`).toContain(declaration);
      }
    }
  });

  it("keeps every pre-existing --app-* value under prefers-reduced-transparency too", () => {
    // The OS setting is enforced in CSS, not in this derivation. If it were
    // folded in here it would silently move the desktop dialog, sheet and
    // command scrims — which the pre-existing reduced-transparency CSS block
    // never touched — at every step other than Solid.
    installMatchMedia(["(prefers-reduced-transparency: reduce)"]);
    for (const [step, expected] of Object.entries(EXISTING_SURFACE_VARIABLES)) {
      const style = installStyleDocument();
      setAppearancePreference("surfaceTransparency", step);
      applyAppearancePreferencesToDocument();
      const css = style.read();
      for (const declaration of expected) {
        expect(css, `step "${step}" under reduced transparency`).toContain(declaration);
      }
    }
  });

  it("pins the toast material floor at every step", () => {
    // Like the composer, the toast keeps translucent, blurred material even at
    // Solid; steps above Solid thin with the popover plate under the same
    // legibility floors. The OS reduced-transparency override lives in CSS.
    const TOAST_SURFACE_VARIABLES: Record<string, ReadonlyArray<string>> = {
      default: [
        "--app-toast-alpha: 92%;",
        "--app-toast-dark-alpha: 88%;",
        "--app-toast-filter: blur(20px) saturate(158%);",
      ],
      light: [
        "--app-toast-alpha: 89.6%;",
        "--app-toast-dark-alpha: 88%;",
        "--app-toast-filter: blur(20px) saturate(158%);",
      ],
      medium: [
        "--app-toast-alpha: 79.2%;",
        "--app-toast-dark-alpha: 79.2%;",
        "--app-toast-filter: blur(20px) saturate(158%);",
      ],
      high: [
        "--app-toast-alpha: 71.4%;",
        "--app-toast-dark-alpha: 71.4%;",
        "--app-toast-filter: blur(22px) saturate(158%);",
      ],
      glass: [
        "--app-toast-alpha: 66%;",
        "--app-toast-dark-alpha: 63.6%;",
        "--app-toast-filter: blur(26px) saturate(158%);",
      ],
    };
    for (const [step, expected] of Object.entries(TOAST_SURFACE_VARIABLES)) {
      const style = installStyleDocument();
      setAppearancePreference("surfaceTransparency", step);
      applyAppearancePreferencesToDocument();
      const css = style.read();
      for (const declaration of expected) {
        expect(css, `step "${step}"`).toContain(declaration);
      }
    }
  });
});
