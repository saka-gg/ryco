import {
  addCustomTheme,
  applyThemeToDocument,
  getActiveThemePair,
  generateCustomThemeId,
  getAllThemes,
  isBuiltInThemeId,
  isValidTheme,
  setActiveThemeId,
  updateCustomTheme,
} from "./registry";
import type { ThemeDefinition } from "./types";

export const THEME_FILE_EXTENSION = ".rycotheme.json";

const FILENAME_SAFE = /[^a-z0-9-_]+/gi;

export function themeFilename(theme: Pick<ThemeDefinition, "id" | "name">): string {
  const base = (theme.name || theme.id)
    .trim()
    .replace(FILENAME_SAFE, "-")
    .replace(/^-+|-+$/g, "");
  const slug = base.length > 0 ? base : theme.id || "theme";
  return `${slug}${THEME_FILE_EXTENSION}`;
}

export function serializeTheme(theme: ThemeDefinition): string {
  const payload: ThemeDefinition = { id: theme.id, name: theme.name };
  if (theme.description) payload.description = theme.description;
  if (theme.light) payload.light = { ...theme.light };
  if (theme.dark) payload.dark = { ...theme.dark };
  return JSON.stringify(payload, null, 2);
}

export function parseTheme(raw: string): ThemeDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse theme JSON: ${error instanceof Error ? error.message : "invalid JSON"}`,
      { cause: error },
    );
  }
  if (!isValidTheme(parsed)) {
    throw new Error(
      "Theme JSON does not match the schema (need string id/name and string-only light/dark tokens).",
    );
  }
  const next: ThemeDefinition = { id: parsed.id, name: parsed.name, builtIn: false };
  if (parsed.description) next.description = parsed.description;
  if (parsed.light) next.light = { ...parsed.light };
  if (parsed.dark) next.dark = { ...parsed.dark };
  return next;
}

export type ImportCollision = "rename" | "replace";

export type ImportResult = {
  theme: ThemeDefinition;
  action: "added" | "renamed" | "replaced";
};

export function importTheme(raw: string, collision: ImportCollision = "rename"): ImportResult {
  const parsed = parseTheme(raw);
  const all = getAllThemes();
  const existing = all.find((theme) => theme.id === parsed.id);

  if (!existing) {
    addCustomTheme(parsed);
    return { theme: parsed, action: "added" };
  }

  if (isBuiltInThemeId(parsed.id) || collision === "rename") {
    const renamed: ThemeDefinition = { ...parsed, id: generateCustomThemeId(parsed.id) };
    addCustomTheme(renamed);
    return { theme: renamed, action: "renamed" };
  }

  updateCustomTheme(parsed.id, parsed);
  return { theme: parsed, action: "replaced" };
}

const TEXT_ENCODER = typeof TextEncoder === "undefined" ? null : new TextEncoder();
const TEXT_DECODER = typeof TextDecoder === "undefined" ? null : new TextDecoder();

export function encodeThemeToBase64(theme: ThemeDefinition): string {
  const json = serializeTheme(theme);
  if (TEXT_ENCODER && typeof btoa === "function") {
    const bytes = TEXT_ENCODER.encode(json);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  throw new Error("No base64 encoder available in this environment.");
}

export function decodeThemeFromBase64(input: string): ThemeDefinition {
  const trimmed = input.trim();
  let json: string;
  if (TEXT_DECODER && typeof atob === "function") {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    json = TEXT_DECODER.decode(bytes);
  } else {
    throw new Error("No base64 decoder available in this environment.");
  }
  return parseTheme(json);
}

export async function copyThemeToClipboard(theme: ThemeDefinition): Promise<void> {
  const json = serializeTheme(theme);
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    throw new Error("Clipboard API not available in this environment.");
  }
  await navigator.clipboard.writeText(json);
}

/** Saves `text` as a JSON file through the browser's download. */
export function downloadJsonFile(fileName: string, text: string): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  ) {
    throw new Error("Download not supported in this environment.");
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadTheme(theme: ThemeDefinition): void {
  downloadJsonFile(themeFilename(theme), serializeTheme(theme));
}

export type ImportFromFileOptions = {
  collision?: ImportCollision;
  activate?: boolean;
};

export async function importThemeFromFile(
  file: File,
  options: ImportFromFileOptions = {},
): Promise<ImportResult> {
  const text = await file.text();
  const result = importTheme(text, options.collision ?? "rename");
  if (options.activate) {
    setActiveThemeId(result.theme.id);
    const pair = getActiveThemePair();
    applyThemeToDocument(pair.light, pair.dark);
  }
  return result;
}
