import type { ScopedThreadRef } from "@ryco/contracts";
import {
  buildOpenChatTabs,
  canKeepOpenChatTab,
  type OpenChatTab,
} from "@ryco/client-runtime/state/threads/openChatTabs";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useOpenChatTabsStore } from "../../openChatTabsStore";
import { navigateWithPreviewGuard } from "../../previewNavigation";
import { selectEnvironmentState, selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";

/*
 * The open chat tabs wired to the app: tabs derived from the shell summaries the store already
 * holds (no subscription or connection per tab), the chat on screen recorded as open, and the
 * navigation a tab click runs.
 */

/**
 * Open chats as display tabs, in tab order. A chat whose environment has bootstrapped and which no
 * longer exists (deleted, archived, a discarded draft) is dropped from the stored list; until its
 * environment has, a missing summary only hides the tab, since missing data is no proof of
 * deletion.
 */
export function useOpenChatTabs(activeRef: ScopedThreadRef | null): OpenChatTab[] {
  const refs = useOpenChatTabsStore((state) => state.refs);
  const prune = useOpenChatTabsStore((state) => state.prune);
  // Per-ref slices compared element-wise, so streaming in an unrelated thread does not re-render
  // the strip.
  const summaries = useStore(
    useShallow((state) => refs.map((ref) => selectSidebarThreadSummaryByRef(state, ref))),
  );
  // Prunes when an environment's snapshot becomes authoritative, not on every thread change: a
  // draft promoting to a server thread disappears for a moment and must keep its tab.
  const bootstrappedEnvironments = useStore((state) =>
    [...new Set(refs.map((ref) => ref.environmentId))]
      .filter((environmentId) => selectEnvironmentState(state, environmentId).bootstrapComplete)
      .toSorted()
      .join("\n"),
  );
  // The chat on screen is read when the prune runs; a navigation alone is no reason to prune.
  const activeRefRef = useRef(activeRef);
  useLayoutEffect(() => {
    activeRefRef.current = activeRef;
  });
  useEffect(() => {
    if (!bootstrappedEnvironments) return;
    const bootstrapped = new Set(bootstrappedEnvironments.split("\n"));
    const active = activeRefRef.current;
    const store = useStore.getState();
    const drafts = useComposerDraftStore.getState();
    prune(
      (ref) =>
        !bootstrapped.has(ref.environmentId) ||
        (active !== null &&
          ref.environmentId === active.environmentId &&
          ref.threadId === active.threadId) ||
        canKeepOpenChatTab(
          selectSidebarThreadSummaryByRef(store, ref),
          drafts.getDraftThreadByRef(ref) !== null,
        ),
    );
  }, [bootstrappedEnvironments, prune]);

  return useMemo(
    () =>
      buildOpenChatTabs({
        sources: refs.map((ref, index) => ({ ref, summary: summaries[index] })),
        activeRef,
      }),
    [activeRef, refs, summaries],
  );
}

/**
 * Registers the chat a header shows, drafts included so their tab appears once they are sent. A
 * layout effect, so a newly opened chat's tab paints in the same frame as the chat itself.
 */
export function useRecordOpenChatTab(ref: ScopedThreadRef | null): void {
  const open = useOpenChatTabsStore((state) => state.open);
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  useLayoutEffect(() => {
    if (environmentId !== null && threadId !== null) open({ environmentId, threadId });
  }, [environmentId, open, threadId]);
}

/** The chat the route shows right now, for code that runs after a navigation settles. */
export function useReadRouteThreadRef(): () => ScopedThreadRef | null {
  const router = useRouter();
  return useCallback(() => {
    const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    const target = resolveThreadRouteTarget(params);
    return target?.kind === "server" ? target.threadRef : null;
  }, [router]);
}

/**
 * Opens a tab's chat the way a sidebar row does: a chat in the split on screen focuses its pane,
 * any other opens on its own (the split stays saved for when one of its chats opens again). The
 * file preview's save guard can refuse to leave; the promise settles either way, with whether the
 * route moved.
 */
export function useActivateOpenChatTab(): (ref: ScopedThreadRef) => Promise<boolean> {
  const navigate = useNavigate();
  const router = useRouter();
  // One controller per mount (a remount gets a fresh one): unmounting settles a pending
  // activation instead of leaving a close waiting on it.
  const abort = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, []);
  return useCallback(
    (ref) => {
      const signal = abort.current?.signal;
      if (!signal) return Promise.resolve(false);
      const destination = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
      return navigateWithPreviewGuard(
        destination.pathname,
        () => navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }),
        signal,
      );
    },
    [navigate, router],
  );
}
