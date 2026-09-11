import type {
  EnvironmentStateSink,
  EnvironmentConnectionSupervisor,
} from "@ryco/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { getClientSettings } from "~/hooks/useSettings";
import { collectActiveTerminalThreadIds } from "~/lib/terminalStateCleanup";
import { deriveLogicalProjectKeyFromSettings, derivePhysicalProjectKey } from "~/logicalProject";
import {
  useStore,
  selectProjectsAcrossEnvironments,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
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
    prepareShellEvent: (environmentId, event) => {
      const threadId =
        event.kind === "thread-upserted"
          ? event.thread.id
          : event.kind === "thread-removed"
            ? event.threadId
            : null;
      const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
      return {
        previousThread: threadRef ? selectThreadByRef(useStore.getState(), threadRef) : undefined,
        threadRef,
      };
    },
    applyShellEvent: (environmentId, event) =>
      useStore.getState().applyShellEvent(event, environmentId),
    afterShellEventApplied: (environmentId, event, context) => {
      const { previousThread, threadRef } = context as {
        readonly previousThread: ReturnType<typeof selectThreadByRef> | undefined;
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
          syncThreadUiFromStore();
          if (!previousThread && threadRef) markPromotedDraftThreadByRef(threadRef);
          if (
            previousThread?.archivedAt === null &&
            event.thread.archivedAt !== null &&
            threadRef
          ) {
            useTerminalStateStore.getState().removeTerminalState(threadRef);
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
          }
          syncThreadUiFromStore();
      }
    },
    applyOrchestrationEvents: (environmentId, events) =>
      useStore.getState().applyOrchestrationEvents(events, environmentId),
    syncServerShellSnapshot: (environmentId, snapshot) =>
      useStore.getState().syncServerShellSnapshot(snapshot, environmentId),
    reconcileSnapshotDerivedState: () => {
      syncProjectUiFromStore();
      syncThreadUiFromStore();
      const threads = selectThreadsAcrossEnvironments(useStore.getState());
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
  const threads = selectThreadsAcrossEnvironments(useStore.getState());
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
