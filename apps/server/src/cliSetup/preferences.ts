/**
 * Small CLI-only preferences, kept apart from the node's serve settings:
 * currently whether a bare `ryco` in a terminal offers the setup guide.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CliPreferences {
  /** `true` once the user chose "Open Ryco here, and don't ask again". */
  readonly skipLaunchChooser?: boolean;
}

export const cliPreferencesPath = (stateDir: string) => path.join(stateDir, "cli-preferences.json");

export async function readCliPreferences(filePath: string): Promise<CliPreferences> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as CliPreferences) : {};
  } catch {
    return {};
  }
}

export async function writeCliPreferences(
  filePath: string,
  preferences: CliPreferences,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
}
