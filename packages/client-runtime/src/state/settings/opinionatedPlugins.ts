import type {
  OpinionatedPluginCatalogItem,
  OpinionatedPluginId,
  OpinionatedPluginStatus,
} from "@ryco/contracts";

import type { SettingsStatus } from "./mcpServers.ts";

/**
 * The opinionated plugins a node offers (RTK, Caveman, …) and where each is installed, as the
 * web's Plugins page and the phone's Agents screen show them.
 */

/** One plugin on one target (the whole machine, or one provider instance). */
export function opinionatedPluginStatusKey(status: OpinionatedPluginStatus): string {
  return `${status.pluginId}:${status.targetKind}:${status.providerInstanceId ?? "global"}`;
}

export function opinionatedPluginStatus(status: OpinionatedPluginStatus): SettingsStatus {
  switch (status.state) {
    case "installed":
      return { label: "Installed", tone: "success" };
    case "not-installed":
      return { label: "Not installed", tone: "outline" };
    case "unsupported":
      return { label: "Unsupported", tone: "warning" };
    case "error":
      return { label: "Error", tone: "error" };
  }
}

export function opinionatedPluginTargetLabel(status: OpinionatedPluginStatus): string {
  if (status.targetKind === "global") return "System";
  return status.providerDisplayName ?? String(status.providerInstanceId ?? "Provider");
}

export function opinionatedPluginImpactLabel(plugin: OpinionatedPluginCatalogItem): string {
  return plugin.impact === "tool-output" ? "Tool output" : "Assistant output";
}

export function opinionatedPluginScopeLabel(plugin: OpinionatedPluginCatalogItem): string {
  return plugin.scope === "global" ? "Global" : "Provider";
}

/** Whether this target can be installed from here (it is not already). */
export function canInstallOpinionatedPlugin(status: OpinionatedPluginStatus): boolean {
  return status.canInstall && status.state !== "installed";
}

function pluginSortValue(pluginId: OpinionatedPluginId): number {
  switch (pluginId) {
    case "rtk":
      return 0;
    case "caveman":
      return 1;
    case "token-optimizer":
      return 2;
    case "token-savior":
      return 3;
    case "lean-ctx":
      return 4;
  }
}

function targetSortValue(status: OpinionatedPluginStatus): string {
  return `${status.targetKind === "global" ? "0" : "1"}:${opinionatedPluginTargetLabel(status).toLowerCase()}`;
}

/** The catalog in its fixed order. */
export function sortOpinionatedPlugins(
  plugins: ReadonlyArray<OpinionatedPluginCatalogItem>,
): ReadonlyArray<OpinionatedPluginCatalogItem> {
  return plugins.toSorted((left, right) => pluginSortValue(left.id) - pluginSortValue(right.id));
}

/** Each plugin's targets, the machine first and then providers by name. */
export function groupOpinionatedPluginStatuses(
  statuses: ReadonlyArray<OpinionatedPluginStatus>,
): ReadonlyMap<OpinionatedPluginId, ReadonlyArray<OpinionatedPluginStatus>> {
  const grouped = new Map<OpinionatedPluginId, OpinionatedPluginStatus[]>();
  for (const status of statuses) {
    const list = grouped.get(status.pluginId) ?? [];
    list.push(status);
    grouped.set(status.pluginId, list);
  }
  const sorted = new Map<OpinionatedPluginId, ReadonlyArray<OpinionatedPluginStatus>>();
  for (const [pluginId, list] of grouped) {
    sorted.set(
      pluginId,
      list.toSorted((left, right) => targetSortValue(left).localeCompare(targetSortValue(right))),
    );
  }
  return sorted;
}

/** Puts an install's resulting status in place of the target's previous one. */
export function replaceOpinionatedPluginStatus(
  statuses: ReadonlyArray<OpinionatedPluginStatus>,
  next: OpinionatedPluginStatus,
): ReadonlyArray<OpinionatedPluginStatus> {
  const key = opinionatedPluginStatusKey(next);
  return [...statuses.filter((status) => opinionatedPluginStatusKey(status) !== key), next];
}

/** The plugin's name from the catalog, for confirmations and results. */
export function opinionatedPluginName(
  plugins: ReadonlyArray<OpinionatedPluginCatalogItem>,
  pluginId: OpinionatedPluginId,
): string {
  return plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;
}
