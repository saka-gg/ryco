// FILE: copyManager.ts
// Purpose: The web client's project copy manager: the shared manager
//          (`@ryco/client-runtime/projectCopy/manager`) bound to this client's
//          storage (localStorage, shared by the windows of a direct or Desktop
//          build), its window claims (Web Locks), the node catalog, the toasts,
//          the sidebar's badge of the checkouts being copied, and the leave
//          guard that asks before a browser tab closes while an upload still
//          needs it.
// Layer: Web copy runtime, a module-level singleton loaded on demand. The
//        coordinator (`@ryco/client-runtime/projectCopy` run/plan) and the
//        node IO load with the first copy; reading the store and the records
//        does not load them.

import {
  createProjectCopyManager,
  type ProjectCopyManager,
  projectCopyBadges,
  projectCopyNeedsClient,
  type ProjectCopyEntry,
  type ProjectCopyRuntime,
  type ProjectCopyStoreState,
} from "@ryco/client-runtime/projectCopy/manager";
import type { ProjectCopyJobRecord } from "@ryco/client-runtime/projectCopy";
import * as Schema from "effect/Schema";
import { useStore as useZustandStore } from "zustand";

import { isElectron } from "../../../env";
import { readNodeCatalogSnapshot, subscribeNodeCatalog } from "../../../environments/nodeCatalog";
import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";
import { randomUUID } from "../../../lib/utils";
import { selectProjectByRef, useStore } from "../../../store";
import {
  PROJECT_COPY_RECORDS_STORAGE_KEY,
  PROJECT_COPY_STARTS_STORAGE_KEY,
} from "../projectCopyStorage";
import { openCopyProject } from "../projectNodesDialogStore";
import { markProjectCopiesActive, publishProjectCopyBadges } from "../projectNodesShellActions";
import { createProjectCopyClaims } from "./projectCopyClaims";
import {
  dismissProjectCopyToast,
  showProjectCopyInterruptedToast,
  showProjectCopyProgressToast,
  showProjectCopyResultToast,
} from "./projectCopyToasts";

export {
  PROJECT_COPY_PROGRESS_INTERVAL_MS,
  type AgentControlCopyStartHold,
  type ManagedProjectCopy,
  type ProjectCopyAgentControlContext,
  type ProjectCopyEntry,
  type ProjectCopyPlanRebuilder,
  type ProjectCopyRuntime,
  type ProjectCopyStoreState,
  type ProjectCopyViewer,
  type RetryProjectCopyOptions,
  type StartProjectCopyOptions,
  type TrackProjectImportInput,
} from "@ryco/client-runtime/projectCopy/manager";

const StoredValue = Schema.Unknown;

/** The coordinator and this client's node IO, loaded with the first copy. */
function loadWebRuntime(): Promise<ProjectCopyRuntime> {
  return Promise.all([
    import("@ryco/client-runtime/projectCopy"),
    import("./webProjectCopyIo"),
  ]).then(([coordinator, io]): ProjectCopyRuntime => ({
    startProjectCopy: coordinator.startProjectCopy,
    projectCopyPlanWithSendFiles: coordinator.projectCopyPlanWithSendFiles,
    createIo: () => io.createWebProjectCopyIo(),
    callNodeWithLease: io.callNodeWithLease,
    callNodeToRead: io.callNodeToRead,
    // Loaded only when a resumed Agent Control copy needs its plan back.
    rebuildAgentControlPlan: (record, context) =>
      import("../agentControlCopyExecutor").then((executor) =>
        executor.rebuildAgentControlCopyPlan(record, context),
      ),
  }));
}

