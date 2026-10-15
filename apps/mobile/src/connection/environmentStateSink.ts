import type {
  EnvironmentConnectionSupervisor,
  EnvironmentStateSink,
} from "@ryco/client-runtime/connection";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId } from "@ryco/contracts";

import { evictCheckpointDiffsForThread } from "../rpc/checkpointDiffAtoms";
import { markPromotedDraftThreadByRef, useComposerDraftStore } from "../state/composerDraftStore";
import { useTerminalStateStore } from "../state/terminalStateStore";
import { isArchivedThreadStub } from "@ryco/client-runtime/state/threads";
import { selectEnvironmentState, useStore } from "../state/threadsRuntime";

// The supervisor methods the sink drives from live shell events (§4). Threaded in
// as a getter (the supervisor is constructed after the sink), mirroring web's
// `supervisor: getEnvironmentSupervisor`.
type SinkSupervisor = Pick<
  EnvironmentConnectionSupervisor,
  | "disposeThreadDetailSubscription"
  | "evictIdleThreadDetailSubscriptionsToCapacity"
  | "reconcileThreadDetailSubscriptionEvictionForThread"
>;

interface ShellEventContext {
  /** The stored entry, an archived stub included: enough to tell a new thread and an archive flip. */
  readonly previousThread: { readonly archivedAt: string | null } | undefined;
  readonly threadRef: ReturnType<typeof scopeThreadRef> | null;
}

/**
 * Mobile presentation adapter for the connection supervisor — the RN analogue of
 * apps/web/src/environments/runtime/environmentStateSink.ts, minus the web
 * UI-store / provider-cache sync (there is no mobile UI store — §3-5). The core
 * apply/sync methods write shell snapshots and events into `state/threads`; live
 * thread events get the same promotion/cleanup/detail-eviction treatment as the
 * recovered-batch path in the driver (§4).
 */
export function createMobileEnvironmentStateSink(
  input: {
    readonly supervisor?: () => SinkSupervisor;
    // Wired by the driver to the checkpoint-diff cache invalidation throttle
    // (§6). Default no-ops keep the sink usable standalone (e.g. in tests).
    readonly markProviderInvalidationNeeded?: () => void;
    readonly flushProviderInvalidation?: () => void;
    // The snapshot-cache persistence seam (wave 2): fired for every projection
    // write this sink lands in the store, so the persistence layer can capture
    // the settled state debounced. Mobile-only by design — the client-runtime
    // sink interface stays untouched so web and desktop see no churn.
    readonly onEnvironmentProjectionChanged?: (environmentId: EnvironmentId) => void;
  } = {},
): EnvironmentStateSink {
  const projectionChanged = input.onEnvironmentProjectionChanged ?? (() => undefined);
  return {
    // Snapshot each event's pre-apply thread so afterShellEventApplied can tell
    // a freshly promoted draft (no previous thread) from an existing one.
    applyShellEvents: (environmentId, events) => {
      const contexts = useStore
        .getState()
        .applyShellEvents(events, environmentId, (state, event): ShellEventContext => {
          const threadId =
            event.kind === "thread-upserted"
              ? event.thread.id
              : event.kind === "thread-removed"
                ? event.threadId
                : null;
          const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
          return {
            previousThread: threadId
              ? selectEnvironmentState(state, environmentId).threadShellById[threadId]
              : undefined,
            threadRef,
          };
        });
      projectionChanged(environmentId);
      return contexts;
    },
    afterShellEventApplied: (environmentId, event, context) => {
      const { previousThread, threadRef } = context as ShellEventContext;
      switch (event.kind) {
        case "thread-upserted": {
          // A shell upsert for a thread that did not exist means a local draft was
          // promoted to a real server thread — re-key its composer draft.
          if (!previousThread && threadRef) markPromotedDraftThreadByRef(threadRef);
          // A thread that just became archived releases its terminal state and
          // its cached checkpoint diffs (one still on screen goes once released).
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
        }
        case "thread-removed": {
          if (threadRef) {
            input.supervisor?.().disposeThreadDetailSubscription(environmentId, event.threadId);
            useComposerDraftStore.getState().clearDraftThread(threadRef);
            useTerminalStateStore.getState().removeTerminalState(threadRef);
            evictCheckpointDiffsForThread(event.threadId);
          }
          return;
        }
        default:
          return;
      }
    },
    applyOrchestrationEvents: (environmentId, events) => {
      useStore.getState().applyOrchestrationEvents(events, environmentId);
      projectionChanged(environmentId);
    },
    syncServerShellSnapshot: (environmentId, snapshot) => {
      useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
      projectionChanged(environmentId);
    },
    isArchivedThreadStub: (environmentId, threadId) =>
      isArchivedThreadStub(
        selectEnvironmentState(useStore.getState(), environmentId).threadShellById[threadId],
      ),
    applyLoadedThreadShells: (environmentId, threads) => {
      useStore.getState().applyLoadedThreadShells(threads, environmentId);
      projectionChanged(environmentId);
    },
    // No mobile UI store and terminal GC is deferred (terminals are v1.1) — §3-5.
    reconcileSnapshotDerivedState: () => undefined,
    syncProjects: () => undefined,
    syncThreads: () => undefined,
    clearThreadDraft: (ref) => useComposerDraftStore.getState().clearDraftThread(ref),
    clearProjectDraftThread: (ref) =>
      useComposerDraftStore.getState().clearProjectDraftThreadId(ref),
    clearTerminalState: (ref) => useTerminalStateStore.getState().removeTerminalState(ref),
    // Wired by the driver to the checkpoint-diff cache once it exists (Task 5);
    // no-op standalone.
    markProviderInvalidationNeeded: input.markProviderInvalidationNeeded ?? (() => undefined),
    flushProviderInvalidation: input.flushProviderInvalidation ?? (() => undefined),
  };
}
