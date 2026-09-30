import { parseScopedThreadKey, scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { type ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { readEnvironmentApi } from "../environmentApi";
import { sidebarUndo } from "../sidebarUndo";
import { newCommandId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { selectThreadByRef, selectThreadsForEnvironment, useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "./useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

type DeleteThreadOptions = {
  deletedThreadKeys?: ReadonlySet<string>;
  optimistic?: boolean;
};

export function useThreadActions() {
  const sidebarThreadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
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

  const deleteThread = useCallback(
    async (target: ScopedThreadRef, opts: DeleteThreadOptions = {}) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
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
      const dispatchDelete = api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      });

      if (opts.optimistic) {
        // Fire WS delete first so the network round-trip parallelizes
        // with the route switch / local cleanup. Errors surface via toast;
        // the local state stays cleared (matches existing behavior).
        void dispatchDelete.catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
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
          clearComposerDraftForThread(threadRef);
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
        return;
      }

      await dispatchDelete;
      clearComposerDraftForThread(threadRef);
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
            return;
          }
        }
        await router.navigate({ to: "/", replace: true });
      }
    },
    [
      clearComposerDraftForThread,
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
        const confirmed = await localApi.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  return {
    archiveThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
  };
}
