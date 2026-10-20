import type { HostedHubState } from "@ryco/client-runtime/authorization";
import {
  resolveHostedEnvironmentRpcCapability,
  resolveHostedRpcCapability,
  selectHostedSharedCapabilityState,
  type HostedRpcCapability,
} from "@ryco/client-runtime/authorization/capabilities";
import {
  resolveHostedDeliveryNotice,
  type HostedDeliveryNotice,
} from "@ryco/client-runtime/authorization/deliveryNotice";
import type {
  HostedEnvironmentSessionRecord,
  HostedEnvironmentSessionsSnapshot,
} from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import type { EnvironmentId } from "@ryco/contracts";
import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { isHostedHubMode } from "../env";
import { getHostedEnvironmentSessions, hostedHubController, useHostedHubStore } from "./state";

export { resolveHostedRpcCapability };
export type { HostedDeliveryNotice, HostedRpcCapability };

/**
 * Non-React read of the hosted capability policy; the input mapping is shared
 * in the client runtime, this only supplies the current stores.
 *
 * `environmentId` picks the environment the action runs on and is always
 * stated: an id answers from that environment's own session, `null` means the
 * routed (selected) one. The selected environment is the only one the hub state
 * mirrors, so a capability for any other environment must name it. A literal
 * `null` at a call site is deliberate and carries a
 * `// hosted-capability: routed node` comment, which a source scan enforces.
 */
export function readHostedRpcCapability(
  method: string,
  environmentId: EnvironmentId | null,
  state: HostedHubState = useHostedHubStore.getState(),
  sessions?: HostedEnvironmentSessionsSnapshot,
): HostedRpcCapability {
  return resolveHostedEnvironmentRpcCapability({
    hosted: isHostedHubMode(),
    method,
    shared: selectHostedSharedCapabilityState(state, environmentId),
    record:
      environmentId == null
        ? undefined
        : (sessions ?? getHostedEnvironmentSessions().getSnapshot()).records.get(environmentId),
    environmentId,
  });
}

const subscribeToNothing = () => () => undefined;
const readNothing = () => undefined;

/**
 * The environment's own session record, re-read only when that record changes.
 * Without an environment there is nothing to follow and the registry is not
 * touched at all.
 */
function useHostedEnvironmentRecord(
  environmentId: EnvironmentId | null | undefined,
): HostedEnvironmentSessionRecord | undefined {
  const sessions = environmentId == null ? null : getHostedEnvironmentSessions();
  const read =
    sessions && environmentId != null
      ? () => sessions.getSnapshot().records.get(environmentId)
      : readNothing;
  return useSyncExternalStore(sessions ? sessions.subscribe : subscribeToNothing, read, read);
}

/**
 * React binding only; capability policy is package-owned.
 *
 * Subscribes to the handful of hosted fields a capability reads, and to the
 * named environment's own record, so a directory refresh or another
 * environment's progress never re-renders the caller. The result is a shared
 * object per outcome, so it keeps its identity while nothing relevant changes.
 *
 * `environmentId` is required, with the same meaning as for
 * `readHostedRpcCapability`: an id, or `null` for the routed node.
 */
export function useHostedRpcCapability(
  method: string,
  environmentId: EnvironmentId | null,
): HostedRpcCapability {
  const shared = useHostedHubStore(
    useShallow((state) => selectHostedSharedCapabilityState(state, environmentId)),
  );
  const record = useHostedEnvironmentRecord(environmentId);
  const hosted = isHostedHubMode();
  return useMemo(
    () => resolveHostedEnvironmentRpcCapability({ hosted, method, shared, record, environmentId }),
    [environmentId, hosted, method, record, shared],
  );
}

/**
 * The session generation an action on `environmentId` is fenced against.
 *
 * It is the environment's own: its record's generation when it has one, else
 * the shared generation when it is the selected environment, else `null`. An
 * action that waits for work to settle compares it before and after, and moving
 * the cursor to another environment changes neither.
 */
export function readHostedSessionGeneration(environmentId: EnvironmentId): number | null {
  const record = getHostedEnvironmentSessions().read(environmentId);
  if (record !== undefined) return record.generation;
  const state = useHostedHubStore.getState();
  return state.selectedNode?.environmentId === environmentId ? state.generation : null;
}

export interface HostedDeliveryNoticeBinding extends HostedDeliveryNotice {
  readonly acknowledge: () => void;
}

/**
 * The unconfirmed-delivery notice for `environmentId`: from the shared session
 * when it is the hosted selection, from its own session record otherwise.
 */
export function useHostedDeliveryNotice(
  environmentId: EnvironmentId | null | undefined,
): HostedDeliveryNoticeBinding | null {
  const sessionStatus = useHostedHubStore((state) => state.sessionStatus);
  const sessionRecoveredAfterUnknown = useHostedHubStore(
    (state) => state.sessionRecoveredAfterUnknown,
  );
  const selectedEnvironmentId = useHostedHubStore(
    (state) => state.selectedNode?.environmentId ?? null,
  );
  const selectedLabel = useHostedHubStore((state) => state.selectedNode?.label ?? null);
  const hosted = isHostedHubMode();
  const selected = hosted && !!environmentId && environmentId === selectedEnvironmentId;
  const record = useHostedEnvironmentRecord(hosted && !selected ? environmentId : null);
  const recordSessionStatus = record?.sessionStatus;
  const recordRecovered = record?.sessionRecoveredAfterUnknown;
  const recordLabel = record?.label ?? null;
  return useMemo(() => {
    if (selected) {
      const notice = resolveHostedDeliveryNotice(
        { sessionStatus, sessionRecoveredAfterUnknown },
        selectedLabel,
      );
      return notice
        ? { ...notice, acknowledge: () => hostedHubController.acknowledgeDeliveryUnknown() }
        : null;
    }
    if (!environmentId || recordSessionStatus === undefined) return null;
    const notice = resolveHostedDeliveryNotice(
      {
        sessionStatus: recordSessionStatus,
        sessionRecoveredAfterUnknown: recordRecovered === true,
      },
      recordLabel,
    );
    return notice
      ? {
          ...notice,
          acknowledge: () =>
            getHostedEnvironmentSessions().acknowledgeDeliveryUnknown(environmentId),
        }
      : null;
  }, [
    environmentId,
    recordLabel,
    recordRecovered,
    recordSessionStatus,
    selected,
    selectedLabel,
    sessionRecoveredAfterUnknown,
    sessionStatus,
  ]);
}
