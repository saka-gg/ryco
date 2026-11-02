// What the scope sentence above a node section says. Its own module, apart from
// `settingsSections.logic`, which the app shell imports: only the settings page
// needs this.
import type { SettingsSectionId } from "../../settingsDialogStore";
import { settingsSectionScope } from "./settingsSections.logic";

/**
 * Whether a section's header says which node its changes apply to ("Changes
 * apply to [node]"): node sections only. A client section names this app, and a
 * browser or device section is this device's own, never a node's.
 */
export function settingsScopeSentenceShown(
  destination: "client" | "node",
  section: SettingsSectionId,
): boolean {
  if (destination !== "node") return false;
  const scope = settingsSectionScope(section);
  return scope !== "browser" && scope !== "device";
}

/** Sections with node defaults that offer "Apply to all nodes", and so may show "Mixed". */
const NODE_FAN_OUT_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  "general",
  "inbox",
  "source-control",
]);

export function settingsSectionHasNodeFanOut(section: SettingsSectionId): boolean {
  return NODE_FAN_OUT_SECTIONS.has(section);
}

/** Why a node a settings menu offers cannot be reached now, as its label says it. */
export type SettingsNodeStatus = "offline" | "connecting";

/**
 * Whether a node shows as Offline or Connecting, from the facts the settings
 * page's empty state uses: a node its directory reports offline, a connection
 * underway or one its Hub machine record allows, else any other connection
 * that is not up. A node this client holds no connection to by design (a
 * hosted node the selection cursor is not on) only shows Offline when its
 * directory says so.
 */
export function settingsNodeStatus(facts: {
  readonly connection: "connected" | "connecting" | "disconnected" | "error" | undefined;
  /** The directory's presence, or the Hub machine record's. */
  readonly online?: boolean | undefined;
  /** The Hub machine record allows connecting to it. */
  readonly canConnect?: boolean | undefined;
}): SettingsNodeStatus | null {
  if (facts.online === false) return "offline";
  if (facts.connection === undefined || facts.connection === "connected") return null;
  if (facts.connection === "connecting" || facts.canConnect === true) return "connecting";
  return "offline";
}
