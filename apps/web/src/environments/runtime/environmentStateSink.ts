import type {
  EnvironmentStateSink,
  EnvironmentConnectionSupervisor,
} from "@ryco/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { isArchivedThreadStub } from "@ryco/client-runtime/state/threads";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { getClientSettings } from "~/hooks/useSettings";
import { evictCheckpointDiffsForThread } from "~/rpc/providerAtoms";
import { collectActiveTerminalThreadIds } from "~/lib/terminalStateCleanup";
import { deriveLogicalProjectKeyFromSettings, derivePhysicalProjectKey } from "~/logicalProject";
import {
  useStore,
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
} from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore, type UiSyncScope } from "~/uiStateStore";

function readUiSyncScope(): UiSyncScope {
  return {
    authoritativeEnvironmentIds: new Set(
      Object.entries(useStore.getState().environmentStateById)
        .filter(([, state]) => state.bootstrapComplete)
        .map(([environmentId]) => environmentId),
    ),
  };
}

/** Web presentation adapter. Every operation preserves the former store-write order. */
export function createWebEnvironmentStateSink(input: {
  readonly markProviderInvalidationNeeded: () => void;
  readonly flushProviderInvalidation: () => void;
  readonly supervisor?: () => Pick<
    EnvironmentConnectionSupervisor,
    | "disposeThreadDetailSubscription"
    | "evictIdleThreadDetailSubscriptionsToCapacity"
    | "reconcileThreadDetailSubscriptionEvictionForEnvironment"
    | "reconcileThreadDetailSubscriptionEvictionForThread"
  >;
}): EnvironmentStateSink {
  return {
    applyShellEvents: (environmentId, events) =>
      useStore.getState().applyShellEvents(events, environmentId, (state, event) => {
        const threadId =
          event.kind === "thread-upserted"
            ? event.thread.id
            : event.kind === "thread-removed"
              ? event.threadId
              : null;
        const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
        // The stored shell is enough to tell a new thread and an archive flip
        // apart; deriving the full thread (messages, activities) is not needed.
        return {
          previousThread: threadId
            ? selectEnvironmentState(state, environmentId).threadShellById[threadId]
            : undefined,
          threadRef,
        };
      }),
    afterShellEventApplied: (environmentId, event, context) => {
      const { previousThread, threadRef } = context as {
        readonly previousThread: { readonly archivedAt: string | null } | undefined;
        readonly threadRef: ReturnType<typeof scopeThreadRef> | null;
      };
      switch (event.kind) {
        case "project-upserted":
        case "project-removed":
          syncProjectUiFromStore();
          return;
        case "worktree-upserted":
        case "worktree-removed":
          return;
        case "thread-upserted":
          // Streaming bumps the same thread ~30x/s. Only a new thread changes
          // the thread set; an update needs at most its own visited seed, so
          // skip the O(threads x drafts) full UI sync for it.
          if (!previousThread) {
            syncThreadUiFromStore();
          } else if (threadRef) {
            useUiStateStore
              .getState()
              .seedThreadVisitedAt(
                scopedThreadKey(threadRef),
                event.thread.updatedAt ?? event.thread.createdAt,
              );
          }
          if (!previousThread && threadRef) markPromotedDraftThreadByRef(threadRef);
          if (
            previousThread?.archivedAt === null &&
            event.thread.archivedAt !== null &&
            threadRef
          ) {
            useTerminalStateStore.getState().removeTerminalState(threadRef);
            evictCheckpointDiffsForThread(event.thread.id);
          }
          input
            .supervisor?.()
            .reconcileThreadDetailSubscriptionEvictionForThread(environmentId, event.thread.id);
          input.supervisor?.().evictIdleThreadDetailSubscriptionsToCapacity();
          return;
        case "thread-removed":
          if (threadRef) {
            input.supervisor?.().disposeThreadDetailSubscription(environmentId, event.threadId);
            useComposerDraftStore.getState().clearDraftThread(threadRef);
            useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
            useTerminalStateStore.getState().removeTerminalState(threadRef);
            evictCheckpointDiffsForThread(event.threadId);
          }
          syncThreadUiFromStore();
      }
    },
    applyOrchestrationEvents: (environmentId, events) =>
      useStore.getState().applyOrchestrationEvents(events, environmentId),
    syncServerShellSnapshot: (environmentId, snapshot) =>
      useStore.getState().syncServerShellSnapshot(snapshot, environmentId),
    isArchivedThreadStub: (environmentId, threadId) =>
      isArchivedThreadStub(
        selectEnvironmentState(useStore.getState(), environmentId).threadShellById[threadId],
      ),
    applyLoadedThreadShells: (environmentId, threads) =>
      useStore.getState().applyLoadedThreadShells(threads, environmentId),
    reconcileSnapshotDerivedState: () => {
      syncProjectUiFromStore();
      syncThreadUiFromStore();
      const threads = selectThreadShellsAcrossEnvironments(useStore.getState());
      const activeThreadKeys = collectActiveTerminalThreadIds({
        snapshotThreads: threads.map((thread) => ({
          key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          deletedAt: null,
          archivedAt: thread.archivedAt,
        })),
        draftThreadKeys: useComposerDraftStore.getState().listDraftThreadKeys(),
      });
      useTerminalStateStore.getState().removeOrphanedTerminalStates(activeThreadKeys);
    },
    syncProjects: syncProjectUiFromStore,
    syncThreads: syncThreadUiFromStore,
    clearThreadDraft: (ref) => {
      useComposerDraftStore.getState().clearDraftThread(ref);
      useUiStateStore.getState().clearThreadUi(scopedThreadKey(ref));
    },
    clearProjectDraftThread: (ref) =>
      useComposerDraftStore.getState().clearProjectDraftThreadId(ref),
    clearTerminalState: (ref) => useTerminalStateStore.getState().removeTerminalState(ref),
    markProviderInvalidationNeeded: input.markProviderInvalidationNeeded,
    flushProviderInvalidation: input.flushProviderInvalidation,
  };
}

function syncProjectUiFromStore() {
  const projects = selectProjectsAcrossEnvironments(useStore.getState());
  const clientSettings = getClientSettings();
  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
      cwd: project.cwd,
    })),
    readUiSyncScope(),
  );
}

function syncThreadUiFromStore() {
  // Shells carry the key and timestamps; deriving full threads is not needed.
  const threads = selectThreadShellsAcrossEnvironments(useStore.getState());
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
    readUiSyncScope(),
  );
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );
}
