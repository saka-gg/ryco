import {
  createSidebarUndoHistory,
  createSidebarUndoLocalContextReader,
  type SidebarUndoNotice,
} from "@ryco/client-runtime/state/threads";
import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import type { ScopedThreadRef } from "@ryco/contracts";
import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts/orchestration";
import { Alert } from "react-native";
import { readEnvironmentApi } from "../connection/environmentApi";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { readEnvironmentServerConfig } from "./environmentServerConfigs";
import { selectProjectByRef, selectSidebarThreadSummaryByRef, useStore } from "./threadsRuntime";
import { newCommandId } from "../lib/ids";

let notices: readonly SidebarUndoNotice[] = [];
const listeners = new Set<() => void>();
export const sidebarUndoNotices = {
  read: () => notices,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
/** Local pin state needs no connection: only the thread's cached ordering fields. */
export const readMobileSidebarUndoLocalContext = createSidebarUndoLocalContextReader({
  getState: () => useStore.getState(),
  subscribe: (listener) => useStore.subscribe(listener),
  selectThread: selectSidebarThreadSummaryByRef,
  selectProject: selectProjectByRef,
});
export function readMobileSidebarUndoContext(target: ScopedThreadRef) {
  const registry = createMobileConnectionRegistry();
  const connection = registry.driver.supervisor.read(target.environmentId);
  const generation = connection?.shellSnapshotReadiness.read();
  const api = readEnvironmentApi(target.environmentId);
  const local = readMobileSidebarUndoLocalContext(target);
  if (!connection || !generation || !api || !local) return null;
  if (connection.knownEnvironment.source === "hub-hosted") {
    const record = getMobileHostedConnectionCoordinator().read(target.environmentId);
    const capability = resolveHostedRpcCapability({
      hosted: true,
      role: record?.effectiveRole ?? null,
      fresh:
        record?.transportStatus === "online" && record.attemptPrepared && record.sessionEstablished,
      sessionReady: record?.sessionStatus === "ready",
      method: ORCHESTRATION_WS_METHODS.dispatchCommand,
    });
    if (!capability.allowed) return null;
  }
  return {
    generation,
    api,
    threadRevision: local.threadRevision,
    parentRevision: local.parentRevision,
    threadTitle: local.threadTitle,
    supported:
      readEnvironmentServerConfig(target.environmentId)?.environment.capabilities
        .threadSidebarUndo === true,
  };
}
export const sidebarUndo = createSidebarUndoHistory({
  readContext: readMobileSidebarUndoContext,
  readLocalContext: readMobileSidebarUndoLocalContext,
  newCommandId,
  changed: (next) => {
    notices = next;
    for (const listener of listeners) listener();
  },
  failed: (error) =>
    Alert.alert(
      "Could not undo task action",
      error instanceof Error
        ? error.message
        : "The request failed. Check the current task state before trying again.",
    ),
});
