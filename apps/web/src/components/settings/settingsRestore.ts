import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@ryco/contracts/settings";
import { isServerSettingKey } from "@ryco/shared/settingsOwnership";
import { Equal } from "effect";

const RESTORABLE_SETTINGS = {
  timestampFormat: "Time format",
  diffWordWrap: "Diff line wrapping",
  diffIgnoreWhitespace: "Diff whitespace changes",
  gitStatusPollIntervalMs: "Remote Git status",
  sourceControlRefreshMode: "PR & workflow updates",
  autoOpenPlanSidebar: "Auto-open overview",
  enableLegacyTokenStreaming: "Stream token by token",
  enableProviderUpdateChecks: "Provider update checks",
  defaultThreadEnvMode: "New thread mode",
  addProjectBaseDirectory: "Add project base directory",
  confirmThreadArchive: "Archive confirmation",
  confirmThreadDelete: "Delete confirmation",
  confirmThreadUnpin: "Unpin confirmation",
  textGenerationModelSelection: "Git writing model",
} as const satisfies Partial<Record<keyof UnifiedSettings, string>>;

export function settingsRestorePlan(
  settings: UnifiedSettings,
  theme: string,
  scope: "client" | "node" | "all",
) {
  const resetTheme = scope !== "node" && theme !== "system";
  const labels: string[] = resetTheme ? ["Theme"] : [];
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(RESTORABLE_SETTINGS) as (keyof typeof RESTORABLE_SETTINGS)[]) {
    if (scope !== "all" && isServerSettingKey(key) !== (scope === "node")) continue;
    if (Equal.equals(settings[key], DEFAULT_UNIFIED_SETTINGS[key])) continue;
    labels.push(RESTORABLE_SETTINGS[key]);
    patch[key] = DEFAULT_UNIFIED_SETTINGS[key];
  }
  return { labels, resetTheme, patch: patch as Partial<UnifiedSettings> };
}
