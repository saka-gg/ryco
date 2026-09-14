import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useNavigation } from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import { getQueuedThreadKeys } from "@ryco/client-runtime/state/message-queue";
import { useEffect, useLayoutEffect, useMemo, useReducer, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { HomeModeControl } from "../../components/HomeModeControl";
import { HomeBottomToolbar } from "../../components/HomeBottomToolbar";
import { RycoWordmark } from "../../components/RycoWordmark";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useMessageQueueStore } from "../../state/messageQueueStore";
import { resolveHomeGroupingMode } from "../../state/homeGrouping";
import { usePreferences } from "../../state/preferencesStore";
import { useStore } from "../../state/threadsRuntime";
import { buildInboxSections, resolveInboxEmptyState } from "../inbox/inboxModel";
import { InboxScreen } from "../inbox/InboxScreen";
import { buildProjectRows } from "../projects/projectsModel";
import { ProjectsScreen } from "../projects/ProjectsScreen";
import { buildHomeChromeModel } from "./homeChromeModel";
import { createHomeModeState, reduceHomeModeState, type HomeMode } from "./homeMode";
import { useHomeEnvironments } from "./useHomeEnvironments";
import { NeedsVerificationSection } from "./NeedsVerificationSection";

export function HomeScreen() {
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const [home, dispatch] = useReducer(reduceHomeModeState, undefined, () => createHomeModeState());
  const iconColor = useThemeColor("--color-icon");
  const environments = useHomeEnvironments();
  const eligibleEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { projects, worktrees, threads } = useHomeWorkspaceData(eligibleEnvironmentIds);
  const queuesByThreadKey = useMessageQueueStore((state) => state.queuesByThreadKey);
  const localQueuedThreadIds = useMemo(
    () => getQueuedThreadKeys(queuesByThreadKey),
    [queuesByThreadKey],
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNowMs(Date.now());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  const preferences = usePreferences();
  const groupingMode = resolveHomeGroupingMode(preferences.projectGroupingEnabled);

  const currentQuery = home.queryByMode[home.mode];
  const currentNodeScope = home.nodeScopeByMode[home.mode];
  const inboxSections = useMemo(
    () =>
      buildInboxSections({
        projects,
        worktrees,
        threads,
        environments,
        query: home.queryByMode.inbox,
        nodeScope: home.nodeScopeByMode.inbox,
        localQueuedThreadIds,
        aiFocusEnabled: preferences.aiFocusEnabled ?? false,
        autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
        nowMs,
      }),
    [
      environments,
      home.nodeScopeByMode.inbox,
      home.queryByMode.inbox,
      localQueuedThreadIds,
      nowMs,
      preferences.aiFocusEnabled,
      preferences.sidebarAutoSettleAfterDays,
      projects,
      threads,
      worktrees,
    ],
  );
  const projectRows = useMemo(
    () =>
      buildProjectRows({
        projects,
        worktrees,
        threads,
        environments,
        query: home.queryByMode.projects,
        nodeScope: home.nodeScopeByMode.projects,
        groupingMode,
      }),
    [
      environments,
      groupingMode,
      home.nodeScopeByMode.projects,
      home.queryByMode.projects,
      projects,
      threads,
      worktrees,
    ],
  );

  const chrome = useMemo(() => buildHomeChromeModel({ mode: home.mode }), [home.mode]);

  const openNewTask = () =>
    navigation.navigate("NewTask", {
      environmentId: currentNodeScope ?? undefined,
    });

  const openMachines = () => navigation.navigate("Connections");

  useLayoutEffect(() => {
    navigation.setOptions({
      title: chrome.title,
      headerLeft: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={chrome.headerLeft.accessibilityLabel}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle-strong"
          onPress={() => dispatch({ type: "select-mode", mode: chrome.headerLeftTargetMode })}
        >
          <RycoWordmark compact />
        </Pressable>
      ),
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={chrome.headerRight[0].accessibilityLabel}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle-strong"
          onPress={() => navigation.navigate("SettingsSheet")}
        >
          <SymbolView name="gearshape" size={20} tintColor={iconColor} type="monochrome" />
        </Pressable>
      ),
    });
  }, [chrome, iconColor, navigation]);

  const selectMode = (mode: HomeMode) => {
    dispatch({ type: "select-mode", mode });
  };

  const openThread = (thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => {
    useStore.getState().setActiveEnvironmentId(thread.environmentId);
    navigation.navigate("Thread", {
      environmentId: thread.environmentId,
      threadId: thread.threadId,
    });
  };

  const clearFilters = () => {
    dispatch({ type: "set-query", mode: home.mode, query: "" });
    dispatch({ type: "set-node-scope", mode: home.mode, environmentId: null });
  };

  const inboxEmptyState = resolveInboxEmptyState({
    environmentCount: environments.length,
    projectCount: projects.length,
    threadCount: threads.filter((thread) => thread.archivedAt === null).length,
    hasFilter: home.queryByMode.inbox.length > 0 || home.nodeScopeByMode.inbox !== null,
  });

  return (
    <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
      <View className="flex-1 bg-screen" style={{ paddingTop: headerHeight }}>
        <HomeModeControl mode={home.mode} onSelect={selectMode} />
        <View className="min-h-0 flex-1">
          <NeedsVerificationSection />
          {home.mode === "inbox" ? (
            <InboxScreen
              filterKey={JSON.stringify([currentQuery, currentNodeScope])}
              sections={inboxSections}
              emptyState={inboxEmptyState}
              initialScrollOffset={home.scrollOffsetByMode.inbox}
              onScrollOffset={(offset) =>
                dispatch({ type: "set-scroll-offset", mode: "inbox", offset })
              }
              onOpenThread={(row) => openThread(row)}
              onEmptyAction={(state) => {
                if (state === "connect-node") {
                  openMachines();
                } else if (state === "clear-filter") {
                  clearFilters();
                } else {
                  selectMode("projects");
                }
              }}
            />
          ) : (
            <ProjectsScreen
              filterKey={JSON.stringify([currentQuery, currentNodeScope])}
              rows={projectRows}
              hasMachines={environments.length > 0}
              initialScrollOffset={home.scrollOffsetByMode.projects}
              onScrollOffset={(offset) =>
                dispatch({ type: "set-scroll-offset", mode: "projects", offset })
              }
              onAddProject={() => navigation.navigate("AddProject")}
              onOpenProject={(row) =>
                navigation.navigate("Project", {
                  environmentId: row.open.environmentId,
                  projectId: row.open.projectId,
                })
              }
              onAddMachine={openMachines}
            />
          )}
        </View>
        <HomeBottomToolbar
          query={currentQuery}
          searchLabel={chrome.search.accessibilityLabel}
          onQueryChange={(query) => dispatch({ type: "set-query", mode: home.mode, query })}
          machines={environments}
          selectedMachine={currentNodeScope}
          onSelectMachine={(environmentId) =>
            dispatch({ type: "set-node-scope", mode: home.mode, environmentId })
          }
          onNewTask={openNewTask}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
