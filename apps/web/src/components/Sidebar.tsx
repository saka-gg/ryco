import { useAppKeybindings } from "../appKeybindings";
import { useDeviceName } from "../deviceName";
import { useServerConfigSelector } from "~/rpc/serverState";
import { autoAnimate, type AnimationController } from "@formkit/auto-animate";
import React, {
  Activity,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  type EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
  type ServerConfig,
} from "@ryco/contracts";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@ryco/client-runtime/scoped";
import {
  getReportedThreadCapabilitiesSnapshot,
  getShellSettlementRulesSnapshot,
  getWsConnectionUiState,
  subscribeReportedThreadCapabilities,
} from "@ryco/client-runtime/rpc";
import { getQueuedThreadKeys } from "@ryco/client-runtime/state/message-queue";
import {
  selectCacheHydratedEnvironmentIds,
  selectThreadLiveDetailLoaded,
} from "@ryco/client-runtime/state/threads";
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
import { getModelPickerOpen, useModelPickerOpen } from "../modelPickerOpenState";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useMediaQuery } from "../hooks/useMediaQuery";

import { useThreadActions } from "../hooks/useThreadActions";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { usePerfMark } from "../perf/tabSwitchInstrumentation";
import { SidebarSeparator, useSidebar } from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  shouldAutoAnimateSidebarProjectList,
  shouldAutoAnimateSidebarThreadLists,
  shouldClearThreadSelectionOnMouseDown,
  shouldPrewarmSidebarThreads,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { SidebarProjectsContent, PROJECT_ROOT_DROP_ID } from "./sidebar/SidebarProjectList";
import { SidebarProjectItem } from "./sidebar/SidebarProjectItem";
import { SidebarChatList } from "./sidebar/SidebarChatList";
import {
  buildSidebarChatRows,
  chatsTurnedIntoProjects,
  collectChatProjectKeys,
} from "./sidebar/sidebarChats.logic";
import { sidebarProjectRowSelector } from "./chat/promoteChatDialogStore";
import { useChatsAvailability } from "../hooks/useChatsAvailability";
import { SidebarProjectDialogProvider } from "./sidebar/SidebarProjectDialogOwner";
import { SidebarChromeHeader, SidebarChromeFooter } from "./sidebar/SidebarChrome";
import { SidebarPrimaryActions } from "./sidebar/SidebarPrimaryActions";
import { resolveNewThreadProjectKey } from "./sidebar/sidebarNewThreadTarget";
import { ConnectedInboxSidebar } from "./inboxSidebar/ConnectedInboxSidebar";
import {
  buildInboxSidebarEnvironments,
  sameInboxProviderCatalogs,
  type InboxSidebarEnvironment,
} from "./inboxSidebar/inboxSidebarModel";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useLogicalProjectSnapshots } from "~/hooks/useLogicalProjectSnapshots";
import { useProjectGroupingSettings } from "~/hooks/useProjectGroupingSettings";
import { derivePhysicalProjectKey } from "../logicalProject";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { isUnarchivedThreadEntry, type SidebarThreadSummary } from "../types";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { buildSidebarProjectFolderTree } from "../sidebarProjectFolders";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import { useHostedWorkspaceState } from "../hostedHub/hostedConnectionCoordinator";
import { useAutoSettleRuleHandOver } from "../nodeAutoSettlement";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { useMessageQueueStore } from "../messageQueueStore";
import { useSidebarThreadPrewarm } from "./sidebar/hooks/useSidebarThreadPrewarm";
import { useSidebarListMotionReady } from "./sidebar/hooks/useSidebarListMotionReady";
import {
  collectSidebarVisibleThreadKeys,
  createSidebarProjectThreadKeysCache,
  groupByLogicalProjectKey,
  sortSidebarProjects,
} from "./sidebar/sidebarVisibleThreadKeys";
import {
  createSidebarProjectTreeCache,
  SidebarProjectTreeCacheContext,
} from "./sidebar/sidebarProjectTreeCache";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { SortableProjectHandleProps } from "./sidebar/SidebarProjectList";

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

