import type { ThreadArtifactSource } from "@ryco/client-runtime/state/session";
import type { EnvironmentId, OrchestrationThreadHistoryCursor, ThreadId } from "@ryco/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { LRUCache } from "../../lib/lruCache";
import { useWsConnectionOpenedCount } from "../../rpc/wsConnectionState";
import {
  readEarlierArtifactMessages,
  type EarlierArtifactMessages,
} from "./earlierThreadArtifacts";

/**
 * Keyed by where the thread as loaded begins: a timeline that pages further
 * back, or a window that starts over, begins somewhere else, and the read
 * starts over from there. A remount reads nothing it already has.
 */
const readByStart = new LRUCache<EarlierArtifactMessages>(32, Number.POSITIVE_INFINITY);
const inflight = new Map<string, Promise<EarlierArtifactMessages>>();

export function __resetEarlierThreadArtifactsForTests(): void {
  readByStart.clear();
  inflight.clear();
}

function readFrom(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  identity: string,
  read: EarlierArtifactMessages | null,
  cursor: OrchestrationThreadHistoryCursor,
): Promise<EarlierArtifactMessages> {
  const key = `${identity}:${cursor}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const request = Promise.resolve()
    .then(() => {
      const readPage = readEnvironmentApi(environmentId)?.orchestration.getThreadHistoryPage;
      // Not connected (yet): asked again once a connection opens.
      if (!readPage) throw new Error("The environment cannot read thread history right now.");
      return readEarlierArtifactMessages(readPage, threadId, cursor);
    })
    .then((page) => {
      const next = { messages: [...(read?.messages ?? []), ...page.messages], cursor: page.cursor };
      readByStart.set(identity, next, 1);
      return next;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

export interface EarlierThreadArtifacts {
  /** The artifact messages read further back so far. */
  readonly messages: ReadonlyArray<ThreadArtifactSource>;
  /** Reading further back, or about to. */
  readonly loading: boolean;
  /** The last read failed; `loadMore` asks again (and so does a new connection). */
  readonly failed: boolean;
  /** More of the thread lies further back than what has been read. */
  readonly hasMore: boolean;
  readonly loadMore: () => void;
}

interface ReadState {
  readonly identity: string;
  readonly read: EarlierArtifactMessages | null;
  /** Asked to read on past `read` (`loadMore`). */
  readonly more?: boolean;
  /** The socket-open count when the failed read started; any later open retries the first read. */
  readonly failedAtOpenCount?: number;
}

const NO_MESSAGES: ReadonlyArray<ThreadArtifactSource> = [];

/**
 * The thread's artifact messages before where the thread as loaded begins
 * (`startCursor`, null when it begins at the start). The first read starts
 * while `enabled`; each further one on `loadMore`.
 */
export function useEarlierThreadArtifacts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly startCursor: OrchestrationThreadHistoryCursor | null;
  readonly enabled: boolean;
}): EarlierThreadArtifacts {
  const { environmentId, threadId, startCursor } = input;
  const identity =
    environmentId && threadId && startCursor ? `${environmentId}:${threadId}:${startCursor}` : "";
  const initialState = (): ReadState => ({
    identity,
    read: identity ? readByStart.get(identity) : null,
  });
  const [stored, setState] = useState<ReadState>(initialState);
  const state = stored.identity === identity ? stored : initialState();
  const openCount = useWsConnectionOpenedCount();
  const readOpenCount = useEffectEvent(() => openCount);
  const failed = state.failedAtOpenCount !== undefined && state.failedAtOpenCount === openCount;

  const { read } = state;
  // The first read is due once enabled; each further one once asked for.
  const due =
    identity !== "" &&
    !failed &&
    (read === null ? input.enabled : state.more === true && read.cursor !== null);
  useEffect(() => {
    const cursor = read ? read.cursor : startCursor;
    if (!due || !environmentId || !threadId || !cursor) return;
    const startedAtOpenCount = readOpenCount();
    let cancelled = false;
    readFrom(environmentId, threadId, identity, read, cursor).then(
      (next) => {
        if (!cancelled) setState({ identity, read: next });
      },
      () => {
        if (!cancelled) setState({ identity, read, failedAtOpenCount: startedAtOpenCount });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [due, environmentId, identity, read, startCursor, threadId]);

  // Also asks again after a failure.
  const loadMore = () => setState({ identity, read, more: true });

  return {
    messages: read?.messages ?? NO_MESSAGES,
    loading: due,
    failed,
    hasMore: identity !== "" && (read === null || read.cursor !== null),
    loadMore,
  };
}
