/**
 * The Automations dialog's "No project" entry: one logical "project" whose
 * checkouts are the devices that take schedules without a project. Its id on
 * each device is the node's "No project" scope, so the dialog reads and saves
 * its schedules like any project's.
 */
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID } from "@ryco/contracts/automation-scope";

import { resolveProjectEnvironmentLabel } from "../../../environmentDisplay";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";

/** The "No project" entry's logical key; no repository key looks like it. */
export const CHATS_AUTOMATION_PROJECT_KEY = `automations:${AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID}`;
export const CHATS_AUTOMATION_DISPLAY_NAME = "No project";
/** Where a device keeps its chats, when it did not say. */
const CHATS_FOLDER_FALLBACK = "Chats";

/** A device that takes schedules without a project. */
export interface ChatsAutomationDevice {
  readonly environmentId: EnvironmentId;
  /** The device's chats folder (each new chat gets a folder in it), if it said. */
  readonly root: string | null;
  /** The device's own name, as its descriptor or saved entry has it. */
  readonly label: string | null;
}

/**
 * Whether a device takes schedules without a project, and where its chats
 * live: the chats folder ("" when unknown), or null when it takes none.
 */
export function chatsAutomationRootOf(config: ServerConfig | null): string | null {
  if (config?.chatAutomations !== true || config.chats === undefined) return null;
  return config.chats.root ?? "";
}

/** Whether a dialog entry is the "No project" one. */
export function isChatsAutomationSnapshot(snapshot: Pick<SidebarProjectSnapshot, "projectKey">) {
  return snapshot.projectKey === CHATS_AUTOMATION_PROJECT_KEY;
}

/**
 * The "No project" entry over these devices (the primary one first), or null
 * when none takes such schedules.
 */
export function buildChatsAutomationSnapshot(input: {
  readonly devices: readonly ChatsAutomationDevice[];
  readonly primaryEnvironmentId: EnvironmentId | null;
}): SidebarProjectSnapshot | null {
  const devices = input.devices.toSorted(
    (a, b) =>
      Number(b.environmentId === input.primaryEnvironmentId) -
      Number(a.environmentId === input.primaryEnvironmentId),
  );
  const members: SidebarProjectGroupMember[] = devices.map((device) => ({
    id: AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID,
    environmentId: device.environmentId,
    name: CHATS_AUTOMATION_DISPLAY_NAME,
    cwd: device.root || CHATS_FOLDER_FALLBACK,
    defaultModelSelection: null,
    scripts: [],
    physicalProjectKey: `${device.environmentId}:${AGENT_CONTROL_CHATS_AUTOMATION_PROJECT_ID}`,
    environmentLabel: resolveProjectEnvironmentLabel({
      environmentId: device.environmentId,
      label: device.label,
    }),
  }));
  const representative = members[0];
  if (!representative) return null;
  const primary = input.primaryEnvironmentId;
  const hasLocal = primary !== null && members.some((member) => member.environmentId === primary);
  const remote = members.filter((member) => primary !== null && member.environmentId !== primary);
  return {
    ...representative,
    projectKey: CHATS_AUTOMATION_PROJECT_KEY,
    displayName: CHATS_AUTOMATION_DISPLAY_NAME,
    groupedProjectCount: members.length,
    environmentPresence:
      hasLocal && remote.length > 0 ? "mixed" : remote.length > 0 ? "remote-only" : "local-only",
    memberProjects: members,
    memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
    remoteEnvironmentLabels: [
      ...new Set(
        remote.flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : [])),
      ),
    ],
  };
}
