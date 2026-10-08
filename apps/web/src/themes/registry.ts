import type { CSSProperties } from "react";

import { BUILT_IN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID } from "./builtin";
import {
  THEME_TOKEN_NAMES,
  getTokenKind,
  type ThemeDefinition,
  type ThemeTokenKind,
  type ThemeTokens,
  type ThemeVariant,
} from "./types";

const KNOWN_TOKEN_NAMES = new Set<string>(THEME_TOKEN_NAMES);

export const CUSTOM_THEMES_STORAGE_KEY = "ryco:custom-themes";
export const ACTIVE_THEME_STORAGE_KEY = "ryco:active-theme";
export const THEME_STYLE_ELEMENT_ID = "ryco-active-theme";

export { DEFAULT_THEME, DEFAULT_THEME_ID };

const CUSTOM_ID_PREFIX = "custom-";
const FORBIDDEN_VALUE_PATTERN =
  /(?:javascript:|expression\s*\(|<script|url\s*\(\s*['"]?\s*javascript:)/i;
const GLOBAL_APPEARANCE_TOKEN_NAMES = new Set<string>([
  "font-family-sans",
  "font-family-mono",
  "font-size-base",
  "radius",
]);

export function isBuiltInThemeId(id: string): boolean {
  return BUILT_IN_THEMES.some((theme) => theme.id === id);
}

export function isValidColorValue(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 200) return false;
  return !FORBIDDEN_VALUE_PATTERN.test(trimmed);
}

export const SUPPORTED_LENGTH_UNITS = ["px", "rem", "em"] as const;
export type SupportedLengthUnit = (typeof SUPPORTED_LENGTH_UNITS)[number];

export function parseLength(value: string): { number: number; unit: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(-?\d*\.?\d+)\s*([a-z%]+)$/i.exec(value.trim());
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  return { number: num, unit: match[2].toLowerCase() };
}

export function isValidTokenValue(kind: ThemeTokenKind, value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 200) return false;
  if (FORBIDDEN_VALUE_PATTERN.test(trimmed)) return false;
  switch (kind) {
    case "color":
      return true;
    case "opacity": {
      const num = Number(trimmed);
      return Number.isFinite(num) && num >= 0 && num <= 1;
    }
    case "length":
      return parseLength(trimmed) !== null;
    case "font-family":
      return true;
  }
}

export function generateCustomThemeId(sourceId: string): string {
  const base = sourceId.startsWith(CUSTOM_ID_PREFIX) ? sourceId : `${CUSTOM_ID_PREFIX}${sourceId}`;
  const existing = new Set(getAllThemes().map((theme) => theme.id));
  if (!existing.has(base)) return base;
  let attempt = 2;
  while (existing.has(`${base}-${attempt}`)) attempt += 1;
  return `${base}-${attempt}`;
}

/**
 * Tailwind v4's `--alpha(<color> / <pct>%)` is a build-time function — when emitted into a
 * raw `<style>` tag at runtime it resolves to nothing and tokens like `border` collapse to
 * solid white/black. Convert to the runtime-safe `color-mix(in srgb, <color> <pct>%, transparent)`.
 */
export function materializeTokenValue(value: string): string {
  if (typeof value !== "string" || !value.includes("--alpha(")) return value;
  let out = "";
  let i = 0;
  const marker = "--alpha(";
  while (i < value.length) {
    const start = value.indexOf(marker, i);
    if (start === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);
    let depth = 1;
    let j = start + marker.length;
    while (j < value.length && depth > 0) {
      const ch = value[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      if (depth > 0) j += 1;
    }
    if (depth !== 0) {
      out += value.slice(start);
      break;
    }
    const inner = value.slice(start + marker.length, j).trim();
    const slashIdx = inner.lastIndexOf("/");
    if (slashIdx === -1) {
      out += value.slice(start, j + 1);
    } else {
      const color = inner.slice(0, slashIdx).trim();
      const alpha = inner.slice(slashIdx + 1).trim();
      out += `color-mix(in srgb, ${color} ${alpha}, transparent)`;
    }
    i = j + 1;
  }
  return out;
}

export function materializeTokens(tokens: ThemeTokens): ThemeTokens {
  const next: ThemeTokens = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === "string") {
      (next as Record<string, string>)[key] = materializeTokenValue(value);
    }
  }
  return next;
}

export function duplicateTheme(source: ThemeDefinition): ThemeDefinition {
  const id = generateCustomThemeId(source.id);
  const copy: ThemeDefinition = {
    id,
    name: `${source.name} (Copy)`,
    builtIn: false,
  };
  if (source.description) copy.description = source.description;
  // Forking the default theme yields an empty patch — every token falls back through
  // resolveTokens against the live default. The user only sees swatches for tokens they
  // actually change, and the broken `--alpha(...)` re-emission can't happen.
  if (source.id === DEFAULT_THEME_ID) return copy;
  if (source.light) copy.light = materializeTokens(source.light);
  if (source.dark) copy.dark = materializeTokens(source.dark);
  return copy;
}

export function addCustomTheme(theme: ThemeDefinition): void {
  const themes = getCustomThemes();
  setCustomThemes([...themes, theme]);
}

export function updateCustomTheme(id: string, next: ThemeDefinition): void {
  if (id !== next.id && getAllThemes().some((theme) => theme.id === next.id)) {
    throw new Error(`Theme id "${next.id}" already exists`);
  }
  const themes = getCustomThemes();
  const index = themes.findIndex((theme) => theme.id === id);
  if (index === -1) return;
  const replacement: ThemeDefinition = { ...next, builtIn: false };
  const updated = [...themes.slice(0, index), replacement, ...themes.slice(index + 1)];
  setCustomThemes(updated);
  if (getStoredActiveThemeId() === id && id !== next.id) {
    setActiveThemeId(next.id);
  }
}

export function deleteCustomTheme(id: string): void {
  if (isBuiltInThemeId(id)) return;
  const themes = getCustomThemes().filter((theme) => theme.id !== id);
  setCustomThemes(themes);
  if (getStoredActiveThemeId() === id) {
    setActiveThemeId(DEFAULT_THEME_ID);
    applyThemeToDocument(DEFAULT_THEME);
  }
}

export { isValidTheme };

export function getCustomThemes(): ThemeDefinition[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTheme);
  } catch {
    return [];
  }
}

