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

/**
 * What a desktop app node also does while the setting is on: it updates itself (downloads in
 * the background, then installs at quit or at the person's Restart). `null` on other nodes and
 * on desktop apps too old to say.
 */
export function automaticUpdatesDesktopNote(config: ServerConfig | null): string | null {
  switch (config?.environment?.capabilities?.desktopAppUpdates) {
    case "install-on-quit":
      return "This desktop app also downloads its own updates in the background and installs one when you quit it. It never restarts by itself.";
    case "restart":
      return "This desktop app also downloads its own updates in the background. On macOS one installs only when you choose Restart.";
    default:
      return null;
  }
}