/**
 * Shows rows that moved into an auto-animated list from elsewhere in the
 * sidebar at once. auto-animate keeps an added row fully transparent for the
 * first half of its entrance; for a row whose old copy left another list in
 * the same update (a chat turned into a project leaves the Chats section) that
 * reads as an empty list. Call it from a layout effect of the commit that
 * added the rows: that commit's DOM changes queued auto-animate's mutation
 * observer first, so this microtask runs after the entrances started and
 * before the next paint. Rows that move by FLIP stay animated.
 */
function revealMovedSidebarRows(
  controllers: SidebarAutoAnimateControllers,
  rowSelector: string,
): void {
  queueMicrotask(() => {
    for (const list of controllers.keys()) {
      if (!list.isConnected) continue;
      for (const row of Array.from(list.children)) {
        if (!row.matches(rowSelector) && row.querySelector(rowSelector) === null) continue;
        for (const animation of row.getAnimations()) animation.finish();
      }
    }
  });
}

const selectSidebarThreadSortOrder = (settings: UnifiedSettings) => settings.sidebarThreadSortOrder;
const selectSidebarProjectSortOrder = (settings: UnifiedSettings) =>
  settings.sidebarProjectSortOrder;
const selectAiFocusEnabled = (settings: UnifiedSettings) => settings.aiFocusEnabled;
const selectSidebarAutoSettleAfterDays = (settings: UnifiedSettings) =>
  settings.sidebarAutoSettleAfterDays;
const selectServerProviders = (config: ServerConfig | null) => config?.providers ?? null;

// Non-reactive store reads for event handlers and memoized shortcut contexts.
// Kept outside the component: the React Compiler bails out on hooks
// (`use*` stores) referenced as values inside a component.
function readRouteTerminalOpen(routeThreadRef: ScopedThreadRef | null): boolean {
  return routeThreadRef
    ? selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        routeThreadRef,
      ).terminalOpen
    : false;
}

function hasSelectedThreads(): boolean {
  return useThreadSelectionStore.getState().selectedThreadKeys.size > 0;
}

/**
 * While `visible`, renders `children` as given. While hidden, keeps rendering
 * the element captured when it was hidden, so React bails out of the hidden
 * subtree on every parent render instead of reconciling it with new props.
 */
function FrozenWhileHidden(props: { readonly visible: boolean; readonly children: ReactNode }) {
  const { visible, children } = props;
  const [frozen, setFrozen] = useState<{ readonly children: ReactNode } | null>(null);
  if (visible) {
    if (frozen !== null) setFrozen(null);
    return children;
  }
  if (frozen === null) {
    setFrozen({ children });
    return children;
  }
  return frozen.children;
}

/**
 * Owns the reactive inputs of thread-jump hint visibility (held modifier keys,
 * the model picker, open dialogs) so their changes re-render this leaf instead
 * of the whole Sidebar; only an actual visibility flip reaches the Sidebar.
 */
function SidebarThreadJumpHintController(props: {
  readonly keybindings: ReturnType<typeof useAppKeybindings>;
  readonly platform: string;
  readonly terminalOpen: boolean;
  readonly onVisibilityChange: (shouldShow: boolean) => void;
}) {
  const shortcutModifiers = useShortcutModifierState();
  const modelPickerOpen = useModelPickerOpen();
  const { keybindings, onVisibilityChange, platform, terminalOpen } = props;
  const shouldShowThreadJumpHintsNow =
    !hasOpenDialogShortcutTarget() &&
    shouldShowThreadJumpHintsForModifiers(shortcutModifiers, keybindings, {
      platform,
      context: { terminalFocus: false, terminalOpen, modelPickerOpen },
    });
  useEffect(() => {
    onVisibilityChange(shouldShowThreadJumpHintsNow);
  }, [onVisibilityChange, shouldShowThreadJumpHintsNow]);
  return null;
}

const EMPTY_SIDEBAR_CHAT_ROWS: ReturnType<typeof buildSidebarChatRows> = [];
const EMPTY_SIDEBAR_PROJECTS: ReturnType<typeof sortSidebarProjects> = [];
const EMPTY_THREAD_KEYS: string[] = [];

