import { applyInboxServerConfig } from "./inboxSidebar/inboxSidebarModel";
import { useDeviceName } from "../deviceName";
import { isLocalHubAlias } from "../deviceName.logic";
import { useServerConfig } from "~/rpc/serverState";
import { autoAnimate, type AnimationController } from "@formkit/auto-animate";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  type DesktopUpdateState,
  type EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
} from "@ryco/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import { getWsConnectionUiState } from "@ryco/client-runtime/rpc";
import { getQueuedThreadKeys } from "@ryco/client-runtime/state/message-queue";
import { isWorkspaceMetadataSnapshot } from "@ryco/client-runtime/state/workspace";
import { useNavigate, useParams } from "@tanstack/react-router";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import { useHostedHubStore } from "../hostedHub/state";
import { isElectron } from "../env";
import { isTerminalFocused } from "../lib/terminalFocus";
import { PREFERS_REDUCED_MOTION_QUERY, shouldEnableAutoAnimate } from "../lib/perf/motion";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarWorktreesAcrossEnvironments,
  useStore,
} from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  parseProjectTreeItemId,
  projectFolderTreeItemId,
  projectTreeItemId,
  type SidebarMode,
  type UiProjectTreeItemId,
  useUiStateStore,
} from "../uiStateStore";
import {
  resolveShortcutCommand,
  hasOpenDialogShortcutTarget,
  shouldIgnoreGlobalNavigationShortcut,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useModelPickerOpen } from "../modelPickerOpenState";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useMediaQuery } from "../hooks/useMediaQuery";

import { useThreadActions } from "../hooks/useThreadActions";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { usePerfMark } from "../perf/tabSwitchInstrumentation";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { SidebarSeparator, useSidebar } from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  orderItemsByPreferredIds,
  shouldAutoAnimateSidebarProjectList,
  shouldAutoAnimateSidebarThreadLists,
  shouldClearThreadSelectionOnMouseDown,
  shouldPrewarmSidebarThreads,
  sortProjectsForSidebar,
  sortThreadsWithPinned,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { adaptProjectForSidebarTree } from "./sidebar/sidebarTreeAdapters";
import { composeSidebarTree } from "./sidebar/hooks/useSidebarTree";
import { SidebarProjectsContent, PROJECT_ROOT_DROP_ID } from "./sidebar/SidebarProjectList";
import { SidebarProjectItem } from "./sidebar/SidebarProjectItem";
import { SidebarProjectDialogProvider } from "./sidebar/SidebarProjectDialogOwner";
import { SidebarChromeHeader, SidebarChromeFooter } from "./sidebar/SidebarChrome";
import { SidebarNewThreadButton } from "./sidebar/SidebarNewThreadButton";
import { resolveNewThreadProjectKey } from "./sidebar/sidebarNewThreadTarget";
import { ConnectedInboxSidebar } from "./inboxSidebar/ConnectedInboxSidebar";
import {
  buildPrimaryInboxSidebarEnvironment,
  type InboxSidebarEnvironment,
} from "./inboxSidebar/inboxSidebarModel";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { derivePhysicalProjectKey, getProjectOrderKey } from "../logicalProject";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import type { SidebarThreadSummary } from "../types";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { buildSidebarProjectFolderTree } from "../sidebarProjectFolders";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import { useHostedWorkspaceState } from "../hostedHub/hostedConnectionCoordinator";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { useMessageQueueStore } from "../messageQueueStore";
import { useSidebarThreadPrewarm } from "./sidebar/hooks/useSidebarThreadPrewarm";

const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
type SidebarAutoAnimateControllers = Map<HTMLElement, AnimationController>;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();

function pruneDisconnectedSidebarAutoAnimateControllers(
  controllers: SidebarAutoAnimateControllers,
) {
  for (const [node] of controllers) {
    if (!node.isConnected) {
      controllers.delete(node);
    }
  }
}

function setSidebarAutoAnimateControllersEnabled(
  controllers: SidebarAutoAnimateControllers,
  enabled: boolean,
) {
  pruneDisconnectedSidebarAutoAnimateControllers(controllers);
  for (const controller of controllers.values()) {
    if (enabled) {
      controller.enable();
    } else {
      controller.disable();
    }
  }
}

