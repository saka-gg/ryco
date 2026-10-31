/**
 * Offline import of VS Code color themes (`*-color-theme.json`) as Ryco themes.
 *
 * Port of T3 Code's `vscodeThemeImport.ts` (#5226, 85b1734d4d): VS Code themes describe editor
 * chrome, carry a few hundred workbench keys, leave most of them unset and use 8-digit hex for
 * overlays. So the editor background is required, the workbench keys that map onto Ryco's
 * tokens are picked in priority order, overlays are flattened onto the surface they sit on, and
 * a foreground is only taken when it stays readable on its surface (WCAG 4.5:1). Unlike T3,
 * Ryco needs no derived palette as the floor: tokens a file does not set fall back to the
 * default theme's variant, whose values are relative to the imported background.
 *
 * Loaded through `import()` when a picked file is not a Ryco theme; never in boot.
 */
import type { ThemeDefinition, ThemeTokenName, ThemeTokens, ThemeVariant } from "./types";

type Rgba = { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
type Rgb = { readonly r: number; readonly g: number; readonly b: number };

const MAX_NAME_LENGTH = 48;
/** How deep `include` chains (a theme built on a base theme) are followed. */
const MAX_INCLUDE_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * VS Code reads theme files as JSONC: `//` and `/* *\/` comments and trailing commas are
 * allowed. Strips them outside strings, then parses as JSON.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\" && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return JSON.parse(withoutTrailingCommas(out));
}

/** Drops a comma before a closing bracket or brace, outside strings (whose text stays as it is). */
function withoutTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') inString = true;
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/u.test(text[next]!)) next += 1;
      if (text[next] === "]" || text[next] === "}") continue;
    }
    out += char;
  }
  return out;
}

function decodeGamma(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeGamma(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** `color(display-p3 r g b / a)` and `color(srgb ...)`; out-of-gamut colors clip to sRGB. */
function parseColorFunction(value: string): Rgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/iu.exec(value);
  if (!match) return null;
  const space = match[1]!.toLowerCase();
  const [channelPart, alphaPart] = match[2]!.split("/");
  const channels = channelPart!
    .trim()
    .split(/\s+/u)
    .map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part)));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  const alphaRaw = alphaPart?.trim();
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith("%")
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);
  if (!Number.isFinite(alpha)) return null;
  const a = Math.max(0, Math.min(1, alpha));
  const [red, green, blue] = channels as [number, number, number];
  if (space === "srgb") return { r: red * 255, g: green * 255, b: blue * 255, a };
  const [lr, lg, lb] = [red, green, blue].map(decodeGamma) as [number, number, number];
  // Display P3 linear -> sRGB linear.
  const [sr, sg, sb] = [
    1.2249401762805 * lr - 0.2249401762805 * lg,
    -0.042056961239 * lr + 1.042056961239 * lg,
    -0.0196375547643 * lr - 0.0786360655012 * lg + 1.0982736202656 * lb,
  ].map((channel) => encodeGamma(channel) * 255) as [number, number, number];
  return { r: sr, g: sg, b: sb, a };
}