export function setCustomThemes(themes: ThemeDefinition[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(themes));
}

export function getAllThemes(): ThemeDefinition[] {
  return [...BUILT_IN_THEMES, ...getCustomThemes()];
}

export function findTheme(id: string | null | undefined): ThemeDefinition {
  if (!id) return DEFAULT_THEME;
  return getAllThemes().find((theme) => theme.id === id) ?? DEFAULT_THEME;
}

export function getActiveThemeId(): string {
  const stored = getStoredActiveThemeId();
  return getAllThemes().some((theme) => theme.id === stored) ? stored : DEFAULT_THEME_ID;
}

function getStoredActiveThemeId(): string {
  if (typeof localStorage === "undefined") return DEFAULT_THEME_ID;
  const stored = localStorage.getItem(ACTIVE_THEME_STORAGE_KEY);
  return stored ?? DEFAULT_THEME_ID;
}

export function setActiveThemeId(id: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ACTIVE_THEME_STORAGE_KEY, id);
}

export function resolveTokens(theme: ThemeDefinition, variant: ThemeVariant): ThemeTokens {
  const base = (variant === "dark" ? DEFAULT_THEME.dark : DEFAULT_THEME.light) ?? {};
  const overlay = (variant === "dark" ? theme.dark : theme.light) ?? {};
  return { ...base, ...overlay };
}

/**
 * The theme tokens that may be emitted as custom properties: known, theme-owned
 * names with values that cannot break out of a declaration. Both emitters read
 * this, so a stylesheet and an inline style apply the exact same guards.
 */
function emittableTokenEntries(tokens: ThemeTokens): Array<[name: string, value: string]> {
  return Object.entries(tokens).filter((entry): entry is [string, string] => {
    const [name, value] = entry;
    if (GLOBAL_APPEARANCE_TOKEN_NAMES.has(name)) return false;
    if (!KNOWN_TOKEN_NAMES.has(name)) return false;
    if (typeof value !== "string" || value.length === 0) return false;
    if (value.includes(";") || value.includes("}")) return false;
    const kind = getTokenKind(name);
    if (!kind) return false;
    return isValidTokenValue(kind, value);
  });
}

export function tokensToCss(tokens: ThemeTokens): string {
  return emittableTokenEntries(tokens)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(" ");
}

/**
 * The same tokens as {@link tokensToCss}, as an inline `style` object of custom
 * properties. Lets a subtree pin one variant's tokens (the theme's dark
 * variables only exist on `:root.dark`, so a nested `.dark` class gets none).
 */
export function themeTokensToStyle(tokens: ThemeTokens): CSSProperties {
  const style: Record<`--${string}`, string> = {};
  for (const [name, value] of emittableTokenEntries(tokens)) {
    style[`--${name}`] = value;
  }
  return style as CSSProperties;
}

export function applyThemeToDocument(theme: ThemeDefinition): void {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  if (theme.id === DEFAULT_THEME_ID) {
    removeThemeStyleElement();
    return;
  }

  const style = ensureThemeStyleElement();
  const lightCss = tokensToCss(materializeTokens(resolveTokens(theme, "light")));
  const darkCss = tokensToCss(materializeTokens(resolveTokens(theme, "dark")));
  style.textContent = `:root { ${lightCss} } :root.dark { ${darkCss} }`;
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = document.createElement("style");
  style.id = THEME_STYLE_ELEMENT_ID;
  document.head.append(style);
  return style;
}

function removeThemeStyleElement(): void {
  const existing = document.getElementById(THEME_STYLE_ELEMENT_ID);
  existing?.remove();
}

function isValidTheme(value: unknown): value is ThemeDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return false;
  if (candidate.light !== undefined && !isTokenMap(candidate.light)) return false;
  if (candidate.dark !== undefined && !isTokenMap(candidate.dark)) return false;
  return true;
}

function isTokenMap(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}