type ThreadJumpCommand = NonNullable<ReturnType<typeof threadJumpCommandForIndex>>;

/** The first visible threads that have a jump command, in traversal order. */
function buildThreadJumpCommandMap(
  visibleThreadKeys: readonly string[],
): Map<string, ThreadJumpCommand> {
  const mapping = new Map<string, ThreadJumpCommand>();
  for (const [visibleThreadIndex, threadKey] of visibleThreadKeys.entries()) {
    const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
    if (!jumpCommand) {
      return mapping;
    }
    mapping.set(threadKey, jumpCommand);
  }
  return mapping;
}

/**
 * The traversal and jump order the projects pane would derive, built in one
 * pass for the keyboard shortcuts while that pane has never been shown.
 */
function deriveShortcutThreadOrder(input: {
  readonly projectOrderInput: Parameters<typeof sortSidebarProjects>[0];
  readonly visibleThreadKeysInput: Omit<
    Parameters<typeof collectSidebarVisibleThreadKeys>[0],
    "projectTreeRows"
  >;
  readonly projectFoldersById: Parameters<
    typeof buildSidebarProjectFolderTree
  >[0]["projectFoldersById"];
  readonly projectFolderOrder: Parameters<
    typeof buildSidebarProjectFolderTree
  >[0]["projectFolderOrder"];
  readonly projectTreeOrder: Parameters<
    typeof buildSidebarProjectFolderTree
  >[0]["projectTreeOrder"];
}): { readonly orderedThreadKeys: readonly string[]; readonly jumpThreadKeys: readonly string[] } {
  const projectTreeRows = buildSidebarProjectFolderTree({
    projects: sortSidebarProjects(input.projectOrderInput),
    projectFoldersById: input.projectFoldersById,
    projectFolderOrder: input.projectFolderOrder,
    projectTreeOrder: input.projectTreeOrder,
    projectSortOrder: input.projectOrderInput.sortOrder,
  });
  const orderedThreadKeys = collectSidebarVisibleThreadKeys({
    ...input.visibleThreadKeysInput,
    projectTreeRows,
  });
  return {
    orderedThreadKeys,
    jumpThreadKeys: [...buildThreadJumpCommandMap(orderedThreadKeys).keys()],
  };
}

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useAppKeybindings>;
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
  // Archived threads may be stubs; everything listed as active reads full rows.
  const unarchivedSidebarThreads = useMemo(
    () => sidebarThreads.filter(isUnarchivedThreadEntry),
    [sidebarThreads],
  );
  const sidebarWorktrees = useStore(useShallow(selectSidebarWorktreesAcrossEnvironments));
  // Only cache provenance is needed here. Subscribing to the whole
  // `environmentStateById` re-rendered the Sidebar on every store commit,
  // including every streaming thread-detail event.
  const cacheHydratedEnvironmentIdList = useStore(useShallow(selectCacheHydratedEnvironmentIds));
  const cacheHydratedEnvironmentIds = useMemo(
    () => new Set<string>(cacheHydratedEnvironmentIdList),
    [cacheHydratedEnvironmentIdList],
  );
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);
  // Only the active pane renders. A pane is mounted the first time it is
  // shown and then kept in a hidden <Activity>, which preserves its local
  // state (expanded sections, scroll) while unmounting its effects (row
  // observers, git-status and change-request subscriptions) and skipping its
  // renders: its props are frozen at the last visible values.
  const [mountedSidebarModes, setMountedSidebarModes] = useState<ReadonlySet<SidebarMode>>(
    () => new Set([sidebarMode]),
  );
  if (!mountedSidebarModes.has(sidebarMode)) {
    setMountedSidebarModes(new Set([...mountedSidebarModes, sidebarMode]));
  }
  const projectsPaneVisible = sidebarMode === "projects";
  const inboxPaneVisible = sidebarMode === "inbox";
  // The project tree's derivations (chat rows, project order, tree rows,
  // traversal order) feed the projects pane. Until it is first shown (the
  // inbox is the default), they are not built; thread traversal and jump
  // shortcuts derive the same order on demand instead.
  const projectTreeDerived = mountedSidebarModes.has("projects");
  const setSidebarMode = useUiStateStore((store) => store.setSidebarMode);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectFoldersById = useUiStateStore((store) => store.projectFoldersById);
  const projectFolderOrder = useUiStateStore((store) => store.projectFolderOrder);
  const projectTreeOrder = useUiStateStore((store) => store.projectTreeOrder);
  const pinnedThreadKeysRecord = useUiStateStore((store) => store.pinnedThreadKeys);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const moveProjectsToFolder = useUiStateStore((store) => store.moveProjectsToFolder);
  const moveProjectsToRoot = useUiStateStore((store) => store.moveProjectsToRoot);
  const reorderProjectTreeItem = useUiStateStore((store) => store.reorderProjectTreeItem);
  const navigate = useNavigate();
  const sidebarThreadSortOrder = useSettings(selectSidebarThreadSortOrder);
  const sidebarProjectSortOrder = useSettings(selectSidebarProjectSortOrder);
  const aiFocusEnabled = useSettings(selectAiFocusEnabled);
  const sidebarAutoSettleAfterDays = useSettings(selectSidebarAutoSettleAfterDays);
  // Stable while the grouping settings are: it feeds the whole project-tree
  // derivation chain.
  const projectGroupingSettings = useProjectGroupingSettings();
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread, handleNewChat } = useNewThreadHandler();
  const { archiveThread, deleteThread, stopThreadSession, interruptThreadTurn } =
    useThreadActions();
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
  const keybindings = useAppKeybindings();
  const openAddProjectCommandPalette = useCommandPaletteStore((store) => store.openAddProject);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const selectedThreadCount = useThreadSelectionStore((s) => s.selectedThreadKeys.size);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironmentDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryWsConnectionStatus = useWsConnectionStatus();
  const primaryConnectionState = getWsConnectionUiState(primaryWsConnectionStatus);
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const primaryDeviceName = useDeviceName();
  const desktopWorkspace = useDesktopWorkspaceState();
  const hostedWorkspace = useHostedWorkspaceState();
  // The workspace republishes about every 100 ms while threads stream. The inbox
  // reads only these parts, whose identities survive such a republish.
  const hostedStatus = hostedWorkspace.status;
  const hostedMachines = hostedWorkspace.machines;
  const hostedQueuedEnvironmentIds = hostedWorkspace.demand.queuedEnvironmentIds;
  const hostedThreads = hostedWorkspace.workspace.threads;
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
  // Only the provider catalogs, for model labels: settings-only and
  // provider-status config pushes do not rebuild the inbox environments (and
  // with them the inbox model).
  const inboxServerProviders = useServerConfigSelector(
    selectServerProviders,
    sameInboxProviderCatalogs,
  );
  const inboxServerConfig = useMemo(
    () => (inboxServerProviders ? { providers: inboxServerProviders } : null),
    [inboxServerProviders],
  );
  // Changes only when a node's thread capabilities or auto-settle rule do, not on config pushes.
  const reportedThreadCapabilities = useSyncExternalStore(
    subscribeReportedThreadCapabilities,
    getReportedThreadCapabilitiesSnapshot,
    getReportedThreadCapabilitiesSnapshot,
  );
  const shellSettlementRules = useSyncExternalStore(
    subscribeReportedThreadCapabilities,
    getShellSettlementRulesSnapshot,
    getShellSettlementRulesSnapshot,
  );
  const inboxEnvironments = useMemo<ReadonlyArray<InboxSidebarEnvironment>>(() => {
    const knownEnvironmentIds = new Set<EnvironmentId>();
    for (const project of projects) knownEnvironmentIds.add(project.environmentId);
    for (const thread of sidebarThreads) knownEnvironmentIds.add(thread.environmentId);
    for (const environmentId of Object.keys(savedEnvironmentRegistry) as EnvironmentId[]) {
      knownEnvironmentIds.add(environmentId);
    }
    return buildInboxSidebarEnvironments({
      knownEnvironmentIds,
      primary: {
        environmentId: primaryEnvironmentId,
        label: primaryDeviceName,
        connectionState: primaryConnectionState,
        descriptor: primaryEnvironmentDescriptor,
        serverConfig: inboxServerConfig,
      },
      hosted:
        hostedStatus !== "signed-out"
          ? { machines: hostedMachines, queuedEnvironmentIds: hostedQueuedEnvironmentIds }
          : null,
      desktopWorkspace:
        desktopWorkspace.status !== "signed-out"
          ? {
              machines: desktopWorkspace.machines,
              queuedEnvironmentIds: desktopWorkspace.queuedEnvironmentIds,
              localEnvironmentId: desktopWorkspace.localEnvironmentId,
            }
          : null,
      savedEnvironmentRegistry,
      savedEnvironmentRuntimeById,
      cacheHydratedEnvironmentIds,
      reportedThreadCapabilities,
      shellSettlementRules,
    });
  }, [
    inboxServerConfig,
    cacheHydratedEnvironmentIds,
    desktopWorkspace,
    hostedMachines,
    hostedQueuedEnvironmentIds,
    hostedStatus,
    primaryConnectionState,
    primaryEnvironmentDescriptor,
    primaryDeviceName,
    primaryEnvironmentId,
    projects,
    reportedThreadCapabilities,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    shellSettlementRules,
    sidebarThreads,
  ]);
  // A node that keeps the auto-settle rule but has none yet takes this client's
  // own once (owner only).
  useAutoSettleRuleHandOver(inboxEnvironments, sidebarAutoSettleAfterDays);
  // A republish rebuilds the thread lists but almost never changes which
  // threads are unknown: the set follows its content, not the lists' identity.
  const deliveryUnknownKeysJson = useMemo(() => {
    const keys = new Set<string>();
    for (const thread of hostedThreads) {
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
    return JSON.stringify([...keys].toSorted());
  }, [desktopWorkspace.snapshots, hostedThreads]);
  const deliveryUnknownThreadKeys = useMemo(
    () => new Set<string>(JSON.parse(deliveryUnknownKeysJson) as string[]),
    [deliveryUnknownKeysJson],
  );
  const { orderedProjects, snapshots: sidebarProjects } = useLogicalProjectSnapshots();

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

  // "No project" chats: excluded from the project tree (useLogicalProjectSnapshots)
  // and listed in their own section.
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const sidebarChatRows = useMemo(
    () =>
      projectTreeDerived
        ? buildSidebarChatRows({
            projects,
            threads: unarchivedSidebarThreads,
            draftThreadsByThreadKey,
            sortOrder: sidebarThreadSortOrder,
            pinnedThreadKeys,
          })
        : EMPTY_SIDEBAR_CHAT_ROWS,
    [
      draftThreadsByThreadKey,
      pinnedThreadKeys,
      projectTreeDerived,
      projects,
      sidebarThreadSortOrder,
      unarchivedSidebarThreads,
    ],
  );
  const chatEnvironmentId =
    selectedHostedEnvironmentId ?? newThreadTargetProject?.environmentId ?? primaryEnvironmentId;
  const chatsAvailability = useChatsAvailability(chatEnvironmentId);
  const startNewChatFromSidebar = useMemo(
    () =>
      chatEnvironmentId && chatsAvailability.available
        ? () => {
            if (isMobile) setOpenMobile(false);
            void handleNewChat(chatEnvironmentId);
          }
        : null,
    [chatEnvironmentId, chatsAvailability.available, handleNewChat, isMobile, setOpenMobile],
  );

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
  // are displayed together. Groups a commit did not touch keep their previous
  // array, so per-project derivations below hit their cache.
  const [projectThreadKeysCache] = useState(createSidebarProjectThreadKeysCache);
  // Shared with every SidebarProjectItem, which renders the same project trees.
  const [projectTreeCache] = useState(createSidebarProjectTreeCache);
  const logicalProjectKeyOf = useCallback(
    (item: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }) => {
      const scopedKey = scopedProjectKey(scopeProjectRef(item.environmentId, item.projectId));
      const physicalKey = projectPhysicalKeyByScopedRef.get(scopedKey) ?? scopedKey;
      return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
    },
    [physicalToLogicalKey, projectPhysicalKeyByScopedRef],
  );
  const threadsByProjectKey = useMemo(
    () =>
      projectThreadKeysCache.shareGroups(
        "threads",
        groupByLogicalProjectKey(sidebarThreads, logicalProjectKeyOf),
      ),
    [logicalProjectKeyOf, projectThreadKeysCache, sidebarThreads],
  );
  const worktreesByProjectKey = useMemo(
    () =>
      projectThreadKeysCache.shareGroups(
        "worktrees",
        groupByLogicalProjectKey(sidebarWorktrees, logicalProjectKeyOf),
      ),
    [logicalProjectKeyOf, projectThreadKeysCache, sidebarWorktrees],
  );
  // Read lazily at keydown: subscribing to the model picker's open flag
  // re-rendered the whole Sidebar on every picker open and close.
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: readRouteTerminalOpen(routeThreadRef),
      modelPickerOpen: getModelPickerOpen(),
    }),
    [routeThreadRef],
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
      if (hasSelectedThreads()) {
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

  const visibleThreads = unarchivedSidebarThreads;
  const projectOrderInput = useMemo(
    () => ({
      sidebarProjects,
      visibleThreads,
      projectPhysicalKeyByScopedRef,
      physicalToLogicalKey,
      sidebarProjectByKey,
      sortOrder: sidebarProjectSortOrder,
    }),
    [
      physicalToLogicalKey,
      projectPhysicalKeyByScopedRef,
      sidebarProjectByKey,
      sidebarProjectSortOrder,
      sidebarProjects,
      visibleThreads,
    ],
  );
  const sortedProjects = useMemo(
    () => (projectTreeDerived ? sortSidebarProjects(projectOrderInput) : EMPTY_SIDEBAR_PROJECTS),
    [projectOrderInput, projectTreeDerived],
  );
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

  // Keyboard traversal and jump-hint order. Memoized per project: a commit
  // that changes one project's threads re-derives only that project's tree.
  const visibleThreadKeysInput = useMemo(
    () => ({
      projectExpandedById,
      routeThreadKey,
      projectThreadKeysCache,
      projectTreeCache,
      threadsByProjectKey,
      worktreesByProjectKey,
      draftThreadsByThreadKey,
      sortOrder: sidebarThreadSortOrder,
      pinnedThreadKeys,
    }),
    [
      draftThreadsByThreadKey,
      pinnedThreadKeys,
      projectExpandedById,
      projectThreadKeysCache,
      projectTreeCache,
      routeThreadKey,
      sidebarThreadSortOrder,
      threadsByProjectKey,
      worktreesByProjectKey,
    ],
  );
  const visibleSidebarThreadKeys = useMemo(
    () =>
      projectTreeDerived
        ? collectSidebarVisibleThreadKeys({ ...visibleThreadKeysInput, projectTreeRows })
        : EMPTY_THREAD_KEYS,
    [projectTreeDerived, projectTreeRows, visibleThreadKeysInput],
  );
  const prefersReducedMotion = useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);
  // No list motion (project tree or inbox) while the lists populate at boot
  // (see useSidebarListMotionReady).
  const listMotionReady = useSidebarListMotionReady();
  const shouldAnimateProjectLists =
    listMotionReady &&
    shouldEnableAutoAnimate({
      prefersReducedMotion,
      withinThreshold: shouldAutoAnimateSidebarProjectList(sortedProjects.length),
    });
  const shouldAnimateThreadLists =
    listMotionReady &&
    shouldEnableAutoAnimate({
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
  // A chat turned into a project moves from the Chats section into the project
  // tree in one update: its project row appears in place instead of fading in
  // from nothing after its chat row is already gone.
  const previousChatProjectKeysRef = useRef<ReadonlySet<string> | null>(null);
  useLayoutEffect(() => {
    const previousChatProjectKeys = previousChatProjectKeysRef.current;
    previousChatProjectKeysRef.current = collectChatProjectKeys(projects);
    if (previousChatProjectKeys === null) return;
    const promoted = chatsTurnedIntoProjects(previousChatProjectKeys, projects);
    if (promoted.length === 0) return;
    revealMovedSidebarRows(
      projectListAnimationControllersRef.current,
      promoted.map(sidebarProjectRowSelector).join(", "),
    );
  }, [projects]);

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
  const threadJumpCommandByKey = useMemo(
    () => buildThreadJumpCommandMap(visibleSidebarThreadKeys),
    [visibleSidebarThreadKeys],
  );
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const routeTerminalOpen = useMemo(() => readRouteTerminalOpen(routeThreadRef), [routeThreadRef]);
  const threadJumpLabelByKey = useMemo(
    () =>
      buildThreadJumpLabelMap({
        keybindings,
        platform,
        terminalOpen: routeTerminalOpen,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, routeTerminalOpen, threadJumpCommandByKey],
  );
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  // The traversal and jump order for the keyboard shortcuts. Before the
  // projects pane was first shown nothing above derived it: build it on the
  // first shortcut and reuse it until an input changes.
  const readShortcutThreadOrder = useMemo(() => {
    if (projectTreeDerived) {
      const order = {
        orderedThreadKeys: visibleSidebarThreadKeys,
        jumpThreadKeys: threadJumpThreadKeys,
      };
      return () => order;
    }
    let order: {
      readonly orderedThreadKeys: readonly string[];
      readonly jumpThreadKeys: readonly string[];
    } | null = null;
    return () => {
      if (order === null) {
        order = deriveShortcutThreadOrder({
          projectOrderInput,
          visibleThreadKeysInput,
          projectFoldersById,
          projectFolderOrder,
          projectTreeOrder,
        });
      }
      return order;
    };
  }, [
    projectFolderOrder,
    projectFoldersById,
    projectOrderInput,
    projectTreeDerived,
    projectTreeOrder,
    threadJumpThreadKeys,
    visibleSidebarThreadKeys,
    visibleThreadKeysInput,
  ]);
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

  // Prewarmed windows wait (a bounded time) for the routed thread's own live
  // window, so they never compete with it; a draft or a route without a thread
  // has none.
  const routeThreadLiveDetailLoaded = useStore((store) =>
    routeThreadRef ? selectThreadLiveDetailLoaded(store, routeThreadRef) : true,
  );
  useSidebarThreadPrewarm(
    shouldPrewarmSidebarThreads({ isMobile, open, openMobile, sidebarMode }),
    prewarmedSidebarThreadRefs,
    routeThreadLiveDetailLoaded,
    routeThreadKey,
  );

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
          threadIds: readShortcutThreadOrder().orderedThreadKeys,
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

      const targetThreadKey = readShortcutThreadOrder().jumpThreadKeys[jumpIndex];
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
    platform,
    readShortcutThreadOrder,
    routeThreadKey,
    sidebarThreadByKey,
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

  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    newThreadShortcutLabelOptions,
  );

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

  // Stable so SidebarProjectsContent (memo) and its sortable rows skip
  // re-rendering on commits that do not change their inputs.
  const renderProjectRow = useCallback(
    (
      project: SidebarProjectSnapshot,
      dragHandleProps: SortableProjectHandleProps | null,
      onNewFolderWithProject: (project: SidebarProjectSnapshot) => void,
    ) => (
      <SidebarProjectItem
        project={project}
        isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
        activeRouteThreadKey={
          activeRouteProjectKey === project.projectKey ? activeRouteThreadKey : null
        }
        handleNewThread={handleNewThread}
        archiveThread={archiveThread}
        deleteThread={deleteThread}
        stopThreadSession={stopThreadSession}
        interruptThreadTurn={interruptThreadTurn}
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
    ),
    [
      activeRouteProjectKey,
      activeRouteThreadKey,
      archiveThread,
      attachThreadListAutoAnimateRef,
      collapseThreadListForProject,
      expandThreadListForProject,
      expandedThreadListsByProject,
      handleNewThread,
      interruptThreadTurn,
      isManualProjectSorting,
      stopThreadSession,
      deleteThread,
      visibleThreadJumpLabelByKey,
    ],
  );

  return (
    <>
      <SidebarChromeHeader
        isElectron={isElectron}
        mode={sidebarMode}
        onModeChange={handleSidebarModeChange}
      />

      <SidebarPrimaryActions
        mode={sidebarMode}
        environments={inboxEnvironments}
        primaryEnvironmentId={primaryEnvironmentId}
        newThreadShortcutLabel={newThreadShortcutLabel}
        // Without any project the button starts a "No project" chat where chats are available.
        newThreadDisabled={newThreadTargetProject === null && startNewChatFromSidebar === null}
        onNewThread={
          newThreadTargetProject === null && startNewChatFromSidebar
            ? startNewChatFromSidebar
            : startNewThreadFromSidebar
        }
        searchShortcutLabel={commandPaletteShortcutLabel}
      />

      <SidebarProjectTreeCacheContext.Provider value={projectTreeCache}>
        <SidebarProjectDialogProvider
          projectGroupingSettings={projectGroupingSettings}
          updateSettings={updateSettings}
          navigateToThread={navigateToThread}
        >
          {mountedSidebarModes.has("projects") ? (
            <Activity mode={projectsPaneVisible ? "visible" : "hidden"} name="sidebar-projects">
              <FrozenWhileHidden visible={projectsPaneVisible}>
                <SidebarProjectsContent
                  projectSortOrder={sidebarProjectSortOrder}
                  threadSortOrder={sidebarThreadSortOrder}
                  projectGroupingMode={projectGroupingSettings.sidebarProjectGroupingMode}
                  updateSettings={updateSettings}
                  openAddProject={openAddProjectCommandPalette}
                  isManualProjectSorting={isManualProjectSorting}
                  projectDnDSensors={projectDnDSensors}
                  projectCollisionDetection={projectCollisionDetection}
                  handleProjectDragStart={handleProjectDragStart}
                  handleProjectDragEnd={handleProjectDragEnd}
                  handleProjectDragCancel={handleProjectDragCancel}
                  projectTreeRows={projectTreeRows}
                  attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
                  projectsLength={orderedProjects.length}
                  chatsSection={
                    <SidebarChatList
                      chats={sidebarChatRows}
                      activeRouteThreadKey={activeRouteThreadKey}
                      handleNewThread={handleNewThread}
                      archiveThread={archiveThread}
                      deleteThread={deleteThread}
                      stopThreadSession={stopThreadSession}
                      interruptThreadTurn={interruptThreadTurn}
                      attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                      onNewChat={startNewChatFromSidebar}
                    />
                  }
                  renderProjectRow={renderProjectRow}
                />
              </FrozenWhileHidden>
            </Activity>
          ) : null}
          {mountedSidebarModes.has("inbox") ? (
            <Activity mode={inboxPaneVisible ? "visible" : "hidden"} name="sidebar-inbox">
              <FrozenWhileHidden visible={inboxPaneVisible}>
                <ConnectedInboxSidebar
                  archiveThread={archiveThread}
                  deleteThread={deleteThread}
                  stopThreadSession={stopThreadSession}
                  interruptThreadTurn={interruptThreadTurn}
                  activeThreadKey={activeRouteThreadKey}
                  aiFocusEnabled={aiFocusEnabled}
                  autoSettleAfterDays={sidebarAutoSettleAfterDays}
                  deliveryUnknownThreadKeys={deliveryUnknownThreadKeys}
                  environments={inboxEnvironments}
                  localQueuedThreadKeys={localQueuedThreadKeys}
                  motionReady={listMotionReady}
                  pinnedThreadKeys={pinnedThreadKeys}
                  primaryEnvironmentId={primaryEnvironmentId}
                  onOpenThread={navigateToThread}
                  projects={projects}
                  threads={sidebarThreads}
                  worktrees={sidebarWorktrees}
                />
              </FrozenWhileHidden>
            </Activity>
          ) : null}
        </SidebarProjectDialogProvider>
      </SidebarProjectTreeCacheContext.Provider>
      {/* Jump hint labels render only in the project tree. */}
      {projectsPaneVisible ? (
        <SidebarThreadJumpHintController
          keybindings={keybindings}
          platform={platform}
          terminalOpen={routeTerminalOpen}
          onVisibilityChange={updateThreadJumpHintsVisibility}
        />
      ) : null}
      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}
