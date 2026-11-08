// The Settings tab's list, after t3code's phone Settings (`SettingsRouteScreen.tsx`): a calm
// grouped list, one plain SF Symbol per row, the value on the right and a chevron, an
// account and machines summary at the top, and the rarely used pages grouped at the bottom.
// Pure, so the test can hold that every settings page stays reachable.

import type { AppSymbolName } from "../../components/AppSymbol";

/** Where a row goes: a settings page pushed above the tabs, Machines, or the node's security. */
export type SettingsListTarget =
  | "SettingsHub"
  | "SettingsAppearance"
  | "SettingsNotifications"
  | "SettingsInbox"
  | "SettingsProviderAccounts"
  | "SettingsWorkspace"
  | "SettingsArchived"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsAbout"
  | "Connections"
  | "NodeSecurity";

export interface SettingsListRow {
  readonly id: SettingsListTarget;
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly value?: string;
}

export interface SettingsListSection {
  readonly key: string;
  /** Absent for the leading and trailing groups, as t3code leaves them. */
  readonly title?: string;
  readonly rows: ReadonlyArray<SettingsListRow>;
}

export interface SettingsSummary {
  /** "Ryco Hub" and its host, or that no Hub is set up. */
  readonly hubLabel: string;
  readonly hubDetail: string | null;
  readonly machinesValue: string;
}

export function buildSettingsSummary(input: {
  readonly hub: { readonly label: string; readonly origin: string } | null;
  readonly machines: { readonly total: number; readonly connected: number };
}): SettingsSummary {
  const { total, connected } = input.machines;
  return {
    hubLabel: input.hub?.label ?? "No Hub",
    hubDetail: input.hub ? hostOf(input.hub.origin) : "Pair machines directly or set up a Hub",
    machinesValue:
      total === 0
        ? "None"
        : connected === total
          ? `${total} online`
          : `${connected} of ${total} online`,
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function buildSettingsSections(input: {
  readonly version: string | null;
}): ReadonlyArray<SettingsListSection> {
  return [
    {
      key: "general",
      rows: [
        { id: "SettingsAppearance", icon: "paintbrush", label: "Appearance" },
        { id: "SettingsNotifications", icon: "bell.badge", label: "Notifications" },
        { id: "SettingsInbox", icon: "text.bubble", label: "Chats" },
      ],
    },
    {
      key: "agents",
      title: "Agents",
      rows: [
        { id: "SettingsProviderAccounts", icon: "person.crop.circle", label: "Provider accounts" },
        {
          id: "SettingsWorkspace",
          icon: "slider.horizontal.3",
          label: "New task defaults",
          value: "Per machine",
        },
      ],
    },
    {
      key: "machines",
      title: "Machines",
      rows: [{ id: "NodeSecurity", icon: "lock.shield", label: "Node security" }],
    },
    {
      key: "more",
      rows: [
        { id: "SettingsArchived", icon: "archivebox", label: "Archived" },
        { id: "SettingsClientStorage", icon: "internaldrive", label: "Storage & cache" },
        { id: "SettingsDiagnostics", icon: "stethoscope", label: "Diagnostics" },
        {
          id: "SettingsAbout",
          icon: "info.circle",
          label: "About",
          ...(input.version ? { value: input.version } : {}),
        },
      ],
    },
  ];
}
