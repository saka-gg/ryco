import {
  createSidebarUndoHistory,
  sidebarUndoThreadRevision,
  type SidebarUndoNotice,
  type SidebarUndoLocalContext,
} from "@ryco/client-runtime/state/threads";
import { type ScopedThreadRef } from "@ryco/contracts";
import { readEnvironmentApi } from "./environmentApi";
import { readEnvironmentConnection, getSavedEnvironmentRuntimeState } from "./environments/runtime";
import { readPrimaryEnvironmentDescriptor } from "./environments/primary";
import { readHostedWorkspaceState } from "./hostedHub/hostedConnectionCoordinator";
import { isHostedHubMode } from "./env";
import { selectSidebarThreadSummaryByRef, selectProjectByRef, useStore } from "./store";
import { newCommandId } from "./lib/utils";
import { stackedThreadToast, toastManager } from "./components/ui/toast";

const labels = {
  archive: "Thread archived",
  settle: "Thread settled",
  snooze: "Thread snoozed",
  unpin: "Thread unpinned",
};
const visible = new Map<
  number,
  { toastId: ReturnType<typeof toastManager.add>; pending: boolean; applying: boolean | undefined }
>();
export function presentSidebarUndoNotices(notices: readonly SidebarUndoNotice[]) {
  for (const [id, entry] of visible) {
    if (!notices.some((notice) => notice.id === id)) {
      visible.delete(id);
      toastManager.close(entry.toastId);
    }
  }
  for (const notice of notices) {
    const previous = visible.get(notice.id);
    const options = stackedThreadToast({
      type: "info",
      title: notice.applying
        ? {
            archive: "Archiving thread…",
            settle: "Settling thread…",
            snooze: "Snoozing thread…",
            unpin: "Unpinning thread…",
          }[notice.action]
        : labels[notice.action],
      timeout: 0,
      description: notice.threadTitle,
      actionProps: {
        children: notice.pending ? "Undoing…" : "Undo",
        disabled: notice.pending,
        "aria-label": `Undo ${notice.action}${notice.threadTitle ? ` ${notice.threadTitle}` : ""}`,
        onClick: () => void sidebarUndo.undo(notice.id),
      },
      data: { onClose: () => sidebarUndo.dismiss(notice.id) },
    });
    if (!previous)
      visible.set(notice.id, {
        toastId: toastManager.add(options),
        pending: notice.pending,
        applying: notice.applying,
      });
    else if (previous.pending !== notice.pending || previous.applying !== notice.applying) {
      toastManager.update(previous.toastId, options);
      previous.pending = notice.pending;
      previous.applying = notice.applying;
    }
  }
}

export function readSidebarUndoLocalContext(
  target: ScopedThreadRef,
): SidebarUndoLocalContext | null {
  const state = useStore.getState();
  const thread = selectSidebarThreadSummaryByRef(state, target);
  const project = thread
    ? selectProjectByRef(state, {
        environmentId: target.environmentId,
        projectId: thread.projectId,
      })
    : null;
  if (!thread || !project) return null;
  return {
    threadRevision: sidebarUndoThreadRevision(thread),
    parentRevision: project,
    threadTitle: thread.title,
    subscribe: useStore.subscribe,
  };
}

export function readSidebarUndoContext(target: ScopedThreadRef) {
  const connection = readEnvironmentConnection(target.environmentId);
  const generation = connection?.shellSnapshotReadiness.read();
  const api = readEnvironmentApi(target.environmentId);
  const local = readSidebarUndoLocalContext(target);
  if (!connection || !generation || !api || !local) return null;
  const runtime = getSavedEnvironmentRuntimeState(target.environmentId);
  const primary = readPrimaryEnvironmentDescriptor();
  const supported =
    (primary?.environmentId === target.environmentId
      ? primary.capabilities
      : runtime.descriptor?.capabilities
    )?.threadSidebarUndo === true;
  if (isHostedHubMode()) {
    const machine = readHostedWorkspaceState().machines.find(
      (machine) => machine.environmentId === target.environmentId,
    );
    if (
      !machine?.canMutate ||
      machine.connectionState !== "connected" ||
      machine.cacheDisposition !== "available"
    )
      return null;
  }
  return {
    generation,
    api,
    threadRevision: local.threadRevision,
    parentRevision: local.parentRevision,
    threadTitle: local.threadTitle,
    supported,
  };
}

export const sidebarUndo = createSidebarUndoHistory({
  readContext: readSidebarUndoContext,
  readLocalContext: readSidebarUndoLocalContext,
  newCommandId,
  changed: presentSidebarUndoNotices,
  failed: (error) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not undo thread action",
        description:
          error instanceof Error
            ? error.message
            : "The request failed. Check the current thread state before trying again.",
      }),
    ),
});
