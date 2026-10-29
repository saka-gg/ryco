import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationShellStreamEvent,
  OrchestrationStubbedShellSnapshot,
  OrchestrationThreadShell,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@ryco/contracts";

import type { ShellStoreUpdate } from "../state/threads/store.ts";

/**
 * App-owned presentation writes performed by the connection supervisor.
 * The hosted readiness handlers deliberately do not belong here: hosted lifecycle
 * ownership and its generation fencing remain a separate interface.
 */
export interface EnvironmentStateSink {
  /**
   * Applies one environment's shell updates in arrival order as a single store
   * commit. Returns one context per update, in order, each computed against
   * the state that update applies to; the supervisor hands an event's context
   * to `afterShellEventApplied` once the whole batch is applied.
   */
  readonly applyShellEvents: (
    environmentId: EnvironmentId,
    events: ReadonlyArray<ShellStoreUpdate>,
  ) => ReadonlyArray<unknown>;
  readonly afterShellEventApplied: (
    environmentId: EnvironmentId,
    event: OrchestrationShellStreamEvent,
    context: unknown,
  ) => void;
  readonly applyOrchestrationEvents: (
    environmentId: EnvironmentId,
    events: ReadonlyArray<OrchestrationEvent>,
  ) => void;
  readonly syncServerShellSnapshot: (
    environmentId: EnvironmentId,
    snapshot: OrchestrationStubbedShellSnapshot,
  ) => void;
  /**
   * Whether the store holds the thread as an archived stub. With
   * `applyLoadedThreadShells`, lets the supervisor load the full shell of a
   * stubbed thread that is opened. Absent, stubs stay stubs.
   */
  readonly isArchivedThreadStub?: (environmentId: EnvironmentId, threadId: ThreadId) => boolean;
  /** Full shells loaded on demand for stubs; see the store's `applyLoadedThreadShells`. */
  readonly applyLoadedThreadShells?: (
    environmentId: EnvironmentId,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) => void;
  readonly reconcileSnapshotDerivedState: () => void;
  readonly syncProjects: (environmentId: EnvironmentId) => void;
  readonly syncThreads: (environmentId: EnvironmentId) => void;
  readonly clearThreadDraft: (ref: ScopedThreadRef) => void;
  readonly clearProjectDraftThread: (ref: ScopedProjectRef) => void;
  readonly clearTerminalState: (ref: ScopedThreadRef) => void;
  readonly markProviderInvalidationNeeded: () => void;
  readonly flushProviderInvalidation: () => void;
}