/** `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, or a CSS `color()` function. */
export function parseVsCodeColor(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("color(")) return parseColorFunction(trimmed);
  const hex = trimmed.replace(/^#/u, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(hex)) return null;
  const expand = (part: string) =>
    part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
  if (hex.length <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

const channelHex = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");

function toHex(color: Rgb): string {
  return `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`;
}

/** Overlays are semi-transparent in VS Code; Ryco's surfaces are opaque: composite them. */
function flattenOver(color: Rgba, base: Rgb): Rgb {
  if (color.a >= 1) return color;
  return {
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  };
}

function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const isDark = (color: Rgb) => relativeLuminance(color) < 0.179;

/** A VS Code theme is recognised by its dotted workbench keys, which Ryco themes never use. */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasWorkbenchColors =
    isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

/** Extension `name` fields are often package slugs; read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/u.test(trimmed) || !/[-_.]/u.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveName(value: Record<string, unknown>, sourceName: string | undefined): string {
  const stem = sourceName?.replace(/\.[^.]+$/u, "").replace(/-color-theme$/u, "");
  for (const candidate of [value.displayName, value.name, stem]) {
    if (typeof candidate !== "string") continue;
    const humanized = humanizeThemeName(candidate);
    if (humanized.length > 0) return humanized.slice(0, MAX_NAME_LENGTH);
  }
  return "VS Code theme";
}

function resolveVariant(value: Record<string, unknown>, canvas: Rgb): ThemeVariant {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "light" || type === "hc-light") return "light";
  if (type === "dark" || type === "hc-black") return "dark";
  return isDark(canvas) ? "dark" : "light";
}

/** One converted file, before it gets an id; `notices` say what could not be honoured. */
export interface ImportedVsCodeTheme {
  readonly name: string;
  readonly variant: ThemeVariant;
  readonly tokens: ThemeTokens;
  readonly notices: ReadonlyArray<string>;
  /** The file it came from, which names it apart from another file's theme of the same name. */
  readonly sourceName?: string;
}

/** The file name an `include` points at; bases are looked up among the picked files by it. */
function includeBaseName(include: string): string {
  return include.split(/[/\\]/u).at(-1) ?? include;
}

/**
 * The picked files another picked file builds on (`include`, as deep as the import follows it).
 * They supply colors to the themes built on them and are not imported as themes of their own.
 */
export function vsCodeBaseThemeNames(files: ReadonlyMap<string, unknown>): ReadonlySet<string> {
  const bases = new Set<string>();
  for (const value of files.values()) {
    let current = value;
    for (let depth = 0; depth < MAX_INCLUDE_DEPTH; depth += 1) {
      if (!isRecord(current) || typeof current.include !== "string") break;
      const name = includeBaseName(current.include);
      if (!files.has(name) || bases.has(name)) break;
      bases.add(name);
      current = files.get(name);
    }
  }
  return bases;
}

/**
 * The workbench colors of `value`, with an `include` base theme merged under them. A base is
 * found only among the files picked together (`siblings`, by file name); otherwise a notice
 * names the missing base.
 */
function collectColors(
  value: Record<string, unknown>,
  siblings: ReadonlyMap<string, unknown>,
  notices: string[],
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const own = isRecord(value.colors) ? value.colors : {};
  if (typeof value.include !== "string") return own;
  const baseName = includeBaseName(value.include);
  const base = siblings.get(baseName);
  if (base === undefined || !isRecord(base)) {
    notices.push(
      `Its base theme ${baseName} was not picked with it, so only its own colors came in.`,
    );
    return own;
  }
  if (seen.has(baseName)) {
    notices.push(`Its base themes include each other (${baseName}), so that loop was left out.`);
    return own;
  }
  if (depth >= MAX_INCLUDE_DEPTH) {
    notices.push(
      `Its base themes go more than ${MAX_INCLUDE_DEPTH} deep, so ${baseName} and below were left out.`,
    );
    return own;
  }
  return {
    ...collectColors(base, siblings, notices, depth + 1, new Set([...seen, baseName])),
    ...own,
  };
}

export function convertVsCodeTheme(
  value: unknown,
  options: { readonly sourceName?: string; readonly siblings?: ReadonlyMap<string, unknown> } = {},
): ImportedVsCodeTheme {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  const notices: string[] = [];
  const colors = collectColors(value, options.siblings ?? new Map(), notices);

  const pick = (...keys: ReadonlyArray<string>): Rgba | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };
  const solidOver = (base: Rgb, ...keys: ReadonlyArray<string>): Rgb | null => {
    const parsed = pick(...keys);
    return parsed ? flattenOver(parsed, base) : null;
  };

  const canvasColor = pick("editor.background", "editorPane.background");
  if (!canvasColor) {
    throw new Error(
      'That VS Code theme has no "editor.background" color, so there is nothing to build a palette from.',
    );
  }
  const canvas: Rgb = canvasColor;
  const variant = resolveVariant(value, canvas);
  const tokens: Record<ThemeTokenName, string> = { background: toHex(canvas) } as Record<
    ThemeTokenName,
    string
  >;
  const set = (name: ThemeTokenName, color: Rgb | null) => {
    if (color) tokens[name] = toHex(color);
  };

  /** A foreground only when it stays readable (4.5:1) on its surface, else black or white. */
  const readableOn = (surface: Rgb, ...keys: ReadonlyArray<string>): Rgb => {
    const specified = solidOver(surface, ...keys);
    if (specified && contrastRatio(specified, surface) >= 4.5) return specified;
    return isDark(surface) ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  };
  /** A color that must tell itself apart from the background (accents, status colors). */
  const standingApart = (minimum: number, ...keys: ReadonlyArray<string>): Rgb | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (!parsed) continue;
      const solid = flattenOver(parsed, canvas);
      if (contrastRatio(solid, canvas) >= minimum) return solid;
    }
    return null;
  };

  set(
    "app-chrome-background",
    solidOver(canvas, "titleBar.activeBackground", "activityBar.background"),
  );
  set("foreground", readableOn(canvas, "editor.foreground", "foreground"));

  const card = solidOver(canvas, "editorWidget.background");
  if (card) {
    set("card", card);
    set(
      "card-foreground",
      readableOn(card, "editorWidget.foreground", "editor.foreground", "foreground"),
    );
  }
  const popover = solidOver(
    canvas,
    "menu.background",
    "quickInput.background",
    "dropdown.background",
  );
  if (popover) {
    set("popover", popover);
    set(
      "popover-foreground",
      readableOn(
        popover,
        "menu.foreground",
        "quickInput.foreground",
        "dropdown.foreground",
        "editor.foreground",
        "foreground",
      ),
    );
  }

  // Ryco also uses the primary color as text, so a candidate that reads (3:1) wins; one that only
  // stands apart from the background (1.1:1) is the last resort.
  const primaryKeys = [
    "button.background",
    "focusBorder",
    "textLink.foreground",
    "activityBarBadge.background",
    "progressBar.background",
    "badge.background",
  ];
  const primary = standingApart(3, ...primaryKeys) ?? standingApart(1.1, ...primaryKeys);
  if (primary) {
    set("primary", primary);
    set("primary-foreground", readableOn(primary, "button.foreground"));
  }
  const secondary = solidOver(canvas, "button.secondaryBackground");
  if (secondary) {
    set("secondary", secondary);
    set("secondary-foreground", readableOn(secondary, "button.secondaryForeground"));
  }
  set("muted", solidOver(canvas, "input.background"));
  const mutedForeground = solidOver(canvas, "descriptionForeground", "disabledForeground");
  if (mutedForeground && contrastRatio(mutedForeground, canvas) >= 4.5) {
    set("muted-foreground", mutedForeground);
  }
  const accent = solidOver(canvas, "list.hoverBackground");
  if (accent) {
    set("accent", accent);
    set(
      "accent-foreground",
      readableOn(accent, "list.hoverForeground", "editor.foreground", "foreground"),
    );
  }
  // A destructive color that does not read as red-on-background stays the default one.
  set("destructive", standingApart(3, "editorError.foreground", "errorForeground"));
  set("border", solidOver(canvas, "panel.border", "editorGroup.border", "contrastBorder"));
  set("input", solidOver(canvas, "input.border", "dropdown.border"));
  set("ring", standingApart(1.1, "focusBorder"));

  const sidebar = solidOver(canvas, "sideBar.background");
  if (sidebar) {
    set("sidebar", sidebar);
    set("sidebar-foreground", readableOn(sidebar, "sideBar.foreground", "foreground"));
    set("sidebar-border", solidOver(sidebar, "sideBar.border"));
    const selected = solidOver(sidebar, "list.activeSelectionBackground");
    if (selected) {
      set("sidebar-accent", selected);
      set(
        "sidebar-accent-foreground",
        readableOn(selected, "list.activeSelectionForeground", "sideBar.foreground", "foreground"),
      );
    }
  }
  set("info", standingApart(3, "editorInfo.foreground"));
  set("warning", standingApart(3, "editorWarning.foreground"));
  set("success", standingApart(3, "gitDecoration.addedResourceForeground", "terminal.ansiGreen"));

  // Scrollbars keep their alpha: Ryco draws them over whatever scrolls.
  const withAlpha = (color: Rgba | null) =>
    color === null ? null : `${toHex(color)}${color.a >= 1 ? "" : channelHex(color.a * 255)}`;
  const thumb = withAlpha(pick("scrollbarSlider.background"));
  const hover = withAlpha(pick("scrollbarSlider.hoverBackground"));
  if (thumb) {
    tokens["scrollbar-thumb"] = thumb;
    tokens["scrollbar-thumb-thin"] = thumb;
  }
  if (hover) {
    tokens["scrollbar-thumb-hover"] = hover;
    tokens["scrollbar-thumb-thin-hover"] = hover;
  }

  return {
    name: resolveName(value, options.sourceName),
    variant,
    tokens,
    notices,
    ...(options.sourceName !== undefined ? { sourceName: options.sourceName } : {}),
  };
}

