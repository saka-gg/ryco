import type { ServerConfig } from "@ryco/contracts";

/**
 * What the "Update automatically" switch shows for one node: nothing on an older node or for a
 * session that does not own the node (the setting is owner-only), disabled while provider update
 * checks are off (unattended updates need them), otherwise the setting.
 */
export type AutomaticUpdatesView = "hidden" | "checks-off" | "on" | "off";

export function automaticUpdatesView(input: {
  readonly config: ServerConfig | null;
  readonly owner: boolean;
}): AutomaticUpdatesView {
  const { config } = input;
  if (!input.owner || config?.environment?.capabilities?.automaticUpdates !== true) return "hidden";
  if (!config.settings.enableProviderUpdateChecks) return "checks-off";
  return config.settings.automaticUpdates ? "on" : "off";
}
