import type { HostedRpcCapability } from "@ryco/client-runtime/authorization/capabilities";
import { WS_METHODS } from "@ryco/contracts";
import type { RelayEffectiveRole } from "@ryco/contracts/relay";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";

/** The task method every surface's access is judged by; the others share its owner-only rule. */
const TASKS_METHOD = WS_METHODS.serverListLocalTasks;

export interface TasksAccess {
  /** This session may use the tasks (see `resolveTasksAccess`). */
  readonly allowed: boolean;
  /** The Hub refuses the tasks to this session's role. */
  readonly denied: boolean;
}

/**
 * Whether this session may use the tasks. Outside hosted mode it always
 * may. On the Hub its role decides: a role that may not call the task
 * methods is `denied`. Stale Hub authorization or a relay that is
 * reconnecting refuse every call for a moment, but say nothing about the
 * role: tasks allowed before on this surface (`allowedBefore`) stay allowed
 * then, so a reconnect never tears them down, and ones never allowed yet
 * wait. Calls made meanwhile fail like any call during the gap.
 */
export function resolveTasksAccess(input: {
  readonly capability: Pick<HostedRpcCapability, "hosted" | "allowed">;
  /** The session's role on the node; `null` while unknown. */
  readonly role: RelayEffectiveRole | null;
  readonly allowedBefore: boolean;
}): TasksAccess {
  const denied =
    input.capability.hosted && input.role !== null && !hostedRoleAllows(input.role, TASKS_METHOD);
  return { denied, allowed: !denied && (input.capability.allowed || input.allowedBefore) };
}