/**
 * Extensions ship families of themes. When a light and a dark file whose names differ only by
 * the appearance word are picked together, they become one theme with both variants;
 * everything else stays its own theme. Ambiguous groups (two darks for one light) are not
 * guessed at.
 */
/**
 * Themes of one name picked together (dracula.json and dracula-soft.json both say "Dracula")
 * take their file's name instead, as T3 Code's `resolveThemeLabelCollisions` does, so they stay
 * apart; a name still shared is numbered.
 */
export function relabelVsCodeThemeCollisions(
  themes: ReadonlyArray<ImportedVsCodeTheme>,
): ReadonlyArray<ImportedVsCodeTheme> {
  const counts = new Map<string, number>();
  for (const theme of themes) {
    const key = theme.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const relabelled = themes.map((theme) => {
    if ((counts.get(theme.name.toLowerCase()) ?? 0) < 2 || theme.sourceName === undefined) {
      return theme;
    }
    const fromFile = humanizeThemeName(
      theme.sourceName.replace(/\.[^.]+$/u, "").replace(/-color-theme$/u, ""),
    ).slice(0, MAX_NAME_LENGTH);
    return fromFile.length > 0 && fromFile.toLowerCase() !== theme.name.toLowerCase()
      ? { ...theme, name: fromFile }
      : theme;
  });
  return numberSharedNames(relabelled);
}

/** "Name", "Name 2", "Name 3": a name shared within one import is numbered. */
function numberSharedNames<T extends { readonly name: string }>(entries: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    let name = entry.name;
    for (let suffix = 2; seen.has(name.toLowerCase()) && suffix < 100; suffix += 1) {
      name = `${entry.name.slice(0, MAX_NAME_LENGTH - 4)} ${suffix}`;
    }
    seen.add(name.toLowerCase());
    return name === entry.name ? entry : { ...entry, name };
  });
}

