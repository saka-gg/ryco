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
  const keyFor = (scope: ThreadHistoryScope) =>
    scopedThreadKey(scopeThreadRef(scope.environmentId, scope.threadId));
  const currentGeneration = (scope: ThreadHistoryScope) =>
    generationByScope.get(keyFor(scope)) ?? 0;
  const beginSnapshot = (scope: ThreadHistoryScope) => {
    const generation = currentGeneration(scope) + 1;
    generationByScope.set(keyFor(scope), generation);
    return generation;
  };
  const invalidate = (scope: ThreadHistoryScope) => {
    generationByScope.set(keyFor(scope), currentGeneration(scope) + 1);
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
        const errorRecord =
          typeof error === "object" && error !== null
            ? (error as { readonly _tag?: unknown; readonly reason?: unknown })
            : null;
        const historyErrorReason =
          errorRecord?._tag === "OrchestrationThreadHistoryError" ? errorRecord.reason : undefined;
        // Around a message the thread no longer has, the server answers
        // stale-cursor though nothing loaded is stale. A resnapshot would
        // reload the window for nothing and resolve as if the load worked;
        // the caller needs the answer (a reveal settles on it).
        if (input.request.mode.kind === "around" && historyErrorReason === "stale-cursor") {
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
