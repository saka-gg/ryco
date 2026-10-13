import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import { type ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { THREAD_DELETE_UNDO_MS } from "@ryco/shared/workspaceLifecycle";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import {
  getFallbackThreadIdAfterDelete,
  shouldConfirmSidebarThreadSelectionDelete,
} from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { readEnvironmentApi } from "../environmentApi";
import { sidebarUndo } from "../sidebarUndo";
import { undoThreadDeletes } from "../threadDeleteUndo";
import { newCommandId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsForEnvironment,
  useStore,
} from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "./useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

type DeleteThreadOptions = {
  /** Every thread deleted alongside this one, so the fallback route skips them too. */
  deletedThreadKeys?: ReadonlySet<string>;
  optimistic?: boolean;
  /** False when the caller shows one Undo toast for a whole selection. */
  notify?: boolean;
};

/** A thread the server accepted for deletion; Undo restores it until the grace period ends. */
export interface DeletedThread {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}

export type DeleteThread = (
  target: ScopedThreadRef,
  opts?: DeleteThreadOptions,
) => Promise<DeletedThread | null>;

const errorDescription = (error: unknown) =>
  error instanceof Error ? error.message : "An error occurred.";

/** One toast per delete action (a single thread or a whole selection), with Undo for all of it. */
function presentThreadDeleteToast(deleted: readonly DeletedThread[]): void {
  if (deleted.length === 0) return;
  const single = deleted.length === 1 ? deleted[0] : undefined;
  toastManager.add({
    type: "success",
    title: single ? `Deleted "${single.title}"` : `Deleted ${deleted.length} conversations`,
    timeout: THREAD_DELETE_UNDO_MS,
    actionProps: {
      children: "Undo",
      onClick: () =>
        void Promise.all(
          deleted.map((entry) =>
            undoThreadDeletes(entry.threadRef.environmentId, [entry.threadRef.threadId]),
          ),
        ).catch((error: unknown) =>
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: single ? "Failed to restore conversation" : "Failed to restore conversations",
              description: errorDescription(error),
            }),
          ),
        ),
    },
  });
}

/**
 * Deletes a selection in order with one Undo toast. Threads the server
 * accepted before a failure stay deleted (and undoable); the failure is shown.
 */
export async function deleteThreadSelection(
  deleteThread: DeleteThread,
  targets: readonly ScopedThreadRef[],
): Promise<void> {
  const deletedThreadKeys = new Set(targets.map(scopedThreadKey));
  const deleted: DeletedThread[] = [];
  try {
    for (const target of targets) {
      const result = await deleteThread(target, { deletedThreadKeys, notify: false });
      if (result) deleted.push(result);
    }
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to delete conversation",
        description: errorDescription(error),
      }),
    );
  } finally {
    presentThreadDeleteToast(deleted);
  }
}

