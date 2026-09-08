import { getPresentationTier, subscribeToPresentationTier } from "../lib/presentationTier";

export const APPEARANCE_PREFERENCES_STORAGE_KEY = "ryco:appearance-preferences";
export const APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID = "ryco-appearance-preferences";
export const APPEARANCE_PREFERENCES_CHANGE_EVENT = "ryco:appearance-preferences-change";

export const APPEARANCE_PREFERENCE_KEYS = [
  "fontFamilySans",
  "fontFamilyMono",
  "fontSizeBase",
  "radius",
  "primaryColorMode",
  "primaryColor",
  "surfaceTransparency",
  "motion",
  "dockDensity",
  "diffLayout",
] as const;

export type AppearancePreferenceKey = (typeof APPEARANCE_PREFERENCE_KEYS)[number];

export type AppearancePreferenceOption = {
  value: string;
  label: string;
  description: string;
};

export type AppearancePreferences = Record<AppearancePreferenceKey, string>;

export const FONT_FAMILY_SANS_OPTIONS = [
  {
    value: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    label: "DM Sans",
    description: "Default",
  },
  {
    value: '"Geist", "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    label: "Geist",
    description: "Modern",
  },
  {
    value: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    label: "Inter",
    description: "Neutral",
  },
  {
    value: '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif',
    label: "IBM Plex",
    description: "Technical",
  },
  {
    value: '"Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif',
    label: "Atkinson",
    description: "Readable",
  },
  {
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    label: "System UI",
    description: "Native",
  },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const FONT_FAMILY_MONO_OPTIONS = [
  {
    value: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    label: "SF Mono",
    description: "Default",
  },
  {
    value: '"Geist Mono", "SF Mono", "SFMono-Regular", Consolas, monospace',
    label: "Geist Mono",
    description: "Modern",
  },
  {
    value: '"JetBrains Mono", "SF Mono", "SFMono-Regular", Consolas, monospace',
    label: "JetBrains",
    description: "Editor",
  },
  {
    value: '"Fira Code", "SF Mono", "SFMono-Regular", Consolas, monospace',
    label: "Fira Code",
    description: "Ligatures",
  },
  {
    value: '"IBM Plex Mono", "SF Mono", "SFMono-Regular", Consolas, monospace',
    label: "IBM Plex",
    description: "Technical",
  },
  {
    value: '"Source Code Pro", "SF Mono", "SFMono-Regular", Consolas, monospace',
    label: "Source Code",
    description: "Adobe",
  },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const FONT_SIZE_OPTIONS = [
  { value: "14px", label: "Compact", description: "14 px" },
  { value: "15px", label: "Small", description: "15 px" },
  { value: "16px", label: "Default", description: "16 px" },
  { value: "17px", label: "Roomy", description: "17 px" },
  { value: "18px", label: "Large", description: "18 px" },
  { value: "20px", label: "Display", description: "20 px" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const RADIUS_OPTIONS = [
  { value: "0rem", label: "Square", description: "0 px" },
  { value: "0.375rem", label: "Tight", description: "6 px" },
  { value: "0.625rem", label: "Default", description: "10 px" },
  { value: "0.875rem", label: "Soft", description: "14 px" },
  { value: "1.125rem", label: "Round", description: "18 px" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const SURFACE_TRANSPARENCY_OPTIONS = [
  { value: "default", label: "Solid", description: "0%" },
  { value: "light", label: "Light", description: "8%" },
  { value: "medium", label: "Medium", description: "16%" },
  { value: "high", label: "High", description: "22%" },
  { value: "glass", label: "Glass", description: "28%" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

/**
 * The phone tier's Material control: a three-option subset of
 * {@link SURFACE_TRANSPARENCY_OPTIONS} writing the same `surfaceTransparency`
 * key. There is deliberately no second transparency preference — the phone
 * exposes fewer steps of one axis, not a competing axis.
 */
export const PHONE_MATERIAL_OPTIONS = [
  { value: "default", label: "Solid", description: "Opaque, no blur" },
  { value: "medium", label: "Standard", description: "Single layer" },
  { value: "glass", label: "Glass", description: "Thin material" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

/**
 * The step the phone tier resolves to when no `surfaceTransparency` override is
 * stored. This is a tier **default**, not a floor: an explicit selection is
 * honoured exactly on both tiers, including a deliberate `default` (Solid).
 * `Standard` is the phone default because it is the single-layer path, and a
 * first run on a mid-range device is where a dropped-frame impression costs
 * most.
 */
export const PHONE_DEFAULT_SURFACE_TRANSPARENCY = "medium";

/**
 * The opaque step. `prefers-reduced-transparency` renders every material as
 * though this step were active — enforced in CSS, without changing the stored
 * selection or any emitted variable.
 */
export const SOLID_SURFACE_TRANSPARENCY = "default";

/**
 * The phone dock's density. One key, two explicit choices, honoured exactly —
 * there is deliberately no second scale and no automatic derivation from the
 * type size.
 *
 * Compact reduces the capsule's padding only. The 44 px control floor is a
 * fixed pixel minimum in `MobileDock`, so neither density can shrink a touch
 * target; that is asserted in `MobileDock.browser.tsx` at both densities.
 */
export const DOCK_DENSITY_OPTIONS = [
  { value: "comfortable", label: "Comfortable", description: "Roomier capsule" },
  { value: "compact", label: "Compact", description: "Tighter capsule" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const MOTION_OPTIONS = [
  { value: "system", label: "System", description: "Follow OS" },
  { value: "reduce", label: "Reduced", description: "Minimal" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const PRIMARY_COLOR_MODE_OPTIONS = [
  { value: "theme", label: "Theme", description: "Use palette" },
  { value: "custom", label: "Custom", description: "Override" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const PRIMARY_COLOR_OPTIONS = [
  { value: "#4f46e5", label: "Indigo", description: "Default" },
  { value: "#0ea5e9", label: "Sky", description: "Clear" },
  { value: "#14b8a6", label: "Teal", description: "Calm" },
  { value: "#22c55e", label: "Green", description: "Active" },
  { value: "#f59e0b", label: "Amber", description: "Warm" },
  { value: "#f43f5e", label: "Rose", description: "Bright" },
  { value: "#a855f7", label: "Violet", description: "Sharp" },
] as const satisfies ReadonlyArray<AppearancePreferenceOption>;

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  fontFamilySans: FONT_FAMILY_SANS_OPTIONS[0].value,
  fontFamilyMono: FONT_FAMILY_MONO_OPTIONS[0].value,
  fontSizeBase: "16px",
  radius: "0.625rem",
  primaryColorMode: "theme",
  primaryColor: PRIMARY_COLOR_OPTIONS[0].value,
  surfaceTransparency: "default",
  motion: MOTION_OPTIONS[0].value,
  dockDensity: DOCK_DENSITY_OPTIONS[0].value,
  diffLayout: "stacked",
};

const RADIUS_TOKEN_OFFSETS_PX = {
  sm: -4,
  md: -2,
  lg: 0,
  xl: 4,
  "2xl": 8,
  "3xl": 12,
  "4xl": 16,
} as const;

const OPTION_VALUES: Record<AppearancePreferenceKey, ReadonlySet<string>> = {
  fontFamilySans: new Set(FONT_FAMILY_SANS_OPTIONS.map((option) => option.value)),
  fontFamilyMono: new Set(FONT_FAMILY_MONO_OPTIONS.map((option) => option.value)),
  fontSizeBase: new Set(FONT_SIZE_OPTIONS.map((option) => option.value)),
  radius: new Set(RADIUS_OPTIONS.map((option) => option.value)),
  primaryColorMode: new Set(PRIMARY_COLOR_MODE_OPTIONS.map((option) => option.value)),
  primaryColor: new Set(PRIMARY_COLOR_OPTIONS.map((option) => option.value)),
  surfaceTransparency: new Set(SURFACE_TRANSPARENCY_OPTIONS.map((option) => option.value)),
  motion: new Set(MOTION_OPTIONS.map((option) => option.value)),
  dockDensity: new Set(DOCK_DENSITY_OPTIONS.map((option) => option.value)),
  diffLayout: new Set(["stacked", "split"]),
};

/**
 * Keys whose unstored default depends on the presentation tier. An explicit
 * selection of one of these must persist even when it equals the desktop
 * default, otherwise choosing Solid on a phone would be indistinguishable from
 * "never chose" and would silently resolve back to the phone default.
 */
const TIER_DEPENDENT_DEFAULT_KEYS: ReadonlySet<AppearancePreferenceKey> = new Set([
  "surfaceTransparency",
]);

const SURFACE_TRANSPARENCY_STEPS: Record<string, number> = {
  default: 0,
  light: 0.08,
  medium: 0.16,
  high: 0.22,
  glass: 0.28,
};

export const REDUCED_TRANSPARENCY_MEDIA_QUERY = "(prefers-reduced-transparency: reduce)";
export const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

function matchesMedia(query: string): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches
  );
}

/** Check if localStorage is available in the current environment. */
function hasStorage(): boolean {
  return typeof localStorage !== "undefined";
}

/** Load appearance preference overrides from localStorage and validate each one. */
function parseStoredOverrides(): Partial<AppearancePreferences> {
  if (!hasStorage()) return {};
  const raw = localStorage.getItem(APPEARANCE_PREFERENCES_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const candidate = parsed as Record<string, unknown>;
    const next: Partial<AppearancePreferences> = {};
    for (const key of APPEARANCE_PREFERENCE_KEYS) {
      if (isValidPreferenceValue(key, candidate[key])) {
        const value =
          key === "primaryColor" ? normalizePrimaryColor(candidate[key]) : candidate[key];
        if (typeof value === "string") next[key] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

/** Persist appearance preference overrides to localStorage, clearing storage if no overrides remain. */
function writeStoredOverrides(overrides: Partial<AppearancePreferences>): void {
  if (!hasStorage()) return;
  if (Object.keys(overrides).length === 0) {
    localStorage.removeItem(APPEARANCE_PREFERENCES_STORAGE_KEY);
    return;
  }
  localStorage.setItem(APPEARANCE_PREFERENCES_STORAGE_KEY, JSON.stringify(overrides));
}

export function isValidPreferenceValue(
  key: AppearancePreferenceKey,
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  if (key === "primaryColor") return normalizePrimaryColor(value) !== null;
  return OPTION_VALUES[key].has(value);
}

export function getAppearancePreferences(): AppearancePreferences {
  return { ...DEFAULT_APPEARANCE_PREFERENCES, ...parseStoredOverrides() };
}

export function hasAppearancePreferenceOverride(key: AppearancePreferenceKey): boolean {
  return parseStoredOverrides()[key] !== undefined;
}

/**
 * The `surfaceTransparency` step the user has selected: the stored override, or
 * the tier's unstored default. With no override stored the phone tier resolves
 * to {@link PHONE_DEFAULT_SURFACE_TRANSPARENCY} and the desktop tier keeps the
 * unstored `default`; an explicit selection is never overridden on either tier.
 *
 * `prefers-reduced-transparency` is deliberately **not** applied here. It is
 * enforced in CSS (see the `prefers-reduced-transparency` block in
 * `index.css`), for two reasons: forcing it into this derivation would change
 * the desktop scrim variables that the OS setting never used to touch, and it
 * would make the settings UI display and write a value the user never chose.
 * See {@link isSurfaceTransparencyReducedBySystem}.
 */
export function getEffectiveSurfaceTransparency(): string {
  const stored = parseStoredOverrides().surfaceTransparency;
  if (stored !== undefined) return stored;
  return getPresentationTier() === "phone"
    ? PHONE_DEFAULT_SURFACE_TRANSPARENCY
    : DEFAULT_APPEARANCE_PREFERENCES.surfaceTransparency;
}

/**
 * Whether the OS is currently forcing every translucent surface opaque. The
 * selection is untouched — it is presentation that changes, in CSS — so this
 * exists purely so the settings UI can say so instead of silently displaying
 * {@link SOLID_SURFACE_TRANSPARENCY} as though it were the user's choice.
 */
export function isSurfaceTransparencyReducedBySystem(): boolean {
  return matchesMedia(REDUCED_TRANSPARENCY_MEDIA_QUERY);
}

/** Whether motion is reduced, by the stored preference or by the OS setting. */
export function isReducedMotionEffective(): boolean {
  return getAppearancePreferences().motion === "reduce" || matchesMedia(REDUCED_MOTION_MEDIA_QUERY);
}

/** The stored preferences with the environment-dependent values resolved. */
export function getEffectiveAppearancePreferences(): AppearancePreferences {
  return { ...getAppearancePreferences(), surfaceTransparency: getEffectiveSurfaceTransparency() };
}

export function setAppearancePreference(key: AppearancePreferenceKey, value: string): void {
  if (!isValidPreferenceValue(key, value)) return;
  const normalizedValue = key === "primaryColor" ? normalizePrimaryColor(value) : value;
  if (!normalizedValue) return;
  const overrides = parseStoredOverrides();
  if (
    normalizedValue === DEFAULT_APPEARANCE_PREFERENCES[key] &&
    !TIER_DEPENDENT_DEFAULT_KEYS.has(key)
  ) {
    delete overrides[key];
  } else {
    overrides[key] = normalizedValue;
  }
  writeStoredOverrides(overrides);
}

export function resetAppearancePreference(key: AppearancePreferenceKey): void {
  const overrides = parseStoredOverrides();
  delete overrides[key];
  writeStoredOverrides(overrides);
}

export function applyAppearancePreferencesToDocument(): void {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  const preferences = getEffectiveAppearancePreferences();
  const style = ensureAppearancePreferencesStyleElement();
  style.textContent = `:root { --font-family-sans: ${preferences.fontFamilySans}; --font-family-mono: ${preferences.fontFamilyMono}; --font-size-base: ${preferences.fontSizeBase}; ${buildRadiusCssVariables(preferences.radius)} ${buildSurfaceTransparencyCssVariables(preferences.surfaceTransparency)} ${buildMotionCssVariables(isReducedMotionEffective())} ${buildDockDensityCssVariables(preferences.dockDensity)} }${buildPrimaryColorCssRule(preferences)}`;
  dispatchAppearancePreferencesChangeEvent();
}

/**
 * Republishes the appearance state when an environment input changes, without
 * ever touching a stored value:
 *
 * - the presentation tier, which selects the unstored `surfaceTransparency`
 *   default and therefore changes the emitted variables;
 * - `prefers-reduced-motion`, which collapses the emitted motion durations;
 * - `prefers-reduced-transparency`, which changes no variable at all — it is
 *   enforced in CSS — but must still reach the settings UI so it can report
 *   that a system setting is overriding the selected material.
 *
 * Returns a teardown, and is a no-op outside a browser.
 */
export function syncAppearancePreferenceEnvironment(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const onChange = () => applyAppearancePreferencesToDocument();
  const mediaQueryLists = [REDUCED_TRANSPARENCY_MEDIA_QUERY, REDUCED_MOTION_MEDIA_QUERY].map(
    (query) => window.matchMedia(query),
  );
  for (const mediaQueryList of mediaQueryLists) {
    mediaQueryList.addEventListener("change", onChange);
  }
  const unsubscribeTier = subscribeToPresentationTier(onChange);
  applyAppearancePreferencesToDocument();
  return () => {
    for (const mediaQueryList of mediaQueryLists) {
      mediaQueryList.removeEventListener("change", onChange);
    }
    unsubscribeTier();
  };
}

export function normalizePrimaryColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const shortMatch = /^#?([0-9a-f]{3})$/i.exec(trimmed);
  if (shortMatch?.[1]) {
    return `#${shortMatch[1]
      .split("")
      .map((char) => `${char}${char}`)
      .join("")
      .toLowerCase()}`;
  }
  const longMatch = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  if (!longMatch?.[1]) return null;
  return `#${longMatch[1].toLowerCase()}`;
}

/** Generate CSS variable declarations for all border-radius tokens derived from a base radius. */
function buildRadiusCssVariables(radius: string): string {
  const tokens = Object.entries(RADIUS_TOKEN_OFFSETS_PX)
    .map(
      ([token, offset]) => `--radius-${token}: ${resolveRadiusToken(radius, offset)} !important;`,
    )
    .join(" ");
  return `--radius: ${radius}; ${tokens}`;
}

/** Apply per-token radius offset to compute variant border-radius values (sm/md/lg/xl/2xl/3xl/4xl). */
function resolveRadiusToken(radius: string, offsetPx: number): string {
  if (radius === "0rem") return "0px";
  const baseRem = Number.parseFloat(radius);
  if (!Number.isFinite(baseRem)) return radius;
  const nextPx = Math.max(0, baseRem * 16 + offsetPx);
  return formatRemLength(nextPx / 16);
}

/** Format a number as rem, clamped to 4 decimal places and converted to px if zero. */
function formatRemLength(rem: number): string {
  if (rem === 0) return "0px";
  return `${Number(rem.toFixed(4))}rem`;
}

/**
 * The material tiers of the phone glass system. A tier says *where* a surface
 * sits in the elevation model; the active Material step decides *how* that tier
 * guarantees contrast.
 *
 * `dock` ships with its consumer, the floating dock capsule.
 */
export const GLASS_SURFACE_TIERS = ["sheet", "chip", "dock"] as const;
export type GlassSurfaceTier = (typeof GLASS_SURFACE_TIERS)[number];

/** Backdrop blur radius in px per unit of transparency, so `Solid` blurs by 0. */
const GLASS_TIER_BLUR_SCALE: Record<GlassSurfaceTier, number> = {
  sheet: 100,
  chip: 50,
  dock: 75,
};

/** Backdrop saturation boost in percentage points per unit of transparency. */
const GLASS_TIER_SATURATION_SCALE: Record<GlassSurfaceTier, number> = {
  sheet: 150,
  chip: 115,
  dock: 130,
};

/**
 * Minimum **composited** background coverage, in percent, that a tier must
 * contribute over whatever scrolls beneath it. These are the floors that make
 * the contrast guarantee hold: they are asserted, per tier, per Material step
 * and per colour scheme, in `GlassSurface.browser.tsx`, which composites the
 * resolved colours over the app's worst-case content surfaces and computes the
 * WCAG contrast ratio. Raise a floor rather than the assertion threshold.
 *
 * Each number is the minimum its **own tier's** text roles permit — a tier is
 * never capped by a colour it cannot render — which is why they do not move
 * together:
 *
 * - `sheet` renders destructive row labels, so dark binds hardest (96 %,
 *   `--destructive` at 4.5:1 over the amber status colour); light is set by the
 *   presence text at 3:1 (92 %), which overtook `--muted-foreground` at 4.5:1
 *   when the neutral-graphite palette darkened the worst-case backdrop —
 *   `emerald-600` is only ~3.60:1 opaque, so it has the least headroom to spend
 *   on translucency of any role the sheet can render.
 * - `chip` is the connection pill alone, whose only two text colours are
 *   `--foreground` and `--muted-foreground`. That inverts the schemes: light
 *   binds harder (90 %) because `--muted-foreground` is enforced at 4.5:1
 *   there, while in dark it is exempt to 3:1 (82 %) — see the exemption rule in
 *   `GlassSurface.browser.tsx`.
 * - `dock` is the floating capsule, whose only text is its action labels at the
 *   inherited `--foreground` — no secondary, destructive, or presence colour is
 *   reachable inside it, so `--foreground` at 4.5:1 is the binding role in both
 *   schemes. Derived against the same worst-case backdrops that gives 51 %
 *   light and 60 % dark, both still **below** every Material step's own coverage
 *   (Glass is 72 %), so on the shipped scale the step binds and the floor never
 *   does. It is still recorded and asserted: it is what stops a future step, or
 *   a future palette, from taking the dock below AA. The neutral-graphite
 *   palette moved these up from 34 %/43 % without changing that conclusion —
 *   which is exactly the drift the assertion exists to surface.
 */
const GLASS_TIER_COVERAGE_FLOORS: Record<GlassSurfaceTier, { light: number; dark: number }> = {
  sheet: { light: 92, dark: 96 },
  chip: { light: 90, dark: 82 },
  dock: { light: 51, dark: 60 },
};

/**
 * Share of the guaranteed coverage carried by the material layer itself at a
 * step that applies a scrim. The remainder is contributed by the scrim, so the
 * blurred layer stays genuinely thin while the guaranteed base is unchanged.
 */
const GLASS_MATERIAL_SHARE = 0.75;

/**
 * The only step that composes a scrim beneath the tier's content. `Standard` is
 * a single layer at the coverage floor and `Solid` is opaque, so both leave the
 * scrim at zero.
 */
const SCRIM_SURFACE_TRANSPARENCY_STEPS: ReadonlySet<string> = new Set(["glass"]);

/**
 * Split a tier's guaranteed coverage into the material layer and the scrim
 * layer painted over it, such that `1 - (1 - material)(1 - scrim) = coverage`.
 */
function splitGlassCoverage(
  coverage: number,
  hasScrim: boolean,
): { material: number; scrim: number } {
  if (!hasScrim) return { material: coverage, scrim: 0 };
  const material = coverage * GLASS_MATERIAL_SHARE;
  if (material >= 100) return { material: coverage, scrim: 0 };
  return { material, scrim: ((coverage - material) / (100 - material)) * 100 };
}

/** Generate the per-tier material tokens for one Material step. */
function buildGlassTierVariables(
  tier: GlassSurfaceTier,
  transparency: number,
  surfaceOpacity: number,
  hasScrim: boolean,
): Array<[string, string]> {
  // Emitted as one value rather than as separate blur and saturation tokens so
  // the `Solid` step can resolve to `none`: a `blur(0px)` backdrop filter still
  // forces a backdrop root and an offscreen pass, which is exactly the cost
  // `Solid` exists to avoid.
  const blur = transparency * GLASS_TIER_BLUR_SCALE[tier];
  const saturation = 100 + transparency * GLASS_TIER_SATURATION_SCALE[tier];
  const variables: Array<[string, string]> = [
    [
      `--app-glass-${tier}-filter`,
      blur <= 0 ? "none" : `blur(${formatPx(blur)}) saturate(${formatPercent(saturation)})`,
    ],
  ];
  for (const scheme of ["light", "dark"] as const) {
    const coverage = Math.max(GLASS_TIER_COVERAGE_FLOORS[tier][scheme], surfaceOpacity);
    const { material, scrim } = splitGlassCoverage(coverage, hasScrim);
    variables.push([`--app-glass-${tier}-${scheme}-alpha`, formatPercent(material)]);
    variables.push([`--app-glass-${tier}-${scheme}-scrim-alpha`, formatPercent(scrim)]);
  }
  return variables;
}

/**
 * The desktop material floors. Translucency without a floor produced the
 * text-through-menus failure the Glass step used to ship: a plate may thin as
 * the Material step rises, but it never drops below the alpha that keeps
 * worst-case body text legible over the backdrop the blur produces. Blur
 * scales UP as the plate thins — translucency and blur travel together, never
 * separately.
 */
const DESKTOP_POPOVER_PLATE_FLOOR = { light: 66, dark: 60 } as const;
const DESKTOP_PANEL_PLATE_FLOOR = { light: 76, dark: 70 } as const;
const DESKTOP_SURFACE_PLATE_FLOOR = { light: 80, dark: 76 } as const;

/**
 * Desktop blur radii per Material step. Emitted as complete `filter` values so
 * the Solid step resolves to `none` rather than a zero-radius filter, which
 * would still force a backdrop root (same single-filter-token rule the phone
 * tiers follow).
 */
interface DesktopGlassBlur {
  readonly popover: number;
  readonly panel: number;
  readonly surface: number;
}

const DESKTOP_GLASS_BLUR_SOLID: DesktopGlassBlur = { popover: 0, panel: 0, surface: 0 };

const DESKTOP_GLASS_BLUR_PX: Record<string, DesktopGlassBlur> = {
  default: DESKTOP_GLASS_BLUR_SOLID,
  light: { popover: 14, panel: 10, surface: 8 },
  medium: { popover: 18, panel: 14, surface: 12 },
  high: { popover: 22, panel: 18, surface: 14 },
  glass: { popover: 26, panel: 22, surface: 16 },
};

function desktopGlassFilter(blurPx: number): string {
  if (blurPx <= 0) return "none";
  return `blur(${blurPx}px) saturate(158%)`;
}

/** Generate CSS variables for surface transparency and glass-effect opacity values. */
function buildSurfaceTransparencyCssVariables(surfaceTransparency: string): string {
  const transparency = SURFACE_TRANSPARENCY_STEPS[surfaceTransparency] ?? 0;
  const surfaceOpacity = 100 - transparency * 100;
  const blur = DESKTOP_GLASS_BLUR_PX[surfaceTransparency] ?? DESKTOP_GLASS_BLUR_SOLID;
  const popoverPlate = (scheme: "light" | "dark") =>
    Math.max(DESKTOP_POPOVER_PLATE_FLOOR[scheme], 100 - transparency * 130);
  const panelPlate = (scheme: "light" | "dark") =>
    Math.max(DESKTOP_PANEL_PLATE_FLOOR[scheme], 100 - transparency * 95);
  const surfacePlate = (scheme: "light" | "dark") =>
    Math.max(DESKTOP_SURFACE_PLATE_FLOOR[scheme], 100 - transparency * 80);
  // The composer's glass floor: capped below full opacity even at Solid (it
  // is the surface content scrolls beneath), otherwise tracking the shared
  // surface plate/blur as the Material step rises.
  const composerPlate = (scheme: "light" | "dark") =>
    Math.min(surfacePlate(scheme), scheme === "light" ? 93 : 92);
  const composerBlur = Math.max(10, blur.surface);
  // The toast's glass floor: notifications float over arbitrary content, so
  // like the composer they stay translucent and blurred even at Solid — at
  // popover weight, because they are transient overlays rather than panes.
  // The Solid caps are chosen so muted body text keeps ~AA contrast over a
  // worst-case uniform backdrop; the blur carries the glass read.
  const toastPlate = (scheme: "light" | "dark") =>
    Math.min(popoverPlate(scheme), scheme === "light" ? 92 : 88);
  const toastBlur = Math.max(20, blur.popover);
  return [
    ["--app-surface-opacity", formatPercent(surfacePlate("light"))],
    ["--app-surface-dark-opacity", formatPercent(surfacePlate("dark"))],
    ["--app-surface-filter", desktopGlassFilter(blur.surface)],
    ["--app-composer-alpha", formatPercent(composerPlate("light"))],
    ["--app-composer-dark-alpha", formatPercent(composerPlate("dark"))],
    ["--app-composer-filter", desktopGlassFilter(composerBlur)],
    ["--app-toast-alpha", formatPercent(toastPlate("light"))],
    ["--app-toast-dark-alpha", formatPercent(toastPlate("dark"))],
    ["--app-toast-filter", desktopGlassFilter(toastBlur)],
    ["--app-glass-popover-filter", desktopGlassFilter(blur.popover)],
    ["--app-glass-panel-filter", desktopGlassFilter(blur.panel)],
    ["--app-glass-panel-light-alpha", formatPercent(panelPlate("light"))],
    ["--app-glass-panel-dark-alpha", formatPercent(panelPlate("dark"))],
    ["--app-muted-surface-opacity", formatPercent(100 - transparency * 75)],
    ["--app-dialog-viewport-light-alpha", formatPercent(Math.max(34, 48 - transparency * 50))],
    ["--app-dialog-viewport-dark-alpha", formatPercent(Math.max(16, 28 - transparency * 36))],
    ["--app-sheet-backdrop-alpha", formatPercent(Math.max(18, 32 - transparency * 42))],
    ["--app-command-backdrop-opacity", formatPercent(Math.max(38, 60 - transparency * 60))],
    ["--app-glass-light-start-alpha", formatPercent(transparency * 75)],
    ["--app-glass-light-end-alpha", formatPercent(transparency * 32)],
    ["--app-glass-foreground-alpha", formatPercent(transparency * 18)],
    ["--app-glass-light-popover-alpha", formatPercent(popoverPlate("light"))],
    ["--app-glass-dark-start-alpha", formatPercent(transparency * 18)],
    ["--app-glass-dark-end-alpha", formatPercent(transparency * 5)],
    ["--app-glass-dark-popover-alpha", formatPercent(popoverPlate("dark"))],
    ...GLASS_SURFACE_TIERS.flatMap((tier) =>
      buildGlassTierVariables(
        tier,
        transparency,
        surfaceOpacity,
        SCRIM_SURFACE_TRANSPARENCY_STEPS.has(surfaceTransparency),
      ),
    ),
  ]
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

/**
 * The house motion tokens. Reduced motion collapses every duration to zero, so
 * a transition that consumes them becomes an instantaneous state change; no
 * correctness depends on a transition completing.
 */
function buildMotionCssVariables(reducedMotion: boolean): string {
  const scale = reducedMotion ? 0 : 1;
  return [
    ["--app-motion-ease", "cubic-bezier(0.16, 1, 0.3, 1)"],
    ["--app-motion-duration-sheet", `${200 * scale}ms`],
    ["--app-motion-duration-stack", `${260 * scale}ms`],
    ["--app-motion-duration-chip", `${120 * scale}ms`],
    ["--app-motion-activity-play-state", reducedMotion ? "paused" : "running"],
    // Desktop overlay entrances (popovers, menus, dialogs, toasts). A fourth
    // step rather than reusing `sheet` so overlay pacing can diverge from
    // sheet pacing without a rename sweep. Zeroed under reduced motion like
    // the rest — desktop primitives consume this instead of hardcoding
    // duration-200, which is what previously exempted them from the OS
    // setting entirely.
    ["--app-motion-duration-pop", `${200 * scale}ms`],
  ]
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

/**
 * The dock capsule's padding, in px so it is independent of the type scale.
 * Only the padding moves between densities: `MobileDock` pins every control to
 * a 44 px minimum in px as well, so no density and no text size can shrink a
 * touch target. `index.css` derives `.app-dock-scroll-clearance` from this same
 * variable, so a surface's bottom scroll padding always clears the real dock.
 */
const DOCK_DENSITY_PADDING_PX: Record<string, number> = { comfortable: 8, compact: 4 };

function buildDockDensityCssVariables(dockDensity: string): string {
  const padding = DOCK_DENSITY_PADDING_PX[dockDensity] ?? DOCK_DENSITY_PADDING_PX["comfortable"]!;
  return `--app-dock-padding: ${padding}px;`;
}

/** Generate CSS rule for custom primary color, including the computed foreground color for contrast. */
function buildPrimaryColorCssRule(preferences: AppearancePreferences): string {
  if (preferences.primaryColorMode !== "custom") return "";
  const primaryColor = normalizePrimaryColor(preferences.primaryColor);
  if (!primaryColor) return "";
  const primaryForeground = resolvePrimaryForeground(primaryColor);
  return ` :root, :root.dark { --primary: ${primaryColor}; --ring: ${primaryColor}; --primary-foreground: ${primaryForeground}; }`;
}

/** Determine foreground color (light or dark) for the given hex color using WCAG relative luminance. */
function resolvePrimaryForeground(hex: string): string {
  const normalized = normalizePrimaryColor(hex);
  if (!normalized) return "#ffffff";
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  const srgb = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * srgb[0]! + 0.7152 * srgb[1]! + 0.0722 * srgb[2]!;
  return luminance > 0.46 ? "#0f172a" : "#ffffff";
}

/** Format a number as a percentage string with 2 decimal places. */
function formatPercent(percent: number): string {
  return `${Number(percent.toFixed(2))}%`;
}

/** Format a number as a px length with 2 decimal places. */
function formatPx(px: number): string {
  return `${Number(px.toFixed(2))}px`;
}

/** Get or create the style element where appearance preferences CSS is injected into the document head. */
function ensureAppearancePreferencesStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) {
    document.head.append(existing);
    return existing;
  }
  const style = document.createElement("style");
  style.id = APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID;
  document.head.append(style);
  return style;
}

/** Dispatch a custom event to notify all listeners that appearance preferences have changed. */
function dispatchAppearancePreferencesChangeEvent(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new Event(APPEARANCE_PREFERENCES_CHANGE_EVENT));
}
