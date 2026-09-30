import {
  createSidebarUndoHistory,
  sidebarUndoThreadRevision,
  type SidebarUndoNotice,
} from "@ryco/client-runtime/state/threads";
import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import { ORCHESTRATION_WS_METHODS, type ScopedThreadRef } from "@ryco/contracts";
import { Alert } from "react-native";
import { readEnvironmentApi } from "../connection/environmentApi";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { readEnvironmentServerConfig } from "./environmentServerConfigs";
import { selectSidebarThreadSummaryByRef, selectProjectByRef, useStore } from "./threadsRuntime";
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
export function readMobileSidebarUndoContext(target: ScopedThreadRef) {
  const registry = createMobileConnectionRegistry();
  const connection = registry.driver.supervisor.read(target.environmentId);
  const generation = connection?.shellSnapshotReadiness.read();
  const api = readEnvironmentApi(target.environmentId);
  const state = useStore.getState();
  const thread = selectSidebarThreadSummaryByRef(state, target);
  const project = thread
    ? selectProjectByRef(state, {
        environmentId: target.environmentId,
        projectId: thread.projectId,
      })
    : null;
  if (!connection || !generation || !api || !thread || !project) return null;
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
    threadRevision: sidebarUndoThreadRevision(thread),
    parentRevision: project,
    threadTitle: thread.title,
    supported:
      readEnvironmentServerConfig(target.environmentId)?.environment.capabilities
        .threadSidebarUndo === true,
  };
}
export const sidebarUndo = createSidebarUndoHistory({
  readContext: readMobileSidebarUndoContext,
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
