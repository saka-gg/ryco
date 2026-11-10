import type {
  EnvironmentId,
  MessageId,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationThreadHistoryCollection,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadHistoryPageInfo,
  ThreadId,
} from "@ryco/contracts";

import { scopedThreadKey, scopeThreadRef } from "../scoped.ts";

export interface ThreadHistoryScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface ThreadHistoryPaginationController {
  readonly beginSnapshot: (scope: ThreadHistoryScope) => number;
  readonly invalidate: (scope: ThreadHistoryScope) => void;
  readonly clearEnvironment: (environmentId: EnvironmentId) => void;
  readonly loadBefore: (input: {
    readonly scope: ThreadHistoryScope;
    readonly collection: OrchestrationThreadHistoryCollection;
    readonly page: OrchestrationThreadHistoryPageInfo;
    readonly limit: number;
  }) => Promise<OrchestrationThreadHistoryPage | null>;
  readonly loadAroundMessage: (input: {
    readonly scope: ThreadHistoryScope;
    readonly anchorId: MessageId;
    readonly limit: number;
  }) => Promise<OrchestrationThreadHistoryPage | null>;
}

function threadHistoryErrorReason(error: unknown): unknown {
  const record =
    typeof error === "object" && error !== null
      ? (error as { readonly _tag?: unknown; readonly reason?: unknown })
      : null;
  return record?._tag === "OrchestrationThreadHistoryError" ? record.reason : undefined;
}

/**
 * Whether a rejected `loadAroundMessage` says the message is gone: the server
 * answers stale-cursor for an anchor the thread no longer has, and
 * thread-not-found for a thread it no longer has. Any other rejection (a
 * dropped connection, a timeout) says nothing about the message.
 */
export function isThreadHistoryAnchorMissing(error: unknown): boolean {
  const reason = threadHistoryErrorReason(error);
  return reason === "stale-cursor" || reason === "thread-not-found";
}

