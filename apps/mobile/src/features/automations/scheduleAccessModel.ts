import type { InboxEnvironment } from "../inbox/inboxModel";
import { canChangeNodeSettings, nodeSettingsReadOnlyReason } from "../settings/nodeSettingsTargets";

/** Whether this device may change a machine's schedules now, and why not. */
export interface ScheduleAccess {
  readonly editable: boolean;
  /** Why changes and decisions are off, or null when they are on. */
  readonly reason: string | null;
}

/** Said for a machine this phone no longer lists. */
export const SCHEDULE_MACHINE_UNKNOWN = "This machine is no longer paired.";

/**
 * A machine's schedule access, by the phone's one rule for owner-only node changes
 * (`canChangeNodeSettings`: its owner, connected, with its writes synchronized). Schedule
 * saves and approvals are owner-only Agent Control actions on the node, so they follow it
 * like the machine's settings do.
 */
export function scheduleAccessOf(
  node: Pick<InboxEnvironment, "role" | "mutationReady" | "connectionState"> | undefined,
): ScheduleAccess {
  if (node === undefined) return { editable: false, reason: SCHEDULE_MACHINE_UNKNOWN };
  const editable = canChangeNodeSettings(node);
  return { editable, reason: editable ? null : nodeSettingsReadOnlyReason(node) };
}