export function pairVsCodeThemes(
  themes: ReadonlyArray<ImportedVsCodeTheme>,
): ReadonlyArray<Omit<ThemeDefinition, "id">> {
  const stripAppearance = (name: string) =>
    name
      .replaceAll(/\b(?:light|dark)\b/giu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim();
  const groups = new Map<string, { light: ImportedVsCodeTheme[]; dark: ImportedVsCodeTheme[] }>();
  for (const theme of themes) {
    const key = stripAppearance(theme.name);
    if (key === theme.name || key.length === 0) continue;
    const group = groups.get(key) ?? { light: [], dark: [] };
    group[theme.variant].push(theme);
    groups.set(key, group);
  }
  const paired = new Map<ImportedVsCodeTheme, string>();
  for (const [key, group] of groups) {
    if (group.light.length === 1 && group.dark.length === 1) {
      paired.set(group.light[0]!, key);
      paired.set(group.dark[0]!, key);
    }
  }
  const out: Array<Omit<ThemeDefinition, "id">> = [];
  const emitted = new Set<string>();
  for (const theme of themes) {
    const key = paired.get(theme);
    if (key === undefined) {
      out.push({ name: theme.name, builtIn: false, [theme.variant]: theme.tokens });
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const group = groups.get(key)!;
    out.push({
      name: key,
      builtIn: false,
      light: group.light[0]!.tokens,
      dark: group.dark[0]!.tokens,
    });
  }
  // A pair's family name can meet a theme of that name picked on its own.
  return numberSharedNames(out);
}
