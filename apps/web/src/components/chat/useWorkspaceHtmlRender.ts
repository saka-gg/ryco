import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { selectThreadDetailLoaded } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useWsConnectionOpenedCount } from "../../rpc/wsConnectionState";
import { useStore } from "../../store";
import type { Thread } from "../../types";
import { parseWorkspaceRenderKey } from "../../workspaceRouteSearch";
import { findThreadHtmlRender, type HtmlRenderAttachment } from "./htmlRender.logic";
import { createHtmlRenderLookup, type HtmlRenderLookupVerdict } from "./htmlRenderLookup";

const lookup = createHtmlRenderLookup(async (environmentId, input) => {
  const readPage = readEnvironmentApi(environmentId)?.orchestration.getThreadHistoryPage;
  // Not connected (yet): asked again once a connection opens.
  if (!readPage) throw new Error("The environment cannot read thread history right now.");
  return readPage(input);
});

export function __resetWorkspaceHtmlRenderLookupForTests(): void {
  lookup.clear();
}

export type WorkspaceHtmlRender =
  /** The page, from the thread as loaded or looked up on its own. */
  | { readonly status: "found"; readonly render: HtmlRenderAttachment }
  /** Its message is gone, or the key names no render. */
  | { readonly status: "unavailable" }
  /** The thread is still arriving, or the page is being looked up. */
  | { readonly status: "pending" }
  /** The lookup failed without an answer; asked again on reconnect or retry. */
  | { readonly status: "failed"; readonly retry: () => void };

interface LookupState {
  readonly identity: string;
  readonly verdict?: HtmlRenderLookupVerdict;
  /** The socket-open count when the failed lookup started; any later open retries it. */
  readonly failedAtOpenCount?: number;
}

/**
 * The render a page tab shows, resolved from the thread as loaded and, only
 * while `lookUp` is set, looked up when it lies further back.
 */
export function useWorkspaceHtmlRender(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly thread: Thread | undefined;
  readonly renderKey: string | null;
  readonly lookUp: boolean;
}): WorkspaceHtmlRender {
  const { environmentId, threadId, renderKey } = input;
  const target = useMemo(
    () => (renderKey === null ? null : parseWorkspaceRenderKey(renderKey)),
    [renderKey],
  );
  const messages = input.thread?.messages;
  const loadedRender = useMemo(
    () => (target && messages ? findThreadHtmlRender(messages, target) : undefined),
    [messages, target],
  );
  const detailLoaded = useStore((state) =>
    environmentId && threadId
      ? selectThreadDetailLoaded(state, scopeThreadRef(environmentId, threadId))
      : false,
  );
  const hasOlderMessages = useStore((state) =>
    environmentId && threadId
      ? state.environmentStateById[environmentId]?.threadHistoryByThreadId?.[threadId]?.messages
          .hasMoreBefore === true
      : false,
  );

  const identity =
    environmentId && threadId && renderKey ? `${environmentId}:${threadId}:${renderKey}` : "";
  const initialState = (): LookupState => {
    const verdict =
      environmentId && threadId && renderKey
        ? lookup.peek(environmentId, threadId, renderKey)
        : undefined;
    return verdict ? { identity, verdict } : { identity };
  };
  const [stored, setState] = useState<LookupState>(initialState);
  const state = stored.identity === identity ? stored : initialState();
  const openCount = useWsConnectionOpenedCount();
  const readOpenCount = useEffectEvent(() => openCount);
  const failed = state.failedAtOpenCount !== undefined && state.failedAtOpenCount === openCount;
  const looking =
    input.lookUp &&
    target !== null &&
    loadedRender === undefined &&
    detailLoaded &&
    hasOlderMessages &&
    state.verdict === undefined &&
    !failed;

  const { failedAtOpenCount } = state;
  useEffect(() => {
    if (!looking || !environmentId || !threadId || !renderKey) return;
    const startedAtOpenCount = readOpenCount();
    let cancelled = false;
    // A promise even when reading throws at once (no connection registered).
    void Promise.resolve()
      .then(() => lookup.lookUp(environmentId, threadId, renderKey))
      .then(
        (render) => {
          if (!cancelled) setState({ identity, verdict: { render } });
        },
        () => {
          if (!cancelled) setState({ identity, failedAtOpenCount: startedAtOpenCount });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    environmentId,
    // Not read inside: a new failure count is what starts the next attempt.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    failedAtOpenCount,
    identity,
    looking,
    renderKey,
    threadId,
  ]);

  const retry = useCallback(() => setState({ identity }), [identity]);

  if (target === null || !environmentId || !threadId) return { status: "unavailable" };
  if (loadedRender !== undefined) return { status: "found", render: loadedRender };
  // The thread is still arriving (a switch back restores the tab before its
  // messages load): no verdict yet.
  if (!detailLoaded) return { status: "pending" };
  // The whole thread is loaded, and the page is not in it.
  if (!hasOlderMessages) return { status: "unavailable" };
  if (state.verdict) {
    return state.verdict.render
      ? { status: "found", render: state.verdict.render }
      : { status: "unavailable" };
  }
  if (failed) return { status: "failed", retry };
  return { status: "pending" };
}
