// The Settings tab's per-machine pages: which machines they list and what each page's row
// says. Pure, so the test can hold the summaries.

import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

export interface MachineListEntry {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connected" | "reconnecting" | "offline" | "read-only";
  readonly role?: "viewer" | "operator" | "owner" | "client";
}

/** "Online" · "Viewer" · "Reconnecting" · "Offline": what a machine row says on the right. */
export function machineStatusLabel(entry: MachineListEntry): string {
  if (entry.connectionState === "offline") return "Offline";
  if (entry.connectionState === "reconnecting") return "Reconnecting";
  if (entry.role !== undefined && entry.role !== "owner") return "Viewer";
  return "Online";
}

/** The Machine page's row values: providers turned on, and whether Agent Control is. */
export function machineSettingsSummary(config: ServerConfig | null): {
  readonly providers: string;
  readonly agents: string;
} {
  if (config === null) return { providers: "", agents: "" };
  const enabled = config.providers.filter((provider) => provider.enabled).length;
  return {
    providers: enabled === 0 ? "None on" : `${enabled} on`,
    agents: config.settings.agentControl.enabled ? "Agent Control on" : "",
  };
}
