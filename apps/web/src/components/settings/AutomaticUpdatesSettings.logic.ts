import type { ServerConfig } from "@ryco/contracts";

/**
 * What the "Update automatically" switch shows for one node: nothing on an older node or for a
 * session that does not own the node (the setting is owner-only), otherwise the setting's real
 * value, and whether provider update checks are off (unattended updates act only while they are
 * on, so the switch can then only be turned off).
 */
export type AutomaticUpdatesView = "hidden" | "on" | "off" | "on-checks-off" | "off-checks-off";

export function automaticUpdatesView(input: {
  readonly config: ServerConfig | null;
  readonly owner: boolean;
}): AutomaticUpdatesView {
  const { config } = input;
  if (!input.owner || config?.environment?.capabilities?.automaticUpdates !== true) return "hidden";
  const value = config.settings.automaticUpdates ? "on" : "off";
  return config.settings.enableProviderUpdateChecks ? value : `${value}-checks-off`;
}

/** The switch: its value, and whether it may change (turning it off is always allowed). */
export function automaticUpdatesSwitch(view: Exclude<AutomaticUpdatesView, "hidden">): {
  readonly checked: boolean;
  readonly checksOff: boolean;
  readonly canChange: boolean;
} {
  const checked = view === "on" || view === "on-checks-off";
  const checksOff = view.endsWith("-checks-off");
  return { checked, checksOff, canChange: checked || !checksOff };
}
