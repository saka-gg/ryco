import { useChatPanesStore } from "../../chatPanesStore";
import { paneContains } from "../../chatPanes.logic";
import { ChatPanes, PaneThreadAvailability } from "../chat/ChatPanes";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { finalizePromotedDraftThreadByRef } from "../../composerDraftStore";
import {
  useDraftThreadByRef,
  useDraftThreadExistsByRef,
  useEnvironmentHasDraftThreads,
} from "../../composerDraftSelectors";
import { useAppSidebarCollapsed } from "../../hooks/useAppSidebarCollapsed";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useRightPanelMaximized } from "../../hooks/useRightPanelMaximized";
import { type RightPanelSearchUpdate, useRightPanelTabs } from "../../hooks/useRightPanelTabs";
import { useThreadRightPanelRouteState } from "../../hooks/useThreadRightPanelRouteState";
import { useSettings } from "../../hooks/useSettings";
import { usePerfMark } from "../../perf/tabSwitchInstrumentation";
import { retainDesktopWorkspaceThreadScope } from "../../platform/desktopWorkspace";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import {
  getRightPanelMode,
  isRightPanelOpen,
  type RightPanelMode,
  type RightPanelRouteSearch,
} from "../../rightPanelRouteSearch";
import { selectEnvironmentState, selectThreadExistsByRef, useStore } from "../../store";
import {
  createEnvironmentFallbackThreadRefSelector,
  createThreadSelectorByRef,
} from "../../storeSelectors";
import { buildThreadRouteParams } from "../../threadRoutes";
import { buildOpenSimulatorSearch } from "../../workspaceRouteSearch";
import ChatView from "../ChatView";
import { threadHasStarted } from "../ChatView.logic";
import { LazyRightPanel, RightPanelInlineSidebar } from "../ChatRightPanel";
import { RightPanelSheet } from "../RightPanelSheet";
import { PhoneWorkSurfaceSheet } from "../shell/phone/PhoneWorkSurface";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