export function createThreadHistoryPaginationController(deps: {
  readonly request: (
    environmentId: EnvironmentId,
    input: OrchestrationGetThreadHistoryPageInput,
  ) => Promise<OrchestrationThreadHistoryPage>;
  readonly apply: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    page: OrchestrationThreadHistoryPage,
  ) => void;
  readonly setRequestState: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly collection: OrchestrationThreadHistoryCollection;
    readonly status: "idle" | "loading" | "error";
    readonly cursor: string | null;
    readonly error: string | null;
  }) => void;
  readonly recoverStale?: (scope: ThreadHistoryScope) => Promise<void>;
}): ThreadHistoryPaginationController {
  const generationByScope = new Map<string, number>();
  const inflightByKey = new Map<string, Promise<OrchestrationThreadHistoryPage | null>>();
  // The collections each thread has a load in flight for, so dropping the
  // thread's loads also clears the loading state they set.
  const loadingByScope = new Map<string, Map<OrchestrationThreadHistoryCollection, number>>();
  const trackLoading = (scopeKey: string, collection: OrchestrationThreadHistoryCollection) => {
    const loading = loadingByScope.get(scopeKey) ?? new Map();
    loading.set(collection, (loading.get(collection) ?? 0) + 1);
    loadingByScope.set(scopeKey, loading);
  };
  const untrackLoading = (scopeKey: string, collection: OrchestrationThreadHistoryCollection) => {
    const loading = loadingByScope.get(scopeKey);
    const count = loading?.get(collection);
    if (loading === undefined || count === undefined) return;
    if (count > 1) loading.set(collection, count - 1);
    else loading.delete(collection);
    if (loading.size === 0) loadingByScope.delete(scopeKey);
  };
  const keyFor = (scope: ThreadHistoryScope) =>
    scopedThreadKey(scopeThreadRef(scope.environmentId, scope.threadId));
  const currentGeneration = (scope: ThreadHistoryScope) =>
    generationByScope.get(keyFor(scope)) ?? 0;
  const beginSnapshot = (scope: ThreadHistoryScope) => {
    const generation = currentGeneration(scope) + 1;
    generationByScope.set(keyFor(scope), generation);
    // The snapshot replaces the load state of the loads it drops.
    loadingByScope.delete(keyFor(scope));
    return generation;
  };
  /**
   * Drops the thread's loads in flight. A load it drops leaves no "loading"
   * behind: the body it was for may stay and be resumed rather than reloaded,
   * and nothing else would clear it.
   */
  const invalidate = (scope: ThreadHistoryScope) => {
    const scopeKey = keyFor(scope);
    generationByScope.set(scopeKey, currentGeneration(scope) + 1);
    const loading = loadingByScope.get(scopeKey);
    if (loading === undefined) return;
    loadingByScope.delete(scopeKey);
    for (const collection of loading.keys()) {
      deps.setRequestState({ ...scope, collection, status: "idle", cursor: null, error: null });
    }
  };
  const execute = (input: {
    readonly scope: ThreadHistoryScope;
    readonly collection: OrchestrationThreadHistoryCollection;
    readonly request: OrchestrationGetThreadHistoryPageInput;
    readonly requestKey: string;
  }) => {
    const generation = currentGeneration(input.scope);
    const inflightKey = `${keyFor(input.scope)}:${generation}:${input.requestKey}`;
    const existing = inflightByKey.get(inflightKey);
    if (existing) return existing;

    const cursor =
      input.request.mode.kind === "before"
        ? input.request.mode.cursor
        : `around:${input.request.mode.anchorId}`;
    deps.setRequestState({
      ...input.scope,
      collection: input.collection,
      status: "loading",
      cursor,
      error: null,
    });
    const scopeKey = keyFor(input.scope);
    trackLoading(scopeKey, input.collection);
    // Only a load of the scope's current generation still counts; one an
    // invalidation dropped was untracked with it.
    const settleLoading = () => {
      if (currentGeneration(input.scope) === generation) untrackLoading(scopeKey, input.collection);
    };
    const request = deps
      .request(input.scope.environmentId, input.request)
      .then((page) => {
        if (currentGeneration(input.scope) !== generation) return null;
        deps.apply(input.scope.environmentId, input.scope.threadId, page);
        deps.setRequestState({
          ...input.scope,
          collection: input.collection,
          status: "idle",
          cursor: null,
          error: null,
        });
        return page;
      })
      .catch(async (error: unknown) => {
        // Around a message (or thread) that is gone, the server answers
        // stale-cursor (or thread-not-found) though nothing loaded is stale or
        // failed. A resnapshot would reload the window for nothing and resolve
        // as if the load worked, and an error would show on the older-messages
        // loader; the caller needs the answer (a reveal settles on it).
        if (input.request.mode.kind === "around" && isThreadHistoryAnchorMissing(error)) {
          if (currentGeneration(input.scope) === generation) {
            deps.setRequestState({
              ...input.scope,
              collection: input.collection,
              status: "idle",
              cursor: null,
              error: null,
            });
          }
          throw error;
        }
        const historyErrorReason = threadHistoryErrorReason(error);
        const shouldRecover =
          historyErrorReason === "stale-cursor" ||
          historyErrorReason === "invalid-cursor" ||
          historyErrorReason === "unsupported-version";
        if (shouldRecover && deps.recoverStale && currentGeneration(input.scope) === generation) {
          try {
            await deps.recoverStale(input.scope);
            beginSnapshot(input.scope);
            return null;
          } catch (recoveryError) {
            error = recoveryError;
          }
        }
        if (currentGeneration(input.scope) === generation) {
          deps.setRequestState({
            ...input.scope,
            collection: input.collection,
            status: "error",
            cursor,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      })
      .finally(() => {
        settleLoading();
        if (inflightByKey.get(inflightKey) === request) inflightByKey.delete(inflightKey);
      });
    inflightByKey.set(inflightKey, request);
    return request;
  };

  return {
    beginSnapshot,
    invalidate,
    clearEnvironment: (environmentId) => {
      for (const scopeKey of generationByScope.keys()) {
        if (scopeKey.startsWith(`${environmentId}:`)) {
          generationByScope.delete(scopeKey);
        }
      }
      for (const scopeKey of loadingByScope.keys()) {
        if (scopeKey.startsWith(`${environmentId}:`)) loadingByScope.delete(scopeKey);
      }
    },
    loadBefore: ({ scope, collection, page, limit }) => {
      if (!page.hasMoreBefore || page.oldestCursor === null) return Promise.resolve(null);
      return execute({
        scope,
        collection,
        request: {
          threadId: scope.threadId,
          collection,
          mode: { kind: "before", cursor: page.oldestCursor },
          limit,
        },
        requestKey: `${collection}:before:${page.oldestCursor}:${limit}`,
      });
    },
    loadAroundMessage: ({ scope, anchorId, limit }) =>
      execute({
        scope,
        collection: "messages",
        request: {
          threadId: scope.threadId,
          collection: "messages",
          mode: { kind: "around", anchorId },
          limit,
        },
        requestKey: `messages:around:${anchorId}:${limit}`,
      }),
  };
}