const manager: ProjectCopyManager = createProjectCopyManager({
  storage: {
    readRecords: () => getLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, StoredValue),
    writeRecords: (records) =>
      setLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, records, StoredValue),
    readStarts: () => getLocalStorageItem(PROJECT_COPY_STARTS_STORAGE_KEY, StoredValue),
    writeStarts: (starts) =>
      setLocalStorageItem(PROJECT_COPY_STARTS_STORAGE_KEY, starts, StoredValue),
  },
  claims: createProjectCopyClaims(),
  loadRuntime: loadWebRuntime,
  nodes: {
    read: () => readNodeCatalogSnapshot().nodes,
    subscribe: subscribeNodeCatalog,
  },
  readProject: (ref) => selectProjectByRef(useStore.getState(), ref) ?? null,
  notices: {
    showProgress: showProjectCopyProgressToast,
    showResult: showProjectCopyResultToast,
    showInterrupted: showProjectCopyInterruptedToast,
    dismiss: dismissProjectCopyToast,
  },
  openInterruptedCopy: (request) =>
    openCopyProject({
      source: request.source,
      targetEnvironmentId: request.targetEnvironmentId,
      origin: "projects-page",
      resumeCopyId: request.resumeCopyId,
    }),
  onCopiesActive: markProjectCopiesActive,
  uuid: randomUUID,
});

type BoundStore = {
  <T>(selector: (state: ProjectCopyStoreState) => T): T;
} & typeof manager.store;

function useBoundProjectCopyStore<T>(selector: (state: ProjectCopyStoreState) => T): T {
  return useZustandStore(manager.store, selector);
}

/** The manager's store as a hook, with `getState` / `setState` / `subscribe` on it. */
export const useProjectCopyStore: BoundStore = Object.assign(
  useBoundProjectCopyStore,
  manager.store,
);

export const {
  startManagedProjectCopy,
  trackProjectImport,
  cancelProjectCopy,
  detachProjectCopy,
  runProjectCopyInBackground,
  showProjectCopyProgress,
  retryProjectCopy,
  resumeProjectCopy,
  forgetProjectCopy,
  holdAgentControlCopyStart,
  resumeProjectCopies,
  projectCopyResumesInDialog,
  readProjectCopyRecord,
  openInterruptedProjectCopy,
  discardProjectCopy,
  registerProjectCopyViewer,
  viewCopiedProject,
  readProjectCopyEntry,
  setProjectCopyRuntimeForTests,
  setProjectCopyClaimsForTests,
  resetProjectCopyManagerForTests,
} = manager;

// Another window's changes show here too (the Copies block).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== PROJECT_COPY_RECORDS_STORAGE_KEY) return;
    manager.reloadStoredRecords();
  });
}

// ── Closing the window during an upload ──

const confirmLeavingDuringUpload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};
let leaveGuardInstalled = false;

/**
 * Asks before the browser closes or reloads the tab while an upload needs it.
 * Desktop windows are left alone: Electron would cancel the close without
 * asking, and the copy is offered again on the next start anyway.
 */
function syncLeaveGuard(entries: Readonly<Record<string, ProjectCopyEntry>>): void {
  if (typeof window === "undefined" || isElectron) return;
  const wanted = projectCopyNeedsClient(entries);
  if (wanted === leaveGuardInstalled) return;
  leaveGuardInstalled = wanted;
  if (wanted) window.addEventListener("beforeunload", confirmLeavingDuringUpload);
  else window.removeEventListener("beforeunload", confirmLeavingDuringUpload);
}

manager.store.subscribe((state, previous) => {
  if (state.entries === previous.entries) return;
  publishProjectCopyBadges(projectCopyBadges(state.entries));
  syncLeaveGuard(state.entries);
});

// ── Reading ──

export function useProjectCopyEntry(copyId: string | null): ProjectCopyEntry | null {
  return useProjectCopyStore((state) => (copyId ? (state.entries[copyId] ?? null) : null));
}

export function useProjectCopyEntries(): Readonly<Record<string, ProjectCopyEntry>> {
  return useProjectCopyStore((state) => state.entries);
}

export function useProjectCopyRecords(): ReadonlyArray<ProjectCopyJobRecord> {
  return useProjectCopyStore((state) => state.records);
}