export function ChatThreadRouteView({
  threadRef,
  search,
}: {
  threadRef: ScopedThreadRef | null;
  search: RightPanelRouteSearch;
}) {
  usePerfMark("ChatThreadRouteView");
  const navigate = useNavigate();
  const presentationTier = usePresentationTier();
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const routeEnvironmentId = threadRef?.environmentId ?? null;
  const routeThreadId = threadRef?.threadId ?? null;
  const replaceThreadRightPanelSearch = useCallback(
    (nextSearch: RightPanelRouteSearch) => {
      if (!threadRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        replace: true,
        search: nextSearch,
      });
    },
    [navigate, threadRef],
  );
  const threadSearch = useThreadRightPanelRouteState({
    threadKey: currentThreadKey,
    search,
    replaceSearch: replaceThreadRightPanelSearch,
  });
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadExistsByRef(store, threadRef));
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const sidebarThreadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const fallbackThreadRef = useStore(
    useMemo(
      () =>
        createEnvironmentFallbackThreadRefSelector(
          threadRef?.environmentId ?? null,
          sidebarThreadSortOrder,
        ),
      [sidebarThreadSortOrder, threadRef?.environmentId],
    ),
  );
  const draftThreadExists = useDraftThreadExistsByRef(threadRef);
  const draftThread = useDraftThreadByRef(threadRef);
  const environmentHasDraftThreads = useEnvironmentHasDraftThreads(threadRef?.environmentId);
  const paneRoot = useChatPanesStore((s) => s.root);
  const routeInPanes =
    presentationTier !== "phone" && !!threadRef && !!paneRoot && paneContains(paneRoot, threadRef);
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  // A hosted node switch deliberately demotes the environment to last-known
  // state while the next relay channel boots. Keep a cached server thread
  // mounted during that interval: its session/liveness were already stripped
  // by the demotion boundary, and hosted RPC capability keeps mutations
  // disabled until the fresh channel is ready. Hiding it behind
  // `bootstrapComplete` produced a blank ~3s route on every cross-node switch
  // even when the full thread was still available in memory.
  const canRenderRouteThread =
    routeInPanes ||
    (routeThreadExists && (draftThreadExists || bootstrapComplete || serverThread !== undefined));
  const rightPanelMode: RightPanelMode | null = getRightPanelMode(threadSearch);
  const rightPanelOpen = isRightPanelOpen(threadSearch);
  const activeAgentKey =
    threadSearch.workspaceTab === "agent" && threadSearch.workspaceAgentKey
      ? threadSearch.workspaceAgentKey
      : null;
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const pendingDeviceOpenRequest = useDeviceStateStore((state) =>
    currentThreadKey ? state.pendingOpenByThreadKey[currentThreadKey] : undefined,
  );
  const consumeDeviceOpenRequest = useDeviceStateStore((state) => state.consumeOpenRequest);
  const appSidebarCollapsed = useAppSidebarCollapsed();
  // Maximizing only means anything for the inline split — the sheet and the
  // phone work surface already cover the viewport.
  const { maximized: rightPanelMaximized, toggleMaximized: toggleRightPanelMaximized } =
    useRightPanelMaximized({
      threadKey: currentThreadKey,
      open: rightPanelOpen,
      canMaximize: !shouldUseDiffSheet && presentationTier !== "phone",
    });
  // Cached Desktop rows intentionally are not bootstrap-complete. Acquire the
  // route's node before the ChatView guard below so opening a last-known thread
  // can establish its live shell snapshot without a node picker or retry.
  useEffect(() => {
    if (!routeEnvironmentId || !routeThreadId) return;
    return retainDesktopWorkspaceThreadScope(routeEnvironmentId, routeThreadId);
  }, [routeEnvironmentId, routeThreadId]);
  useEffect(() => {
    if (!threadRef || !pendingDeviceOpenRequest || presentationTier === "phone") return;
    consumeDeviceOpenRequest(threadRef.environmentId, threadRef.threadId);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => buildOpenSimulatorSearch(previous),
    });
  }, [consumeDeviceOpenRequest, navigate, pendingDeviceOpenRequest, presentationTier, threadRef]);
  const navigateThreadSearch = useCallback(
    (update: RightPanelSearchUpdate) => {
      if (!threadRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: update,
      });
    },
    [navigate, threadRef],
  );
  const {
    openedPanelModes,
    openedAgentKeys,
    lastOpenedRightPanelMode,
    markRightPanelOpened,
    openRightPanel,
    closeRightPanel,
    toggleRightPanel,
    closePanelTab,
    shouldRenderRightPanelContent,
    shouldRenderPhoneRightPanelContent,
  } = useRightPanelTabs({
    scopeKey: currentThreadKey,
    rightPanelMode,
    rightPanelOpen,
    activeAgentKey,
    defaultLastMode: "review",
    navigateSearch: navigateThreadSearch,
  });

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeInPanes && !routeThreadExists && environmentHasAnyThreads) {
      if (fallbackThreadRef) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(fallbackThreadRef),
          replace: true,
        });
      } else {
        void navigate({ to: "/", replace: true });
      }
    }
  }, [
    bootstrapComplete,
    environmentHasAnyThreads,
    fallbackThreadRef,
    navigate,
    routeThreadExists,
    routeInPanes,
    threadRef,
  ]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !canRenderRouteThread) {
    return null;
  }

  const mountedRightPanelMode: RightPanelMode | null = rightPanelOpen
    ? rightPanelMode
    : lastOpenedRightPanelMode;

  // Phone tier: the same URL-driven panel state renders as a full-screen
  // pushed surface over the thread instead of an inline panel or right sheet.
  // Links stay interchangeable with desktop; closing clears the same params.
  if (presentationTier === "phone") {
    return (
      <>
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
          <ChatPanes threadRef={threadRef} enabled={false}>
            {() => (
              <PaneThreadAvailability threadRef={threadRef}>
                <ChatView
                  environmentId={threadRef.environmentId}
                  threadId={threadRef.threadId}
                  onDiffPanelOpen={() => markRightPanelOpened("review")}
                  onPreviewPanelOpen={() => markRightPanelOpened("files")}
                  onTerminalPanelOpen={() => markRightPanelOpened("terminal")}
                  onAgentPanelOpen={() => markRightPanelOpened("agent")}
                  workspacePanelOpen={rightPanelOpen}
                  onToggleWorkspacePanel={toggleRightPanel}
                  routeKind="server"
                />
              </PaneThreadAvailability>
            )}
          </ChatPanes>
        </SidebarInset>
        <PhoneWorkSurfaceSheet label="Workspace" open={rightPanelOpen} onClose={closeRightPanel}>
          {shouldRenderPhoneRightPanelContent ? (
            <LazyRightPanel
              mode="phone"
              panelMode={mountedRightPanelMode}
              openedPanelModes={openedPanelModes}
              openedAgentKeys={openedAgentKeys}
              onClosePanelTab={closePanelTab}
            />
          ) : null}
        </PhoneWorkSurfaceSheet>
      </>
    );
  }

  if (!shouldUseDiffSheet) {
    return (
      <>
        {/* Maximized: the chat column keeps its subtree mounted (drafts,
            scroll position, streaming turns) but gives up all of its width
            and goes inert so nothing behind the panel stays focusable. */}
        <SidebarInset
          className={cn(
            "h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh",
            rightPanelMaximized && "w-0 flex-none",
          )}
          inert={rightPanelMaximized ? true : undefined}
        >
          <ChatPanes threadRef={threadRef}>
            {(paneRef, focused) => (
              <PaneThreadAvailability threadRef={paneRef}>
                <ChatView
                  environmentId={paneRef.environmentId}
                  threadId={paneRef.threadId}
                  onDiffPanelOpen={() => markRightPanelOpened("review")}
                  onPreviewPanelOpen={() => markRightPanelOpened("files")}
                  onTerminalPanelOpen={() => markRightPanelOpened("terminal")}
                  onAgentPanelOpen={() => markRightPanelOpened("agent")}
                  workspacePanelOpen={focused && rightPanelOpen}
                  onToggleWorkspacePanel={() => {
                    if (focused) toggleRightPanel();
                  }}
                  routeKind="server"
                  reserveTitleBarControlInset={focused}
                />
              </PaneThreadAvailability>
            )}
          </ChatPanes>
        </SidebarInset>
        <RightPanelInlineSidebar
          open={rightPanelOpen}
          panelMode={mountedRightPanelMode}
          openedPanelModes={openedPanelModes}
          openedAgentKeys={openedAgentKeys}
          onClosePanelTab={closePanelTab}
          onClose={closeRightPanel}
          onOpen={openRightPanel}
          renderContent={shouldRenderRightPanelContent}
          maximized={rightPanelMaximized}
          onToggleMaximized={toggleRightPanelMaximized}
          reserveChromeInset={rightPanelMaximized && appSidebarCollapsed}
        />
      </>
    );
  }

  return (
    <>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatPanes threadRef={threadRef}>
          {(paneRef, focused) => (
            <PaneThreadAvailability threadRef={paneRef}>
              <ChatView
                environmentId={paneRef.environmentId}
                threadId={paneRef.threadId}
                onDiffPanelOpen={() => markRightPanelOpened("review")}
                onPreviewPanelOpen={() => markRightPanelOpened("files")}
                onTerminalPanelOpen={() => markRightPanelOpened("terminal")}
                onAgentPanelOpen={() => markRightPanelOpened("agent")}
                workspacePanelOpen={focused && rightPanelOpen}
                onToggleWorkspacePanel={() => {
                  if (focused) toggleRightPanel();
                }}
                routeKind="server"
                reserveTitleBarControlInset={focused}
              />
            </PaneThreadAvailability>
          )}
        </ChatPanes>
      </SidebarInset>
      <RightPanelSheet open={rightPanelOpen} onClose={closeRightPanel}>
        {shouldRenderRightPanelContent ? (
          <LazyRightPanel
            mode="sheet"
            panelMode={mountedRightPanelMode}
            openedPanelModes={openedPanelModes}
            openedAgentKeys={openedAgentKeys}
            onClosePanelTab={closePanelTab}
          />
        ) : null}
      </RightPanelSheet>
    </>
  );
}
