import type {
  EnvironmentId,
  OrchestrationGetThreadShellsInput,
  OrchestrationGetThreadShellsResult,
  OrchestrationThreadShell,
  ThreadId,
} from "@ryco/contracts";
import { ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS } from "@ryco/contracts/orchestration";

/** Where an environment's full shells load from: its current connection. */
export interface ArchivedThreadShellSource {
  /**
   * Identifies the connection. A response is applied only while the same
   * connection is still the environment's: a reconnect, a node switch or a
   * disconnect in between drops it.
   */
  readonly token: object;
  /** Absent on clients built without it. */
  readonly getThreadShells?:
    | ((input: OrchestrationGetThreadShellsInput) => Promise<OrchestrationGetThreadShellsResult>)
    | undefined;
}

export interface ArchivedThreadShellLoader {
  /**
   * Loads the full shell of a thread the store holds as an archived stub, such
   * as one the user opens. A no-op for a thread with a full shell (or none),
   * and while the same connection is already loading it. Requests of one
   * tick for one environment go out together.
   */
  readonly ensureFullShell: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  /** Forgets an environment's loads in flight; their responses are dropped. */
  readonly clearEnvironment: (environmentId: EnvironmentId) => void;
}

/** How many follow-up requests one load makes for ids a byte-bounded response left out. */
const MAX_REMAINING_ROUNDS = 8;

export function createArchivedThreadShellLoader(input: {
  readonly sourceFor: (environmentId: EnvironmentId) => ArchivedThreadShellSource | null;
  readonly isArchivedThreadStub: (environmentId: EnvironmentId, threadId: ThreadId) => boolean;
  readonly apply: (
    environmentId: EnvironmentId,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) => void;
  readonly onError?: (
    environmentId: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
    error: unknown,
  ) => void;
  readonly schedule?: (flush: () => void) => void;
}): ArchivedThreadShellLoader {
  const schedule = input.schedule ?? ((flush: () => void) => void Promise.resolve().then(flush));
  const onError =
    input.onError ??
    ((environmentId, threadIds, error) =>
      console.warn("Could not load archived thread shells", { environmentId, threadIds, error }));
  // Per environment: the connection the ids are being loaded from, and the ids.
  const inFlight = new Map<EnvironmentId, { token: object; threadIds: Set<ThreadId> }>();
  const queued = new Map<
    EnvironmentId,
    { source: ArchivedThreadShellSource; ids: Set<ThreadId> }
  >();

  const isCurrent = (environmentId: EnvironmentId, token: object) =>
    inFlight.get(environmentId)?.token === token && input.sourceFor(environmentId)?.token === token;

  const settle = (environmentId: EnvironmentId, token: object, threadIds: Iterable<ThreadId>) => {
    const loading = inFlight.get(environmentId);
    if (loading?.token !== token) return;
    for (const threadId of threadIds) loading.threadIds.delete(threadId);
    if (loading.threadIds.size === 0) inFlight.delete(environmentId);
  };

  const load = async (
    environmentId: EnvironmentId,
    source: ArchivedThreadShellSource,
    threadIds: ReadonlyArray<ThreadId>,
  ) => {
    const getThreadShells = source.getThreadShells!;
    let pending: ReadonlyArray<ThreadId> = threadIds;
    try {
      for (let round = 0; pending.length > 0 && round <= MAX_REMAINING_ROUNDS; round += 1) {
        const result = await getThreadShells({ threadIds: pending });
        if (!isCurrent(environmentId, source.token)) return;
        if (result.threads.length > 0) input.apply(environmentId, result.threads);
        // No progress means the rest can never fit; leave them as stubs.
        if (result.threads.length === 0) break;
        pending = result.remainingThreadIds.filter((threadId) => pending.includes(threadId));
      }
    } catch (error) {
      if (isCurrent(environmentId, source.token)) onError(environmentId, threadIds, error);
    } finally {
      settle(environmentId, source.token, threadIds);
    }
  };

  const flush = (environmentId: EnvironmentId) => {
    const batch = queued.get(environmentId);
    queued.delete(environmentId);
    if (batch === undefined || input.sourceFor(environmentId)?.token !== batch.source.token) {
      if (batch !== undefined) settle(environmentId, batch.source.token, batch.ids);
      return;
    }
    const ids = [...batch.ids];
    for (let start = 0; start < ids.length; start += ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS) {
      void load(
        environmentId,
        batch.source,
        ids.slice(start, start + ORCHESTRATION_GET_THREAD_SHELLS_MAX_IDS),
      );
    }
  };

  return {
    ensureFullShell: (environmentId, threadId) => {
      if (!input.isArchivedThreadStub(environmentId, threadId)) return;
      const source = input.sourceFor(environmentId);
      if (source?.getThreadShells === undefined) return;
      let loading = inFlight.get(environmentId);
      if (loading !== undefined && loading.token !== source.token) {
        // A previous connection's loads: their responses are dropped anyway.
        inFlight.delete(environmentId);
        loading = undefined;
      }
      if (loading?.threadIds.has(threadId)) return;
      if (loading === undefined) {
        loading = { token: source.token, threadIds: new Set() };
        inFlight.set(environmentId, loading);
      }
      loading.threadIds.add(threadId);
      const batch = queued.get(environmentId);
      if (batch !== undefined && batch.source.token === source.token) {
        batch.ids.add(threadId);
        return;
      }
      queued.set(environmentId, { source, ids: new Set([threadId]) });
      schedule(() => flush(environmentId));
    },
    clearEnvironment: (environmentId) => {
      inFlight.delete(environmentId);
      queued.delete(environmentId);
    },
  };
}
