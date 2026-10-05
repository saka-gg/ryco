import { useNavigate } from "@tanstack/react-router";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import { useCallback, useEffect, useMemo } from "react";

import { DraftId } from "../../composerDraftStore";
import { useDraftSession } from "../../composerDraftSelectors";
import { useAppSidebarCollapsed } from "../../hooks/useAppSidebarCollapsed";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useRightPanelMaximized } from "../../hooks/useRightPanelMaximized";
import { type RightPanelSearchUpdate, useRightPanelTabs } from "../../hooks/useRightPanelTabs";
import { useThreadRightPanelRouteState } from "../../hooks/useThreadRightPanelRouteState";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import {
  getRightPanelMode,
  isRightPanelOpen,
  type RightPanelMode,
  type RightPanelRouteSearch,
} from "../../rightPanelRouteSearch";
import { copyRightPanelSessionSearch } from "../../rightPanelSessionState";
import { useStore } from "../../store";
import { createThreadSelectorAcrossEnvironments } from "../../storeSelectors";
import { buildThreadRouteParams } from "../../threadRoutes";
import { buildOpenSimulatorSearch } from "../../workspaceRouteSearch";
import ChatView from "../ChatView";
import { threadIsPromotedAndPersisted } from "../ChatView.logic";
import { LazyRightPanel, RightPanelInlineSidebar } from "../ChatRightPanel";
import { RightPanelSheet } from "../RightPanelSheet";
import { PhoneWorkSurfaceSheet } from "../shell/phone/PhoneWorkSurface";
import { SidebarInset } from "../ui/sidebar";
import { cn } from "~/lib/utils";

export function DraftChatThreadRouteView({
  rawDraftId,
  search,
}: {
  rawDraftId: string;
  search: RightPanelRouteSearch;
}) {
  const navigate = useNavigate();
  const draftId = DraftId.make(rawDraftId);
  const rightPanelThreadKey = `draft:${draftId}`;
  const replaceThreadRightPanelSearch = useCallback(
    (nextSearch: RightPanelRouteSearch) => {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: true,
        search: nextSearch,
      });
    },
    [draftId, navigate],
  );
  const threadSearch = useThreadRightPanelRouteState({
    threadKey: rightPanelThreadKey,
    search,
    replaceSearch: replaceThreadRightPanelSearch,
  });
  const draftSession = useDraftSession(draftId);
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStarted = threadIsPromotedAndPersisted(serverThread);
  const canonicalThreadRef = useMemo(
    () =>
      draftSession?.promotedTo
        ? serverThreadStarted
          ? draftSession.promotedTo
          : null
        : serverThread
          ? {
              environmentId: serverThread.environmentId,
              threadId: serverThread.id,
            }
          : null,
    [draftSession?.promotedTo, serverThread, serverThreadStarted],
  );

  const rightPanelMode: RightPanelMode | null = getRightPanelMode(threadSearch);
  const rightPanelOpen = isRightPanelOpen(threadSearch);
  const activeAgentKey =
    threadSearch.workspaceTab === "agent" && threadSearch.workspaceAgentKey
      ? threadSearch.workspaceAgentKey
      : null;
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const presentationTier = usePresentationTier();
  const canonicalThreadKey = canonicalThreadRef
    ? `${canonicalThreadRef.environmentId}:${canonicalThreadRef.threadId}`
    : null;
  const pendingDeviceOpenRequest = useDeviceStateStore((state) =>
    canonicalThreadKey ? state.pendingOpenByThreadKey[canonicalThreadKey] : undefined,
  );
  const consumeDeviceOpenRequest = useDeviceStateStore((state) => state.consumeOpenRequest);
  const appSidebarCollapsed = useAppSidebarCollapsed();
  // Maximizing only means anything for the inline split — the sheet and the
  // phone work surface already cover the viewport.
  const { maximized: rightPanelMaximized, toggleMaximized: toggleRightPanelMaximized } =
    useRightPanelMaximized({
      threadKey: draftId,
      open: rightPanelOpen,
      canMaximize: !shouldUseDiffSheet && presentationTier !== "phone",
    });
  useEffect(() => {
    if (!canonicalThreadRef || !pendingDeviceOpenRequest || presentationTier === "phone") return;
    consumeDeviceOpenRequest(canonicalThreadRef.environmentId, canonicalThreadRef.threadId);
    void navigate({
      to: "/draft/$draftId",
      params: { draftId },
      search: (previous) => buildOpenSimulatorSearch(previous),
    });
  }, [
    canonicalThreadRef,
    consumeDeviceOpenRequest,
    draftId,
    navigate,
    pendingDeviceOpenRequest,
    presentationTier,
  ]);
  const navigateDraftSearch = useCallback(
    (update: RightPanelSearchUpdate) => {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        search: update,
      });
    },
    [draftId, navigate],
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
    scopeKey: draftId,
    rightPanelMode,
    rightPanelOpen,
    activeAgentKey,
    defaultLastMode: "files",
    navigateSearch: navigateDraftSearch,
  });

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    copyRightPanelSessionSearch(
      rightPanelThreadKey,
      `${canonicalThreadRef.environmentId}:${canonicalThreadRef.threadId}`,
    );
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
    });
  }, [canonicalThreadRef, navigate, rightPanelThreadKey]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  const mountedRightPanelMode: RightPanelMode | null = rightPanelOpen
    ? rightPanelMode
    : lastOpenedRightPanelMode;

  // Phone tier: full-screen work-surface promotion over the draft thread,
  // driven by the same URL search params as the desktop presentations.
  if (presentationTier === "phone") {
    return (
      <>
        <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
          <ChatView
            draftId={draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            onDiffPanelOpen={() => markRightPanelOpened("review")}
            onPreviewPanelOpen={() => markRightPanelOpened("files")}
            onTerminalPanelOpen={() => markRightPanelOpened("terminal")}
            onAgentPanelOpen={() => markRightPanelOpened("agent")}
            workspacePanelOpen={rightPanelOpen}
            onToggleWorkspacePanel={toggleRightPanel}
            routeKind="draft"
          />
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
        {/* Maximized: the chat column keeps its subtree mounted (draft
            composer state above all) but gives up all of its width and goes
            inert so nothing behind the panel stays focusable. */}
        <SidebarInset
          className={cn(
            "h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh",
            rightPanelMaximized && "w-0 flex-none",
          )}
          inert={rightPanelMaximized ? true : undefined}
        >
          <ChatView
            draftId={draftId}
            environmentId={draftSession.environmentId}
            threadId={draftSession.threadId}
            onDiffPanelOpen={() => markRightPanelOpened("review")}
            onPreviewPanelOpen={() => markRightPanelOpened("files")}
            onTerminalPanelOpen={() => markRightPanelOpened("terminal")}
            onAgentPanelOpen={() => markRightPanelOpened("agent")}
            workspacePanelOpen={rightPanelOpen}
            onToggleWorkspacePanel={toggleRightPanel}
            routeKind="draft"
          />
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
        <ChatView
          draftId={draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          onDiffPanelOpen={() => markRightPanelOpened("review")}
          onPreviewPanelOpen={() => markRightPanelOpened("files")}
          onTerminalPanelOpen={() => markRightPanelOpened("terminal")}
          onAgentPanelOpen={() => markRightPanelOpened("agent")}
          workspacePanelOpen={rightPanelOpen}
          onToggleWorkspacePanel={toggleRightPanel}
          routeKind="draft"
        />
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