export function useThreadActions() {
  const sidebarThreadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const router = useRouter();
  const { handleNewThread } = useNewThreadHandler();
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const state = useStore.getState();
    const thread = selectThreadByRef(state, target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const archiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      const { thread, threadRef } = resolved;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        throw new Error("Cannot archive a running thread.");
      }

      await sidebarUndo.archive(threadRef, newCommandId(), {
        currentRoute: () => router.state.location.href,
        shouldLeave: () => {
          const current = getCurrentRouteThreadRef();
          return (
            current?.threadId === threadRef.threadId &&
            current.environmentId === threadRef.environmentId
          );
        },
        leave: async () => {
          await handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId));
          return router.state.location.href;
        },
        reopen: () =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          }),
      });
    },
    [getCurrentRouteThreadRef, resolveThreadTarget, router],
  );

  const unarchiveThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
  }, []);

  /** Stops the provider runtime; the conversation and its terminal history stay. */
  const stopThreadSession = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.session.stop",
        commandId: newCommandId(),
        threadId: target.threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to stop session",
          description: errorDescription(error),
        }),
      );
    }
  }, []);

  /** Stops the current generation only; nothing else changes. */
  const interruptThreadTurn = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: target.threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to interrupt turn",
          description: errorDescription(error),
        }),
      );
    }
  }, []);

  /**
   * Deletes a thread: the server hides it everywhere at once and purges it,
   * attachments and terminal history included, after `THREAD_DELETE_GRACE_MS`.
   * Until then the toast's Undo restores it. Confirmation is the caller's.
   */
  const deleteThread = useCallback<DeleteThread>(
    async (target, opts = {}) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return null;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return null;
      const { thread, threadRef } = resolved;
      const threads = selectThreadsForEnvironment(useStore.getState(), threadRef.environmentId);
      const deletedIds =
        opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
          ? new Set<ThreadId>(
              [...opts.deletedThreadKeys].flatMap((threadKey) => {
                const ref = parseScopedThreadKey(threadKey);
                return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
              }),
            )
          : undefined;

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToFallback =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadRef.threadId,
        deletedThreadIds: deletedIds ?? new Set<ThreadId>(),
        sortOrder: sidebarThreadSortOrder,
      });
      const dispatchDelete = api.orchestration
        .dispatchCommand({
          type: "thread.trash",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
        })
        .then((): DeletedThread => {
          const deleted = { threadRef, title: thread.title };
          if (opts.notify !== false) presentThreadDeleteToast([deleted]);
          return deleted;
        });

      if (opts.optimistic) {
        // Fire the WS command first so the network round-trip parallelizes
        // with the route switch / local cleanup. Errors surface via toast;
        // the shell stream restores the row if the server refused.
        void dispatchDelete.catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete conversation",
              description: errorDescription(error),
            }),
          );
        });

        // Resolve the fallback ref before mutating the store; once
        // removeThread runs the deleted thread is gone from selectors.
        let navigateTarget: { kind: "fallback"; ref: ScopedThreadRef } | { kind: "home" } | null =
          null;
        if (shouldNavigateToFallback) {
          if (fallbackThreadId) {
            const fallbackThread = selectThreadByRef(
              useStore.getState(),
              scopeThreadRef(threadRef.environmentId, fallbackThreadId),
            );
            navigateTarget = fallbackThread
              ? {
                  kind: "fallback",
                  ref: scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
                }
              : { kind: "home" };
          } else {
            navigateTarget = { kind: "home" };
          }
        }

        const cleanupDeletedThread = () => {
          useStore.getState().removeThread(threadRef);
          clearProjectDraftThreadById(
            scopeProjectRef(threadRef.environmentId, thread.projectId),
            threadRef,
          );
          clearTerminalState(threadRef);
        };

        if (navigateTarget) {
          // Kick off without awaiting — the click handler returns
          // immediately. For the active thread, defer local removal until
          // after navigation has had a chance to paint; removing the mounted
          // active thread first forces ChatView to reconcile a missing heavy
          // thread and makes close feel frozen.
          if (navigateTarget.kind === "fallback") {
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(navigateTarget.ref),
              replace: true,
            });
          } else {
            void router.navigate({ to: "/", replace: true });
          }
          requestAnimationFrame(() => {
            setTimeout(cleanupDeletedThread, 0);
          });
        } else {
          cleanupDeletedThread();
        }
        return null;
      }

      const deleted = await dispatchDelete;
      clearProjectDraftThreadById(
        scopeProjectRef(threadRef.environmentId, thread.projectId),
        threadRef,
      );
      clearTerminalState(threadRef);

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          const fallbackThread = selectThreadByRef(
            useStore.getState(),
            scopeThreadRef(threadRef.environmentId, fallbackThreadId),
          );
          if (fallbackThread) {
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            });
            return deleted;
          }
        }
        await router.navigate({ to: "/", replace: true });
      }
      return deleted;
    },
    [
      clearProjectDraftThreadById,
      clearTerminalState,
      getCurrentRouteThreadRef,
      router,
      resolveThreadTarget,
      sidebarThreadSortOrder,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      const { thread } = resolved;

      if (confirmThreadDelete && localApi) {
        const confirmed = await localApi.dialogs.confirm(deleteConfirmationMessage([thread.title]));
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  /**
   * Deletes several threads after one confirmation (a multiple selection),
   * with one Undo toast. False when the reader declined, so the selection can stay.
   */
  const confirmAndDeleteThreads = useCallback(
    async (targets: readonly ScopedThreadRef[]): Promise<boolean> => {
      if (targets.length === 0) return true;
      const state = useStore.getState();
      const summaries = targets.map((target) => selectSidebarThreadSummaryByRef(state, target));
      const localApi = readLocalApi();
      if (
        localApi &&
        shouldConfirmSidebarThreadSelectionDelete({ confirmThreadDelete, threads: summaries })
      ) {
        const confirmed = await localApi.dialogs.confirm(
          deleteConfirmationMessage(summaries.map((summary) => summary?.title ?? "")),
        );
        if (!confirmed) return false;
      }
      await deleteThreadSelection(deleteThread, targets);
      return true;
    },
    [confirmThreadDelete, deleteThread],
  );

  return {
    archiveThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
    confirmAndDeleteThreads,
    stopThreadSession,
    interruptThreadTurn,
  };
}

/** Shared by every Delete confirmation (single row, menu, multi-select). */
export function deleteConfirmationMessage(titles: ReadonlyArray<string>): string {
  const subject = titles.length === 1 ? `"${titles[0]}"` : `${titles.length} conversations`;
  return `Delete ${subject}? You can undo for a few seconds; after that it's gone for good, including attachments and terminal history.`;
}
