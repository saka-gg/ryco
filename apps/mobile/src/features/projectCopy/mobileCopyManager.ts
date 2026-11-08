import {
  createInMemoryProjectCopyClaims,
  createProjectCopyManager,
  type ProjectCopyEntry,
  type ProjectCopyResumeRequest,
  type ProjectCopyRuntime,
  type ProjectCopyStoreState,
} from "@ryco/client-runtime/projectCopy/manager";
import type { ProjectCopyView } from "@ryco/client-runtime/projectCopy/progressView";
import type { ProjectCopyJobRecord } from "@ryco/client-runtime/projectCopy";
import {
  COPY_DESTINATIONS_STORAGE_KEY,
  createCopyDestinationMemory,
  RememberedCopyDestinations,
} from "@ryco/client-runtime/projectCopy/destinationMemory";
import * as Schema from "effect/Schema";
import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { useStore as useZustandStore } from "zustand";

import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { readEnvironmentServerConfig } from "../../state/environmentServerConfigs";
import { selectProjectByRef, useStore } from "../../state/threadsRuntime";
import { mobileProjectCopyAcquire, subscribeMobileNodeConnections } from "./mobileAcquireNode";
import { readMobileNodeCatalog, subscribeMobileNodeCatalog } from "./mobileNodeCatalog";

/**
 * The phone's project copy manager: the shared manager
 * (`@ryco/client-runtime/projectCopy/manager`) bound to the phone's storage
 * (the sqlite key-value store, read synchronously), its node catalog and node
 * acquisition, and one in-app notice for a copy the copy screen no longer
 * shows. One app instance runs the copies, so claims stay in memory.
 */

const RECORDS_KEY = "ryco.projectCopy.records";
const STARTS_KEY = "ryco.projectCopy.agentControlStarts";

function readJson(key: string): unknown {
  const raw = Storage.getItemSync(key);
  return raw === null ? [] : (JSON.parse(raw) as unknown);
}

function writeJson(key: string, value: unknown): void {
  Storage.setItemSync(key, JSON.stringify(value));
}

/**
 * Where each checkout was last copied to (the destination and a parent folder
 * the user picked), so the copy screen preselects it and a stopped copy
 * resumes into the same folder.
 */
export const copyDestinationMemory = createCopyDestinationMemory({
  read: () => {
    const raw = Storage.getItemSync(COPY_DESTINATIONS_STORAGE_KEY);
    return raw === null
      ? null
      : Schema.decodeSync(Schema.fromJsonString(RememberedCopyDestinations))(raw);
  },
  write: (entries) =>
    Storage.setItemSync(
      COPY_DESTINATIONS_STORAGE_KEY,
      Schema.encodeSync(Schema.fromJsonString(RememberedCopyDestinations))(entries),
    ),
});

/** The copy that tells the user how it goes outside the copy screen, with what tapping it does. */
export interface ProjectCopyNotice {
  readonly copyId: string;
  readonly view: ProjectCopyView | { readonly title: string; readonly description: string };
  readonly kind: "progress" | "result" | "interrupted";
  readonly primary: { readonly label: string; readonly run: () => void } | null;
  readonly secondary: { readonly label: string; readonly run: () => void } | null;
}

let notice: ProjectCopyNotice | null = null;
const noticeListeners = new Set<() => void>();

function setNotice(next: ProjectCopyNotice | null): void {
  notice = next;
  for (const listener of Array.from(noticeListeners)) listener();
}

