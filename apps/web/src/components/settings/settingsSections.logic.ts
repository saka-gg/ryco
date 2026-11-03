import type { SettingsEditingScope, SettingsTarget } from "../../settingsTarget";
import {
  settingsSection,
  type PhoneSettingsSectionId,
  type SettingsPageSectionId,
  type SettingsStorage,
} from "./settingsRegistry";

/**
 * Who may open which part of settings, as one set of predicates.
 *
 * IT LIVES HERE RATHER THAN IN `SettingsPage.tsx` BECAUSE IT HAS CALLERS
 * OUTSIDE THE PAGE. The settings page, the command palette and the phone
 * surface filter with it, and `HostedE2eeVerification` asks the same question
 * before it draws a sentence that sends a reader to a device's Security
 * (docs/relay-e2ee-protocol §13.5's accompanying text). That component sits in
 * the eagerly loaded shell and the settings page is deliberately behind a
 * dynamic import (`perf/webBundleSplitting.test.ts`), so this module imports
 * only the pure section registry.
 *
 * Sections mix where their rows are stored, so the gate is per part
 * ({@link SettingsStorage}): this app's rows stay reachable for every reader,
 * and rows stored on a device follow the reader's role on that device.
 */

/** The role a hosted grant carries, or `null` when no fresh snapshot exists. */
export type HostedSettingsRole = "viewer" | "operator" | "owner" | null;
export type SettingsScope = "browser" | "device" | "account" | "node" | "mixed";

export function settingsScopeLabel(
  scope: SettingsScope,
  options: {
    readonly nativeClient: boolean;
    readonly nodeLabel: string | null;
    readonly appLabel?: string;
  },
): string {
  const app =
    options.appLabel ?? (options.nativeClient ? "Ryco Desktop" : "Ryco Web · current browser");
  const device = options.nodeLabel ?? "Device connecting…";
  if (scope === "node") return device;
  if (scope === "account") return "Hub account";
  if (scope === "mixed") return `${app} + ${device}`;
  return app;
}

/**
 * Whether the hosted role snapshot is current enough to gate on.
 *
 * A hosted grant's role is read from the directory over the transport, so
 * between a reconnect and a fresh directory it is a stale value rather than an
 * unknown one — and stale is the dangerous kind, because it is a value the gates
 * would happily act on.
 */
export function hostedSettingsRoleFresh(directoryStatus: string, transportStatus: string): boolean {
  return directoryStatus === "ready" && transportStatus === "online";
}

/**
 * The role snapshot, or `null` while it cannot be trusted.
 *
 * Every caller of {@link settingsSectionReachable} passes the role through this,
 * so "not fresh" and "no role" fail closed identically and no surface has to
 * remember the ternary.
 */
export function hostedSettingsRoleSnapshot(
  role: HostedSettingsRole,
  directoryStatus: string,
  transportStatus: string,
): HostedSettingsRole {
  return hostedSettingsRoleFresh(directoryStatus, transportStatus) ? role : null;
}

/** What decides whether a reader may open a part of settings. */
export interface SettingsReach {
  /** The hosted (Hub) client. */
  readonly hosted: boolean;
  /** The desktop app on this computer offers computer use. */
  readonly desktopComputerUse: boolean;
  /**
   * The device the page shows, or null while none is known. `gated` is true when
   * its role decides (hosted, or a device other than this app's own); `role` is
   * already null while the hosted snapshot is stale ({@link hostedSettingsRoleSnapshot}).
   */
  readonly device: { readonly gated: boolean; readonly role: HostedSettingsRole } | null;
}

/**
 * Whether a reader may open a part stored in `storage`. Rows on a device are
 * owner-only wherever the role decides; archived threads are any role's to
 * read; an unknown or stale role fails closed.
 */
export function settingsStorageReachable(storage: SettingsStorage, reach: SettingsReach): boolean {
  switch (storage) {
    case "app":
      return true;
    case "hub":
      return reach.hosted;
    case "desktop":
      return !reach.hosted && reach.desktopComputerUse;
    case "this-computer":
      return !reach.hosted;
    case "device":
      return reach.device !== null && (!reach.device.gated || reach.device.role === "owner");
    case "device-read":
      return reach.device !== null && (!reach.device.gated || reach.device.role !== null);
  }
}

/** Whether the nav lists a section: any of its parts is reachable. */
export function settingsSectionListed(
  section: SettingsPageSectionId,
  reach: SettingsReach,
): boolean {
  return settingsSection(section).parts.some((storage) => settingsStorageReachable(storage, reach));
}

/** Whether a section shows the device bar: it has a reachable part stored on a device. */
export function settingsSectionHasDeviceParts(
  section: SettingsPageSectionId,
  reach: SettingsReach,
): boolean {
  if (section === "device") return false;
  return settingsSection(section).parts.some(
    (storage) =>
      (storage === "device" || storage === "device-read") &&
      settingsStorageReachable(storage, reach),
  );
}

/** Whether every part of a section is this app's own ("This app" in its header). */
export function settingsSectionAppOnly(section: SettingsPageSectionId): boolean {
  return settingsSection(section).parts.every((storage) => storage === "app");
}

/**
 * Where each section of the frozen web phone tier keeps its rows, for its gate
 * ({@link settingsSectionReachable}). That tier is not extended (AGENTS.md); it
 * keeps today's inventory and today's per-section gates, now read from the same
 * storage rule the page uses.
 */
const PHONE_SECTION_STORAGE = {
  account: "hub",
  general: "device",
  inbox: "device",
  providers: "device",
  "opinionated-plugins": "device",
  "mcp-servers": "device",
  appearance: "app",
  keybindings: "app",
  "source-control": "device",
  connections: "this-computer",
  security: "device",
  statistics: "device",
  archived: "device-read",
  diagnostics: "device",
} as const satisfies Record<PhoneSettingsSectionId, SettingsStorage>;

/**
 * Whether the frozen phone tier can open one of its sections. The Hub account
 * is a Hub page, never a section of that sheet.
 */
export function settingsSectionReachable(
  section: PhoneSettingsSectionId,
  { hosted, role }: { readonly hosted: boolean; readonly role: HostedSettingsRole },
): boolean {
  if (section === "account") return false;
  return settingsStorageReachable(PHONE_SECTION_STORAGE[section], {
    hosted,
    desktopComputerUse: false,
    device: { gated: hosted, role },
  });
}

/**
 * Whether a reader can open a device's Security, the pointer §13.5's copy draws
 * (`HostedE2eeVerification`). Hosted settings show the selected node, whose role
 * is the shared snapshot.
 */
export function deviceSecurityReachable({
  hosted,
  role,
}: {
  readonly hosted: boolean;
  readonly role: HostedSettingsRole;
}): boolean {
  return settingsStorageReachable("device", {
    hosted,
    desktopComputerUse: false,
    device: { gated: hosted, role },
  });
}

/**
 * Whether this settings surface cannot change a node-owned setting: client-only editing, node
 * editing without a target node, or a target node that is disconnected or that this client may
 * not manage or mutate. Feature checks (capabilities, a loaded config) stay with each caller.
 */
export function isNodeSettingsTargetReadOnly(
  scope: SettingsEditingScope,
  target: SettingsTarget | null,
): boolean {
  return (
    scope === "client" ||
    (scope === "node" && !target) ||
    Boolean(
      target && (!target.connected || target.canManage === false || target.canMutate === false),
    )
  );
}
