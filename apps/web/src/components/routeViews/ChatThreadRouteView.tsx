import type { ScopedThreadRef } from "@ryco/contracts";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import {
  buildOpenAgentSearch,
  buildOpenAgentsSearch,
  buildOpenFilesSearch,
  buildOpenReviewSearch,
  buildOpenSimulatorSearch,
  buildOpenBrowserSearch,
  buildOpenTerminalSearch,
  buildOpenWorkspaceSearch,
} from "../../workspaceRouteSearch";
import ChatView from "../ChatView";
import { threadHasStarted } from "../ChatView.logic";
import { LazyRightPanel, RightPanelInlineSidebar, closeRightPanelSearch } from "../ChatRightPanel";
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
    routeThreadExists && (bootstrapComplete || serverThread !== undefined);
  const diffOpen = threadSearch.diff === "1";
  const previewOpen = threadSearch.preview === "1";
  const rightPanelMode: RightPanelMode | null = getRightPanelMode(threadSearch);
  const rightPanelOpen = isRightPanelOpen(threadSearch);
  const activeAgentKey =
    threadSearch.workspaceTab === "agent" && threadSearch.workspaceAgentKey
      ? threadSearch.workspaceAgentKey
      : null;
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const presentationTier = usePresentationTier();
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
  const [diffPanelMountState, setDiffPanelMountState] = useState(() => ({
    threadKey: currentThreadKey,
    hasOpenedDiff: diffOpen,
    hasOpenedPreview: previewOpen,
    hasOpenedTerminal: rightPanelMode === "terminal",
    hasOpenedSimulator: rightPanelMode === "simulator",
    hasOpenedBrowser: rightPanelMode === "browser",
    hasOpenedAgents: rightPanelMode === "agents",
    openedAgentKeys: activeAgentKey ? [activeAgentKey] : [],
  }));
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
  const hasOpenedDiff =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedDiff
      : diffOpen;
  const hasOpenedPreview =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedPreview
      : previewOpen;
  const hasOpenedTerminal =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedTerminal
      : rightPanelMode === "terminal";
  const hasOpenedSimulator =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedSimulator
      : rightPanelMode === "simulator";
  const hasOpenedBrowser =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedBrowser
      : rightPanelMode === "browser";
  const hasOpenedAgents =
    diffPanelMountState.threadKey === currentThreadKey
      ? diffPanelMountState.hasOpenedAgents
      : rightPanelMode === "agents";
  const openedAgentKeys = useMemo(() => {
    const keys =
      diffPanelMountState.threadKey === currentThreadKey
        ? diffPanelMountState.openedAgentKeys
        : activeAgentKey
          ? [activeAgentKey]
          : [];
    return activeAgentKey && !keys.includes(activeAgentKey) ? [...keys, activeAgentKey] : keys;
  }, [activeAgentKey, currentThreadKey, diffPanelMountState]);
  const [lastOpenedRightPanelMode, setLastOpenedRightPanelMode] = useState<RightPanelMode>(
    () => rightPanelMode ?? "review",
  );
  const openedPanelModes = useMemo(() => {
    const modes: RightPanelMode[] = [];
    if (hasOpenedPreview || rightPanelMode === "files") {
      modes.push("files");
    }
    if (hasOpenedDiff || rightPanelMode === "review") {
      modes.push("review");
    }
    if (hasOpenedTerminal || rightPanelMode === "terminal") {
      modes.push("terminal");
    }
    if (hasOpenedSimulator || rightPanelMode === "simulator") {
      modes.push("simulator");
    }
    if (hasOpenedBrowser || rightPanelMode === "browser") {
      modes.push("browser");
    }
    if (hasOpenedAgents || rightPanelMode === "agents") {
      modes.push("agents");
    }
    return modes;
  }, [
    hasOpenedAgents,
    hasOpenedDiff,
    hasOpenedPreview,
    hasOpenedSimulator,
    hasOpenedBrowser,
    hasOpenedTerminal,
    rightPanelMode,
  ]);
  const markRightPanelOpened = useCallback(
    (panelMode: RightPanelMode) => {
      setLastOpenedRightPanelMode(panelMode);
      setDiffPanelMountState((previous) => {
        const nextState = {
          threadKey: currentThreadKey,
          hasOpenedDiff:
            (previous.threadKey === currentThreadKey ? previous.hasOpenedDiff : diffOpen) ||
            panelMode === "review",
          hasOpenedPreview:
            (previous.threadKey === currentThreadKey ? previous.hasOpenedPreview : previewOpen) ||
            panelMode === "files",
          hasOpenedTerminal:
            (previous.threadKey === currentThreadKey
              ? previous.hasOpenedTerminal
              : rightPanelMode === "terminal") || panelMode === "terminal",
          hasOpenedSimulator:
            (previous.threadKey === currentThreadKey
              ? previous.hasOpenedSimulator
              : rightPanelMode === "simulator") || panelMode === "simulator",
          hasOpenedBrowser:
            (previous.threadKey === currentThreadKey
              ? previous.hasOpenedBrowser
              : rightPanelMode === "browser") || panelMode === "browser",
          hasOpenedAgents:
            (previous.threadKey === currentThreadKey
              ? previous.hasOpenedAgents
              : rightPanelMode === "agents") || panelMode === "agents",
          openedAgentKeys:
            previous.threadKey === currentThreadKey ? previous.openedAgentKeys : openedAgentKeys,
        };
        if (
          previous.threadKey === nextState.threadKey &&
          previous.hasOpenedDiff === nextState.hasOpenedDiff &&
          previous.hasOpenedPreview === nextState.hasOpenedPreview &&
          previous.hasOpenedTerminal === nextState.hasOpenedTerminal &&
          previous.hasOpenedSimulator === nextState.hasOpenedSimulator &&
          previous.hasOpenedBrowser === nextState.hasOpenedBrowser &&
          previous.hasOpenedAgents === nextState.hasOpenedAgents &&
          previous.openedAgentKeys === nextState.openedAgentKeys
        ) {
          return previous;
        }
        return nextState;
      });
    },
    [currentThreadKey, diffOpen, openedAgentKeys, previewOpen, rightPanelMode],
  );
  const closeRightPanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: (previous) => closeRightPanelSearch(previous),
    });
  }, [navigate, threadRef]);
  const openRightPanel = useCallback(() => {
    if (!threadRef) {
      return;
    }
    const nextSearch = (previous: Record<string, unknown>) => {
      const lastAgentKey = openedAgentKeys[openedAgentKeys.length - 1];
      if (lastOpenedRightPanelMode === "agent" && lastAgentKey) {
        return buildOpenAgentSearch(previous, lastAgentKey);
      }
      if (lastOpenedRightPanelMode === "files" && hasOpenedPreview) {
        return buildOpenFilesSearch(previous);
      }
      if (lastOpenedRightPanelMode === "review" && hasOpenedDiff) {
        return buildOpenReviewSearch(previous);
      }
      if (lastOpenedRightPanelMode === "terminal" && hasOpenedTerminal) {
        return buildOpenTerminalSearch(previous);
      }
      if (lastOpenedRightPanelMode === "simulator" && hasOpenedSimulator) {
        return buildOpenSimulatorSearch(previous);
      }
      if (lastOpenedRightPanelMode === "browser" && hasOpenedBrowser) {
        return buildOpenBrowserSearch(previous);
      }
      if (lastOpenedRightPanelMode === "agents" && hasOpenedAgents) {
        return buildOpenAgentsSearch(previous);
      }
      if (hasOpenedPreview) {
        return buildOpenFilesSearch(previous);
      }
      if (hasOpenedDiff) {
        return buildOpenReviewSearch(previous);
      }
      if (hasOpenedTerminal) {
        return buildOpenTerminalSearch(previous);
      }
      if (hasOpenedSimulator) {
        return buildOpenSimulatorSearch(previous);
      }
      if (hasOpenedBrowser) {
        return buildOpenBrowserSearch(previous);
      }
      if (hasOpenedAgents) {
        return buildOpenAgentsSearch(previous);
      }
      if (lastAgentKey) {
        return buildOpenAgentSearch(previous, lastAgentKey);
      }
      return buildOpenWorkspaceSearch(previous);
    };
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      search: nextSearch,
    });
  }, [
    hasOpenedAgents,
    hasOpenedDiff,
    hasOpenedPreview,
    hasOpenedSimulator,
    hasOpenedBrowser,
    hasOpenedTerminal,
    lastOpenedRightPanelMode,
    navigate,
    openedAgentKeys,
    threadRef,
  ]);
  const toggleRightPanel = useCallback(() => {
    if (rightPanelOpen) {
      closeRightPanel();
      return;
    }
    openRightPanel();
  }, [closeRightPanel, openRightPanel, rightPanelOpen]);
  const closePanelTab = useCallback(
    (input: { mode: RightPanelMode; agentKey?: string }) => {
      if (!threadRef) {
        return;
      }
      if (input.mode === "agent") {
        const nextOpenedAgentKeys = openedAgentKeys.filter((key) => key !== input.agentKey);
        setDiffPanelMountState((previous) => ({
          threadKey: currentThreadKey,
          hasOpenedDiff:
            previous.threadKey === currentThreadKey ? previous.hasOpenedDiff : hasOpenedDiff,
          hasOpenedPreview:
            previous.threadKey === currentThreadKey ? previous.hasOpenedPreview : hasOpenedPreview,
          hasOpenedTerminal:
            previous.threadKey === currentThreadKey
              ? previous.hasOpenedTerminal
              : hasOpenedTerminal,
          hasOpenedSimulator:
            previous.threadKey === currentThreadKey
              ? previous.hasOpenedSimulator
              : hasOpenedSimulator,
          hasOpenedBrowser:
            previous.threadKey === currentThreadKey ? previous.hasOpenedBrowser : hasOpenedBrowser,
          hasOpenedAgents:
            previous.threadKey === currentThreadKey ? previous.hasOpenedAgents : hasOpenedAgents,
          openedAgentKeys: nextOpenedAgentKeys,
        }));

        if (rightPanelMode === "agent" && activeAgentKey === input.agentKey) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
            search: (previous) => {
              const nextAgentKey = nextOpenedAgentKeys[nextOpenedAgentKeys.length - 1];
              if (nextAgentKey) {
                return buildOpenAgentSearch(previous, nextAgentKey);
              }
              if (hasOpenedPreview) {
                return buildOpenFilesSearch(previous);
              }
              if (hasOpenedDiff) {
                return buildOpenReviewSearch(previous);
              }
              if (hasOpenedTerminal) {
                return buildOpenTerminalSearch(previous);
              }
              if (hasOpenedSimulator) {
                return buildOpenSimulatorSearch(previous);
              }
              if (hasOpenedBrowser) {
                return buildOpenBrowserSearch(previous);
              }
              if (hasOpenedAgents) {
                return buildOpenAgentsSearch(previous);
              }
              return buildOpenWorkspaceSearch(previous);
            },
          });
        }
        return;
      }

      const nextHasOpenedDiff =
        input.mode === "review" ? false : hasOpenedDiff || rightPanelMode === "review";
      const nextHasOpenedPreview =
        input.mode === "files" ? false : hasOpenedPreview || rightPanelMode === "files";
      const nextHasOpenedTerminal =
        input.mode === "terminal" ? false : hasOpenedTerminal || rightPanelMode === "terminal";
      const nextHasOpenedSimulator =
        input.mode === "simulator" ? false : hasOpenedSimulator || rightPanelMode === "simulator";
      const nextHasOpenedBrowser =
        input.mode === "browser" ? false : hasOpenedBrowser || rightPanelMode === "browser";
      const nextHasOpenedAgents =
        input.mode === "agents" ? false : hasOpenedAgents || rightPanelMode === "agents";
      setDiffPanelMountState((previous) => {
        const nextState = {
          threadKey: currentThreadKey,
          hasOpenedDiff: nextHasOpenedDiff,
          hasOpenedPreview: nextHasOpenedPreview,
          hasOpenedTerminal: nextHasOpenedTerminal,
          hasOpenedSimulator: nextHasOpenedSimulator,
          hasOpenedBrowser: nextHasOpenedBrowser,
          hasOpenedAgents: nextHasOpenedAgents,
          openedAgentKeys:
            previous.threadKey === currentThreadKey ? previous.openedAgentKeys : openedAgentKeys,
        };
        if (
          previous.threadKey === nextState.threadKey &&
          previous.hasOpenedDiff === nextState.hasOpenedDiff &&
          previous.hasOpenedPreview === nextState.hasOpenedPreview &&
          previous.hasOpenedTerminal === nextState.hasOpenedTerminal &&
          previous.hasOpenedSimulator === nextState.hasOpenedSimulator &&
          previous.hasOpenedBrowser === nextState.hasOpenedBrowser &&
          previous.hasOpenedAgents === nextState.hasOpenedAgents &&
          previous.openedAgentKeys === nextState.openedAgentKeys
        ) {
          return previous;
        }
        return nextState;
      });

      if (rightPanelMode !== input.mode) {
        return;
      }

      const nextSearch = (previous: Record<string, unknown>) => {
        if (input.mode !== "files" && nextHasOpenedPreview) {
          return buildOpenFilesSearch(previous);
        }
        if (input.mode !== "review" && nextHasOpenedDiff) {
          return buildOpenReviewSearch(previous);
        }
        if (input.mode !== "terminal" && nextHasOpenedTerminal) {
          return buildOpenTerminalSearch(previous);
        }
        if (input.mode !== "simulator" && nextHasOpenedSimulator) {
          return buildOpenSimulatorSearch(previous);
        }
        if (input.mode !== "browser" && nextHasOpenedBrowser) {
          return buildOpenBrowserSearch(previous);
        }
        if (input.mode !== "agents" && nextHasOpenedAgents) {
          return buildOpenAgentsSearch(previous);
        }
        return buildOpenWorkspaceSearch(previous);
      };
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: nextSearch,
      });
    },
    [
      currentThreadKey,
      activeAgentKey,
      hasOpenedAgents,
      hasOpenedDiff,
      hasOpenedPreview,
      hasOpenedSimulator,
      hasOpenedBrowser,
      hasOpenedTerminal,
      navigate,
      openedAgentKeys,
      rightPanelMode,
      threadRef,
    ],
  );

  useEffect(() => {
    if (rightPanelMode !== null) {
      setLastOpenedRightPanelMode(rightPanelMode);
      markRightPanelOpened(rightPanelMode);
    }
  }, [markRightPanelOpened, rightPanelMode]);

  useEffect(() => {
    if (!currentThreadKey || !activeAgentKey) {
      return;
    }
    setDiffPanelMountState((previous) => {
      const baseAgentKeys = previous.threadKey === currentThreadKey ? previous.openedAgentKeys : [];
      if (baseAgentKeys.includes(activeAgentKey)) {
        return previous.threadKey === currentThreadKey
          ? previous
          : {
              threadKey: currentThreadKey,
              hasOpenedDiff,
              hasOpenedPreview,
              hasOpenedTerminal,
              hasOpenedSimulator,
              hasOpenedBrowser,
              hasOpenedAgents,
              openedAgentKeys: baseAgentKeys,
            };
      }
      return {
        threadKey: currentThreadKey,
        hasOpenedDiff: previous.threadKey === currentThreadKey ? previous.hasOpenedDiff : diffOpen,
        hasOpenedPreview:
          previous.threadKey === currentThreadKey ? previous.hasOpenedPreview : previewOpen,
        hasOpenedTerminal:
          previous.threadKey === currentThreadKey
            ? previous.hasOpenedTerminal
            : rightPanelMode === "terminal",
        hasOpenedSimulator:
          previous.threadKey === currentThreadKey
            ? previous.hasOpenedSimulator
            : rightPanelMode === "simulator",
        hasOpenedBrowser:
          previous.threadKey === currentThreadKey
            ? previous.hasOpenedBrowser
            : rightPanelMode === "browser",
        hasOpenedAgents:
          previous.threadKey === currentThreadKey
            ? previous.hasOpenedAgents
            : rightPanelMode === "agents",
        openedAgentKeys: [...baseAgentKeys, activeAgentKey],
      };
    });
  }, [
    activeAgentKey,
    currentThreadKey,
    diffOpen,
    hasOpenedAgents,
    hasOpenedDiff,
    hasOpenedPreview,
    hasOpenedSimulator,
    hasOpenedBrowser,
    hasOpenedTerminal,
    previewOpen,
    rightPanelMode,
  ]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
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

  const shouldRenderRightPanelContent =
    rightPanelOpen ||
    rightPanelMode === "review" ||
    hasOpenedDiff ||
    rightPanelMode === "files" ||
    hasOpenedPreview ||
    rightPanelMode === "terminal" ||
    hasOpenedTerminal ||
    rightPanelMode === "simulator" ||
    hasOpenedSimulator ||
    rightPanelMode === "browser" ||
    hasOpenedBrowser ||
    rightPanelMode === "agents" ||
    hasOpenedAgents ||
    rightPanelMode === "agent" ||
    openedAgentKeys.length > 0;
  // The frozen phone tier has no Agents workspace: agents state neither
  // mounts nor retains the phone work surface.
  const shouldRenderPhoneRightPanelContent =
    rightPanelOpen ||
    rightPanelMode === "review" ||
    hasOpenedDiff ||
    rightPanelMode === "files" ||
    hasOpenedPreview ||
    rightPanelMode === "terminal" ||
    hasOpenedTerminal ||
    rightPanelMode === "agent" ||
    openedAgentKeys.length > 0;
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
