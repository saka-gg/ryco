import {
  createEarlierArtifactReads,
  earlierArtifactReadIdentity,
  type EarlierArtifactMessages,
  type ThreadArtifactSource,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentId, OrchestrationThreadHistoryCursor, ThreadId } from "@ryco/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useWsConnectionOpenedCount } from "../../rpc/wsConnectionState";

const reads = createEarlierArtifactReads();

export function __resetEarlierThreadArtifactsForTests(): void {
  reads.clear();
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
  const identity = earlierArtifactReadIdentity(environmentId, threadId, startCursor);
  const initialState = (): ReadState => ({ identity, read: reads.cached(identity) });
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
    reads
      .readFrom({
        identity,
        threadId,
        read,
        cursor,
        readPage: () => readEnvironmentApi(environmentId)?.orchestration.getThreadHistoryPage,
      })
      .then(
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
