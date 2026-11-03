import type { UpdateEverythingEnvironmentSource } from "@ryco/client-runtime/updates";
import type { NodeUpdateState, ServerConfig } from "@ryco/contracts";

import type { InboxEnvironment } from "../../inbox/inboxModel";
import { canChangeNodeSettings } from "../nodeSettingsTargets";

/** The parts of a Home machine row "Update everything" reads. */
export type MobileUpdateMachine = Pick<
  InboxEnvironment,
  "environmentId" | "label" | "connectionState" | "role" | "mutationReady"
>;

/**
 * One machine as the planner sees it. Only its owner on a connected,
 * mutation-ready connection may update it (`canChangeNodeSettings`, the rule
 * every node maintenance surface on the phone uses); its running chats count
 * only once its shell is current, since cached or held-over rows show nothing
 * running.
 */
export function mobileUpdateSource(
  machine: MobileUpdateMachine,
  state: {
    readonly config: ServerConfig | null;
    readonly shellCurrent: boolean;
    readonly nodeUpdate: NodeUpdateState | null;
  },
): UpdateEverythingEnvironmentSource {
  const connected = machine.connectionState === "connected";
  return {
    environmentId: machine.environmentId,
    descriptorLabel: machine.label,
    connectionLabel: machine.label,
    config: state.config,
    live: connected && state.shellCurrent,
    canMutate: canChangeNodeSettings(machine),
    nodeUpdate: state.nodeUpdate,
  };
}
