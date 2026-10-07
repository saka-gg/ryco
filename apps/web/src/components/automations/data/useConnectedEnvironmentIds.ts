import type { EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../../../environments/runtime";
import { proposalSyncKey } from "./useAutomationProposalSync";

/* The connected environments, one array per distinct set, so a store
   snapshot keeps its identity until a connection comes or goes. */
let connected: { readonly key: string; readonly ids: readonly EnvironmentId[] } = {
  key: proposalSyncKey([]),
  ids: [],
};
function readConnectedEnvironments(): readonly EnvironmentId[] {
  const ids = [
    ...new Set(listEnvironmentConnections().map((connection) => connection.environmentId)),
  ].toSorted();
  const key = proposalSyncKey(ids);
  if (key !== connected.key) connected = { key, ids };
  return connected.ids;
}
const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];

/** Every device this app is connected to — this one's server, saved and Hub devices — sorted. */
export function useConnectedEnvironmentIds(): readonly EnvironmentId[] {
  return useSyncExternalStore(
    subscribeEnvironmentConnections,
    readConnectedEnvironments,
    () => NO_ENVIRONMENTS,
  );
}