function attachSidebarAutoAnimateNode(
  controllers: SidebarAutoAnimateControllers,
  node: HTMLElement | null,
  enabled: boolean,
) {
  if (node === null) {
    return;
  }
  pruneDisconnectedSidebarAutoAnimateControllers(controllers);
  let controller = controllers.get(node);
  if (controller === undefined) {
    if (!enabled) {
      return;
    }
    controller = autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    controllers.set(node, controller);
  }
  if (enabled) {
    controller.enable();
  } else {
    controller.disable();
  }
}

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

export default function Sidebar() {
  usePerfMark("Sidebar");
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const sidebarWorktrees = useStore(useShallow(selectSidebarWorktreesAcrossEnvironments));
  const environmentStateById = useStore((state) => state.environmentStateById);
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);
  const setSidebarMode = useUiStateStore((store) => store.setSidebarMode);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projectFoldersById = useUiStateStore((store) => store.projectFoldersById);
  const projectFolderOrder = useUiStateStore((store) => store.projectFolderOrder);
  const projectTreeOrder = useUiStateStore((store) => store.projectTreeOrder);
  const pinnedThreadKeysRecord = useUiStateStore((store) => store.pinnedThreadKeys);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const moveProjectsToFolder = useUiStateStore((store) => store.moveProjectsToFolder);
  const moveProjectsToRoot = useUiStateStore((store) => store.moveProjectsToRoot);
  const reorderProjectTreeItem = useUiStateStore((store) => store.reorderProjectTreeItem);
  const navigate = useNavigate();
  const sidebarThreadSortOrder = useSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useSettings((s) => s.sidebarProjectSortOrder);
  const sidebarProjectGroupingMode = useSettings((s) => s.sidebarProjectGroupingMode);
  const aiFocusEnabled = useSettings((s) => s.aiFocusEnabled);
  const sidebarAutoSettleAfterDays = useSettings((s) => s.sidebarAutoSettleAfterDays);
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread } = useNewThreadHandler();
  const { archiveThread, deleteThread } = useThreadActions();
  const { isMobile, open, openMobile, setOpen, setOpenMobile } = useSidebar();
  const pinnedThreadKeys = useMemo(
    () =>
      new Set(
        Object.entries(pinnedThreadKeysRecord).flatMap(([threadKey, pinned]) =>
          pinned ? [threadKey] : [],
        ),
      ),
    [pinnedThreadKeysRecord],
  );
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeDraftId = useParams({
    strict: false,
    select: (params) => (typeof params.draftId === "string" ? (params.draftId as DraftId) : null),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeDraftThread = useComposerDraftStore(
    useMemo(
      () => (store) =>
        routeDraftId ? (store.draftThreadsByThreadKey[routeDraftId] ?? null) : null,
      [routeDraftId],
    ),
  );
  const routeDraftThreadKey = routeDraftThread
    ? scopedThreadKey(scopeThreadRef(routeDraftThread.environmentId, routeDraftThread.threadId))
    : null;
  const activeRouteThreadKey = routeThreadKey ?? routeDraftThreadKey;
  const keybindings = useServerKeybindings();
  const openAddProjectCommandPalette = useCommandPaletteStore((store) => store.openAddProject);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedThreadCount = useThreadSelectionStore((s) => s.selectedThreadKeys.size);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const modelPickerOpen = useModelPickerOpen();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironmentDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryWsConnectionStatus = useWsConnectionStatus();
  const primaryConnectionState = getWsConnectionUiState(primaryWsConnectionStatus);
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const primaryDeviceName = useDeviceName();
  const desktopWorkspace = useDesktopWorkspaceState();
  const hostedWorkspace = useHostedWorkspaceState();
  const selectedHostedEnvironmentId = useHostedHubStore(
    (state) => state.selectedNode?.environmentId ?? null,
  );
  const queuesByThreadKey = useMessageQueueStore((state) => state.queuesByThreadKey);
  const localQueuedThreadKeys = useMemo(
    () => getQueuedThreadKeys(queuesByThreadKey),
    [queuesByThreadKey],
  );
  const handleSidebarModeChange = useCallback(
    (mode: SidebarMode) => {
      setOpen(true);
      if (mode === sidebarMode) return;
      clearSelection();
      setSidebarMode(mode);
    },
    [clearSelection, setOpen, setSidebarMode, sidebarMode],
  );
  const inboxServerConfig = useServerConfig();
  const inboxEnvironments = useMemo<ReadonlyArray<InboxSidebarEnvironment>>(() => {
    const knownEnvironmentIds = new Set<EnvironmentId>();
    for (const project of projects) knownEnvironmentIds.add(project.environmentId);
    for (const thread of sidebarThreads) knownEnvironmentIds.add(thread.environmentId);
    for (const environmentId of Object.keys(savedEnvironmentRegistry) as EnvironmentId[]) {
      knownEnvironmentIds.add(environmentId);
    }
    const byEnvironmentId = new Map<EnvironmentId, InboxSidebarEnvironment>();

    if (hostedWorkspace.status !== "signed-out") {
      for (const machine of hostedWorkspace.machines) {
        knownEnvironmentIds.add(machine.environmentId);
        const queued = hostedWorkspace.demand.queuedEnvironmentIds.includes(machine.environmentId);
        const stale = !machine.presence.online || machine.cacheDisposition !== "available";
        byEnvironmentId.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          connectionState: !machine.presence.online
            ? "offline"
            : machine.connectionState === "connected"
              ? "connected"
              : queued
                ? "reconnecting"
                : machine.connectionState === "connecting"
                  ? "connecting"
                  : "idle",
          stale,
          ...(stale ? { staleDetail: "Offline · last known" } : {}),
          role: machine.effectiveRole,
          trust: machine.nativeTrust,
          deliveryUnknown: machine.deliveryUnknown,
          threadSnoozeSupported:
            (machine.environmentId === primaryEnvironmentId
              ? primaryEnvironmentDescriptor?.capabilities.threadSnooze
              : undefined) ??
            machine.capabilities.threadSnooze ??
            false,
          threadSettlementSupported:
            machine.environmentId === primaryEnvironmentId
              ? (primaryEnvironmentDescriptor?.capabilities.threadSettlement ??
                machine.capabilities.threadSettlement)
              : machine.capabilities.threadSettlement,
          mutationReady: machine.canMutate && machine.connectionState === "connected" && !stale,
          shellCurrent: !stale,
        });
      }
    } else if (desktopWorkspace.status !== "signed-out") {
      for (const machine of desktopWorkspace.machines) {
        if (
          isLocalHubAlias(
            machine.environmentId,
            primaryEnvironmentId,
            desktopWorkspace.localEnvironmentId,
          )
        )
          continue;
        knownEnvironmentIds.add(machine.environmentId);
        const queued = desktopWorkspace.queuedEnvironmentIds.includes(machine.environmentId);
        const stale =
          !machine.online ||
          environmentStateById[machine.environmentId]?.hydratedFromCacheAt !== undefined;
        byEnvironmentId.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          connectionState: !machine.online
            ? "offline"
            : machine.connectionState === "connected"
              ? "connected"
              : queued
                ? "reconnecting"
                : machine.connectionState === "connecting"
                  ? "connecting"
                  : "idle",
          stale,
          ...(stale ? { staleDetail: "Offline · last known" } : {}),
          role: null,
          trust: machine.nativeTrust,
          deliveryUnknown: false,
          threadSettlementSupported: machine.threadSettlementSupported,
          mutationReady: machine.canMutate && machine.connectionState === "connected" && !stale,
          shellCurrent: !stale,
        });
      }
    }

    for (const environmentId of knownEnvironmentIds) {
      if (isLocalHubAlias(environmentId, primaryEnvironmentId, desktopWorkspace.localEnvironmentId))
        continue;
      if (byEnvironmentId.has(environmentId)) continue;
      if (primaryEnvironmentId !== null && environmentId === primaryEnvironmentId) {
        byEnvironmentId.set(
          environmentId,
          buildPrimaryInboxSidebarEnvironment({
            label: primaryDeviceName,
            environmentId,
            connectionState: primaryConnectionState,
            hydratedFromCache:
              environmentStateById[environmentId]?.hydratedFromCacheAt !== undefined,
            threadSnoozeSupported: primaryEnvironmentDescriptor?.capabilities.threadSnooze ?? false,
            threadSettlementSupported:
              primaryEnvironmentDescriptor?.capabilities.threadSettlement ?? false,
          }),
        );
        continue;
      }
      const runtime = savedEnvironmentRuntimeById[environmentId];
      const saved = savedEnvironmentRegistry[environmentId];
      const cached = environmentStateById[environmentId]?.hydratedFromCacheAt !== undefined;
      const connectionState = runtime?.connectionState ?? "disconnected";
      const stale = cached || connectionState !== "connected";
      byEnvironmentId.set(environmentId, {
        environmentId,
        label: runtime?.descriptor?.label ?? saved?.label ?? environmentId,
        connectionState:
          connectionState === "connected"
            ? "connected"
            : connectionState === "connecting"
              ? "connecting"
              : connectionState === "error"
                ? "reconnecting"
                : "offline",
        stale,
        ...(stale ? { staleDetail: "Offline · last known" } : {}),
        role: runtime?.role ?? null,
        trust: "unknown",
        deliveryUnknown: false,
        threadSnoozeSupported: runtime?.descriptor?.capabilities.threadSnooze ?? false,
        threadSettlementSupported: runtime?.descriptor?.capabilities.threadSettlement ?? false,
        mutationReady:
          connectionState === "connected" &&
          (runtime?.role === "owner" || runtime?.role === "client") &&
          !stale,
        shellCurrent: !stale,
      });
    }
    return [...byEnvironmentId.values()]
      .map((environment) =>
        applyInboxServerConfig(
          environment,
          environment.environmentId === primaryEnvironmentId
            ? inboxServerConfig
            : savedEnvironmentRuntimeById[environment.environmentId]?.serverConfig,
        ),
      )
      .toSorted((left, right) => left.label.localeCompare(right.label));
  }, [
    inboxServerConfig,
    desktopWorkspace,
    environmentStateById,
    hostedWorkspace,
    primaryConnectionState,
    primaryEnvironmentDescriptor,
    primaryDeviceName,
    primaryEnvironmentId,
    projects,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    sidebarThreads,
  ]);
  const deliveryUnknownThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const thread of hostedWorkspace.workspace.threads) {
      if (thread.deliveryUnknown) {
        keys.add(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
      }
    }
    for (const projection of desktopWorkspace.snapshots) {
      if (!isWorkspaceMetadataSnapshot(projection, projection.environmentId)) continue;
      for (const thread of projection.threads) {
        if (thread.deliveryUnknown) {
          keys.add(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
        }
      }
    }
    return keys;
  }, [desktopWorkspace.snapshots, hostedWorkspace.workspace.threads]);
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);

  // Target for the sidebar-level "New thread" button: the project whose thread
  // was most recently opened or updated, falling back to sidebar order on a
  // fresh install so the button is never a dead end.
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const newThreadTargetProject = useMemo(() => {
    const targetProjects =
      selectedHostedEnvironmentId === null
        ? orderedProjects
        : orderedProjects.filter(
            (project) => project.environmentId === selectedHostedEnvironmentId,
          );
    const projectKeyOf = (project: (typeof orderedProjects)[number]) =>
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    const targetKey = resolveNewThreadProjectKey({
      orderedProjectKeys: targetProjects.map(projectKeyOf),
      threads:
        selectedHostedEnvironmentId === null
          ? sidebarThreads
          : sidebarThreads.filter((thread) => thread.environmentId === selectedHostedEnvironmentId),
      lastVisitedAtByThreadKey: new Map(
        Object.entries(threadLastVisitedAtById).map(([key, visitedAt]) => {
          const parsed = Date.parse(visitedAt);
          return [key, Number.isNaN(parsed) ? null : parsed] as const;
        }),
      ),
      threadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      threadProjectKey: (thread) =>
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    });
    return targetKey
      ? (targetProjects.find((project) => projectKeyOf(project) === targetKey) ?? null)
      : null;
  }, [orderedProjects, selectedHostedEnvironmentId, sidebarThreads, threadLastVisitedAtById]);
  const startNewThreadFromSidebar = useCallback(() => {
    if (!newThreadTargetProject) return;
    if (isMobile) {
      setOpenMobile(false);
    }
    void handleNewThread(
      scopeProjectRef(newThreadTargetProject.environmentId, newThreadTargetProject.id),
    );
  }, [handleNewThread, isMobile, newThreadTargetProject, setOpenMobile]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    return buildPhysicalToLogicalProjectKeyMap({
      projects: orderedProjects,
      settings: projectGroupingSettings,
    });
  }, [orderedProjects, projectGroupingSettings]);
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [orderedProjects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    return buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => {
        const rt = savedEnvironmentRuntimeById[environmentId];
        const saved = savedEnvironmentRegistry[environmentId];
        return rt?.descriptor?.label ?? saved?.label ?? null;
      },
    });
  }, [
    orderedProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);

  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Resolve the active route's project key to a logical key so it matches the
  // sidebar's grouped project entries.
  const activeRouteProjectKey = useMemo(() => {
    if (!activeRouteThreadKey) {
      return null;
    }
    const activeThread =
      sidebarThreadByKey.get(activeRouteThreadKey) ??
      (routeDraftThread
        ? ({
            environmentId: routeDraftThread.environmentId,
            projectId: routeDraftThread.projectId,
          } as Pick<SidebarThreadSummary, "environmentId" | "projectId">)
        : null);
    if (!activeThread) return null;
    const physicalKey =
      projectPhysicalKeyByScopedRef.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId));
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  }, [
    activeRouteThreadKey,
    routeDraftThread,
    sidebarThreadByKey,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
  ]);

  // Group threads by logical project key so all threads from grouped projects
  // are displayed together.
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of sidebarThreads) {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [sidebarThreads, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);
  const worktreesByProjectKey = useMemo(() => {
    const next = new Map<string, typeof sidebarWorktrees>();
    for (const worktree of sidebarWorktrees) {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(worktree.environmentId, worktree.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(worktree.environmentId, worktree.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(worktree);
      } else {
        next.set(logicalKey, [worktree]);
      }
    }
    return next;
  }, [sidebarWorktrees, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeThreadRef],
  );
  const newThreadShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: false,
      },
    }),
    [platform],
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", newThreadShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", newThreadShortcutLabelOptions);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(() => {
    const sortableProjects = sidebarProjects.map((project) => ({
      ...project,
      id: project.projectKey,
    }));
    const sortableThreads = visibleThreads.map((thread) => {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return {
        ...thread,
        projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
      };
    });
    return sortProjectsForSidebar(
      sortableProjects,
      sortableThreads,
      sidebarProjectSortOrder,
    ).flatMap((project) => {
      const resolvedProject = sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    });
  }, [
    sidebarProjectSortOrder,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectByKey,
    sidebarProjects,
    visibleThreads,
  ]);
  const projectTreeRows = useMemo(
    () =>
      buildSidebarProjectFolderTree({
        projects: sortedProjects,
        projectFoldersById,
        projectFolderOrder,
        projectTreeOrder,
        projectSortOrder: sidebarProjectSortOrder,
      }),
    [
      projectFolderOrder,
      projectFoldersById,
      projectTreeOrder,
      sidebarProjectSortOrder,
      sortedProjects,
    ],
  );
  const projectTreeRowByItemId = useMemo(
    () => new Map(projectTreeRows.map((row) => [row.itemId, row] as const)),
    [projectTreeRows],
  );
  const folderIdByProjectTreeItemId = useMemo(() => {
    const next = new Map<string, string | null>();
    for (const row of projectTreeRows) {
      if (row.kind === "project") {
        next.set(row.itemId, null);
        continue;
      }
      for (const project of row.projects) {
        next.set(projectTreeItemId(project.projectKey), row.folder.id);
      }
    }
    return next;
  }, [projectTreeRows]);
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      const activeParsed = parseProjectTreeItemId(activeId);

      if (activeParsed?.kind === "folder") {
        const overParsed = parseProjectTreeItemId(overId);
        if (isManualProjectSorting && overParsed) {
          reorderProjectTreeItem(activeId as UiProjectTreeItemId, overId as UiProjectTreeItemId);
        }
        return;
      }

      if (activeParsed?.kind !== "project") {
        return;
      }
      const activeProject = sidebarProjectByKey.get(activeParsed.projectKey);
      if (!activeProject) return;
      const activeMemberKeys = activeProject.memberProjects.map(
        (member) => member.physicalProjectKey,
      );

      if (overId === PROJECT_ROOT_DROP_ID) {
        moveProjectsToRoot(activeMemberKeys);
        return;
      }

      const overParsed = parseProjectTreeItemId(overId);
      if (!overParsed) {
        return;
      }

      if (overParsed.kind === "folder") {
        moveProjectsToFolder(activeMemberKeys, overParsed.folderId);
        return;
      }

      const overProject = sidebarProjectByKey.get(overParsed.projectKey);
      if (!overProject) return;
      const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);
      const activeFolderId = folderIdByProjectTreeItemId.get(activeId) ?? null;
      const overFolderId = folderIdByProjectTreeItemId.get(overId) ?? null;

      if (overFolderId) {
        const folderRow = projectTreeRowByItemId.get(projectFolderTreeItemId(overFolderId));
        const targetIndex =
          folderRow?.kind === "folder"
            ? folderRow.projects.findIndex(
                (project) => project.projectKey === overParsed.projectKey,
              )
            : undefined;
        if (activeFolderId !== overFolderId || isManualProjectSorting) {
          moveProjectsToFolder(
            activeMemberKeys,
            overFolderId,
            targetIndex !== undefined && targetIndex >= 0 ? targetIndex : undefined,
          );
        }
        return;
      }

      if (activeFolderId) {
        const targetIndex = projectTreeRows.findIndex((row) => row.itemId === overId);
        moveProjectsToRoot(activeMemberKeys, targetIndex >= 0 ? targetIndex : undefined);
        return;
      }

      if (isManualProjectSorting) {
        reorderProjectTreeItem(activeId as UiProjectTreeItemId, overId as UiProjectTreeItemId);
        reorderProjects(activeMemberKeys, overMemberKeys);
      }
    },
    [
      dragInProgressRef,
      folderIdByProjectTreeItemId,
      isManualProjectSorting,
      moveProjectsToFolder,
      moveProjectsToRoot,
      projectTreeRowByItemId,
      projectTreeRows,
      reorderProjectTreeItem,
      reorderProjects,
      sidebarProjectByKey,
    ],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [dragInProgressRef, suppressProjectClickAfterDragRef],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const visibleSidebarThreadKeys = useMemo(
    () =>
      projectTreeRows.flatMap((row) => {
        const projectsForRow =
          row.kind === "project" ? [row.project] : row.folder.expanded ? row.projects : [];
        return projectsForRow.flatMap((project) => {
          const projectThreads = sortThreadsWithPinned({
            threads: threadsByProjectKey.get(project.projectKey) ?? [],
            sortOrder: sidebarThreadSortOrder,
            pinnedThreadKeys,
            getThreadKey: (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          });
          const projectExpanded = projectExpandedById[project.projectKey] ?? true;
          const activeThreadKey = routeThreadKey ?? undefined;
          const pinnedCollapsedThreadKey =
            !projectExpanded && activeThreadKey
              ? projectThreads
                  .filter((thread) => thread.archivedAt === null)
                  .find(
                    (thread) =>
                      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                      activeThreadKey,
                  )
                ? activeThreadKey
                : null
              : null;
          if (!projectExpanded && !pinnedCollapsedThreadKey) {
            return [];
          }

          const treeInput = adaptProjectForSidebarTree({
            project,
            threads: projectThreads,
            worktrees: worktreesByProjectKey.get(project.projectKey) ?? [],
          });
          const treeProject = composeSidebarTree({
            nowMs: 0,
            projects: [treeInput.project],
            threads: treeInput.threads,
            worktrees: treeInput.worktrees,
          }).projects[0];
          if (!treeProject) {
            return [];
          }

          return treeProject.worktrees.flatMap((worktree) =>
            worktree.sessions
              .filter((thread) => thread.archivedAt === null)
              .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
              .filter((threadKey) => projectExpanded || threadKey === pinnedCollapsedThreadKey),
          );
        });
      }),
    [
      sidebarThreadSortOrder,
      pinnedThreadKeys,
      projectExpandedById,
      projectTreeRows,
      routeThreadKey,
      threadsByProjectKey,
      worktreesByProjectKey,
    ],
  );
  const prefersReducedMotion = useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);
  const shouldAnimateProjectLists = shouldEnableAutoAnimate({
    prefersReducedMotion,
    withinThreshold: shouldAutoAnimateSidebarProjectList(sortedProjects.length),
  });
  const shouldAnimateThreadLists = shouldEnableAutoAnimate({
    prefersReducedMotion,
    withinThreshold: shouldAutoAnimateSidebarThreadLists({
      projectCount: sortedProjects.length,
      visibleThreadCount: visibleSidebarThreadKeys.length,
    }),
  });
  const projectListAnimationControllersRef = useRef<SidebarAutoAnimateControllers>(new Map());
  const attachProjectListAutoAnimateRef = useCallback(
    (node: HTMLElement | null) => {
      attachSidebarAutoAnimateNode(
        projectListAnimationControllersRef.current,
        node,
        shouldAnimateProjectLists,
      );
    },
    [shouldAnimateProjectLists],
  );
  useEffect(() => {
    setSidebarAutoAnimateControllersEnabled(
      projectListAnimationControllersRef.current,
      shouldAnimateProjectLists,
    );
  }, [shouldAnimateProjectLists]);

  const threadListAnimationControllersRef = useRef<SidebarAutoAnimateControllers>(new Map());
  const attachThreadListAutoAnimateRef = useCallback(
    (node: HTMLElement | null) => {
      attachSidebarAutoAnimateNode(
        threadListAnimationControllersRef.current,
        node,
        shouldAnimateThreadLists,
      );
    },
    [shouldAnimateThreadLists],
  );
  useEffect(() => {
    setSidebarAutoAnimateControllersEnabled(
      threadListAnimationControllersRef.current,
      shouldAnimateThreadLists,
    );
  }, [shouldAnimateThreadLists]);
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const sidebarShortcutContext = useMemo(
    () => ({
      terminalFocus: false,
      terminalOpen: routeThreadRef
        ? selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadKey,
            routeThreadRef,
          ).terminalOpen
        : false,
      modelPickerOpen,
    }),
    [modelPickerOpen, routeThreadRef],
  );
  const threadJumpLabelByKey = useMemo(
    () =>
      buildThreadJumpLabelMap({
        keybindings,
        platform,
        terminalOpen: sidebarShortcutContext.terminalOpen,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, sidebarShortcutContext.terminalOpen, threadJumpCommandByKey],
  );
  const shouldShowThreadJumpHintsNow =
    !hasOpenDialogShortcutTarget() &&
    shouldShowThreadJumpHintsForModifiers(shortcutModifiers, keybindings, {
      platform,
      context: sidebarShortcutContext,
    });
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;
  const prewarmedSidebarThreadKeys = useMemo(
    () => getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys),
    [visibleSidebarThreadKeys],
  );
  const prewarmedSidebarThreadRefs = useMemo(
    () =>
      prewarmedSidebarThreadKeys.flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [prewarmedSidebarThreadKeys],
  );

  useSidebarThreadPrewarm(
    shouldPrewarmSidebarThreads({ isMobile, open, openMobile, sidebarMode }),
    prewarmedSidebarThreadRefs,
  );

  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowThreadJumpHintsNow);
  }, [shouldShowThreadJumpHintsNow, updateThreadJumpHintsVisibility]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcutContext = getCurrentSidebarShortcutContext();

      if (event.defaultPrevented || event.repeat) {
        return;
      }
      if (shouldIgnoreGlobalNavigationShortcut(event)) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      if (command === "sidebar.showInbox" || command === "sidebar.showProjects") {
        event.preventDefault();
        event.stopPropagation();
        handleSidebarModeChange(command === "sidebar.showInbox" ? "inbox" : "projects");
        return;
      }
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = sidebarThreadByKey.get(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    getCurrentSidebarShortcutContext,
    handleSidebarModeChange,
    keybindings,
    navigateToThread,
    orderedSidebarThreadKeys,
    platform,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadCount === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadCount]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Clicking a turn-complete desktop notification focuses the window (handled in
  // the main process) and navigates to the thread whose turn finished.
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
    if (!bridge?.onTurnCompleteNotificationActivated) {
      return;
    }
    return bridge.onTurnCompleteNotificationActivated((notification) => {
      if (!notification.environmentId) {
        return;
      }
      navigateToThread(scopeThreadRef(notification.environmentId, notification.threadId));
    });
  }, [navigateToThread]);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    newThreadShortcutLabelOptions,
  );
  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  }, []);

  return (
    <>
      <SidebarChromeHeader
        isElectron={isElectron}
        mode={sidebarMode}
        onModeChange={handleSidebarModeChange}
      />

      <SidebarNewThreadButton
        shortcutLabel={newThreadShortcutLabel}
        disabled={newThreadTargetProject === null}
        onClick={startNewThreadFromSidebar}
      />

      <div
        aria-hidden={sidebarMode !== "projects"}
        className={sidebarMode === "projects" ? "contents" : "hidden"}
        inert={sidebarMode !== "projects"}
      >
        <SidebarProjectDialogProvider
          projectGroupingSettings={projectGroupingSettings}
          updateSettings={updateSettings}
          navigateToThread={navigateToThread}
        >
          <SidebarProjectsContent
            showArm64IntelBuildWarning={showArm64IntelBuildWarning}
            arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
            desktopUpdateButtonAction={desktopUpdateButtonAction}
            desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
            handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
            projectSortOrder={sidebarProjectSortOrder}
            threadSortOrder={sidebarThreadSortOrder}
            projectGroupingMode={sidebarProjectGroupingMode}
            updateSettings={updateSettings}
            openAddProject={openAddProjectCommandPalette}
            isManualProjectSorting={isManualProjectSorting}
            projectDnDSensors={projectDnDSensors}
            projectCollisionDetection={projectCollisionDetection}
            handleProjectDragStart={handleProjectDragStart}
            handleProjectDragEnd={handleProjectDragEnd}
            handleProjectDragCancel={handleProjectDragCancel}
            projectTreeRows={projectTreeRows}
            commandPaletteShortcutLabel={commandPaletteShortcutLabel}
            attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
            projectsLength={projects.length}
            renderProjectRow={(project, dragHandleProps, onNewFolderWithProject) => (
              <SidebarProjectItem
                project={project}
                isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                activeRouteThreadKey={
                  activeRouteProjectKey === project.projectKey ? activeRouteThreadKey : null
                }
                handleNewThread={handleNewThread}
                archiveThread={archiveThread}
                deleteThread={deleteThread}
                threadJumpLabelByKey={visibleThreadJumpLabelByKey}
                attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                expandThreadListForProject={expandThreadListForProject}
                collapseThreadListForProject={collapseThreadListForProject}
                onNewFolderWithProject={onNewFolderWithProject}
                dragInProgressRef={dragInProgressRef}
                suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                isManualProjectSorting={isManualProjectSorting}
                dragHandleProps={dragHandleProps}
              />
            )}
          />
        </SidebarProjectDialogProvider>
      </div>
      <div
        aria-hidden={sidebarMode !== "inbox"}
        className={sidebarMode === "inbox" ? "contents" : "hidden"}
        inert={sidebarMode !== "inbox"}
      >
        <ConnectedInboxSidebar
          archiveThread={archiveThread}
          deleteThread={deleteThread}
          activeThreadKey={activeRouteThreadKey}
          aiFocusEnabled={aiFocusEnabled}
          autoSettleAfterDays={sidebarAutoSettleAfterDays}
          deliveryUnknownThreadKeys={deliveryUnknownThreadKeys}
          environments={inboxEnvironments}
          localQueuedThreadKeys={localQueuedThreadKeys}
          pinnedThreadKeys={pinnedThreadKeys}
          onOpenThread={navigateToThread}
          projects={projects}
          threads={sidebarThreads}
          worktrees={sidebarWorktrees}
        />
      </div>

      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}
