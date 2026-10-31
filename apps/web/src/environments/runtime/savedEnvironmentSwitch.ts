import type { EnvironmentId } from "@ryco/contracts";
import { switchSavedEnvironment } from "@ryco/client-runtime/connection/savedEnvironmentSwitch";

import { useSavedEnvironmentRegistryStore } from "./catalog";
import { teardownSavedEnvironmentSession } from "./service";

/**
 * Switches a saved machine on or off. Off lasts across syncs, resumes and
 * launches (the supervisor leaves a switched-off record alone) and ends its
 * session; its threads leave the sidebar until it is on again. The record,
 * its credential and its project artwork stay, so switching on needs no new
 * pairing: the supervisor's next sync connects it. Kept out of the service
 * module so only Settings loads it.
 */
export async function setSavedEnvironmentEnabled(
  environmentId: EnvironmentId,
  enabled: boolean,
): Promise<void> {
  switchSavedEnvironment(useSavedEnvironmentRegistryStore, environmentId, enabled);
  if (!enabled) await teardownSavedEnvironmentSession(environmentId);
}