function subscribeNotice(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

/** The current copy notice, subscribed. */
export function useProjectCopyNotice(): ProjectCopyNotice | null {
  return useSyncExternalStore(
    subscribeNotice,
    () => notice,
    () => notice,
  );
}

export function dismissProjectCopyNotice(): void {
  setNotice(null);
}

/** Opens the copy screen on a copy (the notice's tap target); the root host registers it. */
let openCopyScreen: ((copyId: string) => void) | null = null;
let openStoppedCopy: ((request: ProjectCopyResumeRequest) => void) | null = null;

export function registerProjectCopyNavigation(input: {
  readonly openCopy: (copyId: string) => void;
  /** Opens the copy screen on a stopped copy, on its own checkout and destination. */
  readonly openStopped: (request: ProjectCopyResumeRequest) => void;
}): () => void {
  openCopyScreen = input.openCopy;
  openStoppedCopy = input.openStopped;
  return () => {
    if (openCopyScreen === input.openCopy) openCopyScreen = null;
    if (openStoppedCopy === input.openStopped) openStoppedCopy = null;
  };
}

function loadMobileRuntime(): Promise<ProjectCopyRuntime> {
  return Promise.all([
    import("@ryco/client-runtime/projectCopy"),
    import("@ryco/client-runtime/projectCopy/nodeIo"),
  ]).then(([coordinator, nodeIo]) => ({
    startProjectCopy: coordinator.startProjectCopy,
    projectCopyPlanWithSendFiles: coordinator.projectCopyPlanWithSendFiles,
    createIo: () => createMobileProjectCopyIo(nodeIo.createProjectCopyNodeIo),
    callNodeWithLease: (environmentId, call, options) =>
      nodeIo.callNodeWithLease(environmentId, call, {
        ...options,
        acquire: mobileProjectCopyAcquire,
      }),
    callNodeToRead: (environmentId, call, options) =>
      nodeIo.callNodeToRead(environmentId, call, { ...options, acquire: mobileProjectCopyAcquire }),
    rebuildAgentControlPlan: (record, context) =>
      import("./mobileAgentControlCopy").then((module) =>
        module.rebuildMobileAgentControlCopyPlan(record, context),
      ),
  }));
}

/** One copy's node IO on the phone. */
export function createMobileProjectCopyIo(
  create: typeof import("@ryco/client-runtime/projectCopy/nodeIo").createProjectCopyNodeIo,
) {
  return create({
    acquire: mobileProjectCopyAcquire,
    readApi: readEnvironmentApi,
    readCachedConfig: readEnvironmentServerConfig,
    subscribeConnections: subscribeMobileNodeConnections,
    uuid: uuidv4,
  });
}

const manager = createProjectCopyManager({
  storage: {
    readRecords: () => readJson(RECORDS_KEY),
    writeRecords: (records) => writeJson(RECORDS_KEY, records),
    readStarts: () => readJson(STARTS_KEY),
    writeStarts: (starts) => writeJson(STARTS_KEY, starts),
  },
  claims: createInMemoryProjectCopyClaims(),
  loadRuntime: loadMobileRuntime,
  nodes: { read: () => readMobileNodeCatalog().nodes, subscribe: subscribeMobileNodeCatalog },
  readProject: (ref) => selectProjectByRef(useStore.getState(), ref) ?? null,
  notices: {
    showProgress: (copyId, view) =>
      setNotice({
        copyId,
        view,
        kind: "progress",
        primary: { label: "Show", run: () => openCopyScreen?.(copyId) },
        secondary: null,
      }),
    showResult: (copyId, view, actions) =>
      setNotice({
        copyId,
        view,
        kind: "result",
        primary: actions.onView
          ? { label: "Open", run: actions.onView }
          : actions.onRetry
            ? { label: view.retryLabel ?? "Retry", run: actions.onRetry }
            : null,
        secondary: null,
      }),
    showInterrupted: (copyId, text, actions) =>
      setNotice({
        copyId,
        view: text,
        kind: "interrupted",
        primary: { label: "Resume", run: actions.onResume },
        secondary: { label: "Discard", run: actions.onDiscard },
      }),
    dismiss: (copyId) => {
      if (notice?.copyId === copyId) setNotice(null);
    },
  },
  openInterruptedCopy: (request) => openStoppedCopy?.(request),
  uuid: uuidv4,
});

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
} = manager;

function useProjectCopyStore<T>(selector: (state: ProjectCopyStoreState) => T): T {
  return useZustandStore(manager.store, selector);
}

export function useProjectCopyEntry(copyId: string | null): ProjectCopyEntry | null {
  return useProjectCopyStore((state) => (copyId ? (state.entries[copyId] ?? null) : null));
}

export function useProjectCopyEntries(): Readonly<Record<string, ProjectCopyEntry>> {
  return useProjectCopyStore((state) => state.entries);
}

export function useProjectCopyRecords(): ReadonlyArray<ProjectCopyJobRecord> {
  return useProjectCopyStore((state) => state.records);
}
