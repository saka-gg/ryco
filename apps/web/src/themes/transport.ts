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
  return importThemeDefinition(parseTheme(raw), collision);
}

/** Adds `parsed` as a custom theme, renaming or replacing on an id that already exists. */
export function importThemeDefinition(
  parsed: ThemeDefinition,
  collision: ImportCollision = "rename",
): ImportResult {
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
  const { imported } = await importThemesFromFiles([file], options);
  return imported[0]!;
}

/** Theme files are read whole; a larger file is refused before it is read (T3's cap). */
export const MAX_THEME_FILE_BYTES = 256 * 1024;
/** At most this many files in one import. */
export const MAX_THEME_FILES = 16;

export interface ThemeFilesImport {
  readonly imported: ReadonlyArray<ImportResult>;
  /** What could not be honoured, for the toast (a VS Code base theme that was not picked). */
  readonly notices: ReadonlyArray<string>;
}

const themeIdFromName = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "") || "theme";

/**
 * Imports Ryco theme files and VS Code color themes (JSONC, `*-color-theme.json`) picked
 * together. VS Code files load their converter on demand; a light and a dark file of one
 * family become one theme. With `activate`, the last import becomes the active theme.
 */
export async function importThemesFromFiles(
  files: ReadonlyArray<File>,
  options: ImportFromFileOptions = {},
): Promise<ThemeFilesImport> {
  if (files.length === 0) return { imported: [], notices: [] };
  if (files.length > MAX_THEME_FILES) {
    throw new Error(`Pick at most ${MAX_THEME_FILES} theme files at once.`);
  }
  for (const file of files) {
    if (file.size > MAX_THEME_FILE_BYTES) {
      throw new Error(`${file.name} is larger than 256 KiB, which no theme file needs.`);
    }
  }
  const texts = await Promise.all(files.map((file) => file.text()));
  const collision = options.collision ?? "rename";
  const rycoThemes: ThemeDefinition[] = [];
  const others: Array<{ readonly name: string; readonly text: string }> = [];
  texts.forEach((text, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isValidTheme(parsed)) rycoThemes.push(parseTheme(text));
    else others.push({ name: files[index]!.name, text });
  });

  const notices: string[] = [];
  const converted: ThemeDefinition[] = [];
  if (others.length > 0) {
    const vscode = await import("./vscodeThemeImport");
    const values = others.map((file) => {
      try {
        return { name: file.name, value: vscode.parseJsonc(file.text) };
      } catch {
        throw new Error(`${file.name} is not valid JSON or JSONC.`);
      }
    });
    const siblings = new Map(values.map((file) => [file.name, file.value]));
    const themes = values.map((file) => {
      if (!vscode.isVsCodeThemeFile(file.value)) {
        throw new Error(`${file.name} is neither a Ryco theme nor a VS Code color theme.`);
      }
      const theme = vscode.convertVsCodeTheme(file.value, { sourceName: file.name, siblings });
      notices.push(...theme.notices.map((notice) => `${theme.name}: ${notice}`));
      return theme;
    });
    for (const theme of vscode.pairVsCodeThemes(themes)) {
      converted.push({ ...theme, id: generateCustomThemeId(themeIdFromName(theme.name)) });
    }
  }

  const imported = [...rycoThemes, ...converted].map((theme) =>
    importThemeDefinition(theme, collision),
  );
  const last = imported.at(-1);
  if (options.activate && last) {
    setActiveThemeId(last.theme.id);
    const pair = getActiveThemePair();
    applyThemeToDocument(pair.light, pair.dark);
  }
  return { imported, notices };
}
