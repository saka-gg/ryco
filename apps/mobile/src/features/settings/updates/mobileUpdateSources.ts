import type { UpdateEverythingEnvironmentSource } from "@ryco/client-runtime/updates";
import type { EnvironmentId, NodeUpdateState, ServerConfig } from "@ryco/contracts";

/** The parts of a Home machine row "Update everything" reads. */
export interface MobileUpdateMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: string;
  readonly role?: string | undefined;
  readonly mutationReady?: boolean | undefined;
}

/**
 * One machine as the planner sees it. Only its owner on a connected,
 * mutation-ready connection may update it, the rule every node maintenance
 * surface on the phone uses; its running chats count only once its shell is
 * current, since cached or held-over rows show nothing running.
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
    canMutate: connected && machine.role === "owner" && machine.mutationReady === true,
    nodeUpdate: state.nodeUpdate,
  };
}
