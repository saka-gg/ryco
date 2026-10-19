import { selectLocalTasksForbidden, useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import { WS_METHODS, type EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { useMemo, useState } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useEnvironmentServerConfigSelector } from "~/hooks/useChatsAvailability";
import { useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useHostedHubStore } from "~/hostedHub/state";

import { resolveTasksAccess } from "./tasksAccess.logic";

/**
 * Where tasks live and whether this client can use them. Tasks belong to one
 * node, the primary environment: the page and the sidebar entry both read
 * this, so they always agree.
 */
export interface TasksEnvironment {
  readonly environmentId: EnvironmentId | null;
  /** The node advertises `capabilities.localTasks`; `null` while its config is unknown. */
  readonly supported: boolean | null;
  /**
   * This session may use the tasks: always outside hosted mode, for owners on
   * the Hub. Once allowed it stays so through stale Hub authorization or a
   * relay reconnect (`resolveTasksAccess`).
   */
  readonly allowed: boolean;
  /** The Hub refuses the tasks to this session's role, or the node refused a read as not its owner's. */
  readonly denied: boolean;
  /** Why `denied`. */
  readonly reason: string | null;
}

const DENIED_REASON = "Only the node’s owner can use its tasks.";

// Module level, so unrelated config pushes (provider probes) never re-render.
const selectLocalTasksSupported = (config: ServerConfig | null): boolean | null =>
  config === null ? null : config.environment.capabilities.localTasks === true;

export function useTasksEnvironment(): TasksEnvironment {
  const environmentId = usePrimaryEnvironmentId();
  const supported = useEnvironmentServerConfigSelector(environmentId, selectLocalTasksSupported);
  const capability = useHostedRpcCapability(WS_METHODS.serverListLocalTasks, environmentId);
  // The shared state mirrors the selected node only, so its role counts for this environment
  // only while this is the selected one; the capability above answers for any other.
  const role = useHostedHubStore((state) =>
    environmentId !== null && state.selectedNode?.environmentId === environmentId
      ? state.effectiveRole
      : null,
  );
  // The node this surface was allowed to use; a reconnect keeps it, a new node starts over.
  const [allowedFor, setAllowedFor] = useState<EnvironmentId | null>(null);
  if (capability.allowed && environmentId !== null && allowedFor !== environmentId) {
    setAllowedFor(environmentId);
  }
  // Outside the Hub the client can't know its role up front; the node's own
  // refusal of a read says it, and then the tasks are denied here too.
  const refused = useLocalTasksStore((state) =>
    environmentId === null ? false : selectLocalTasksForbidden(state, environmentId),
  );
  const access = resolveTasksAccess({
    capability,
    role,
    allowedBefore: environmentId !== null && allowedFor === environmentId,
  });
  // An environment other than the selected one has no role here; its own capability says it.
  const roleRefused = capability.hosted && capability.kind === "role";
  const denied = access.denied || roleRefused || refused;
  const allowed = access.allowed && !roleRefused && !refused;
  return useMemo(
    () => ({ environmentId, supported, allowed, denied, reason: denied ? DENIED_REASON : null }),
    [allowed, denied, environmentId, supported],
  );
}

/** The tasks can be read and written: a supporting node this session may call. */
export function tasksAvailable(tasks: TasksEnvironment): tasks is TasksEnvironment & {
  readonly environmentId: EnvironmentId;
} {
  return tasks.environmentId !== null && tasks.supported === true && tasks.allowed;
}
