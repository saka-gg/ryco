import { MenuView } from "@react-native-menu/menu";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppState, View } from "react-native";

import { scopedProjectKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { pinnedThreadKeyList } from "@ryco/client-runtime/state/threads/threadPins";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";

import { ChipBar } from "../../components/ChipBar";
import { FloatingActionButton } from "../../components/FloatingActionButton";
import { HeaderIconButton } from "../../components/HeaderIconButton";
import { MachinePickerButton } from "../../components/MachinePickerButton";
import { useDirectoryPresenceDemand } from "../../hostedHub/directoryDemand";
import { openThread as openThreadOverSheets } from "../../navigation/openThread";
import { MAIN_TABS } from "../../navigation/tabs/mainTabsModel";
import {
  TabLargeTitle,
  useLargeTitleCollapse,
  useTabContentInsets,
  useTabStackHeader,
} from "../../navigation/tabs/TabScreenChrome";
import { resolveHomeGroupingMode } from "../../state/homeGrouping";
import { usePreferences } from "../../state/preferencesStore";
import { markSnoozeWokeSeen } from "../../state/snoozeWokeSeen";
import { useThreadPins } from "../../state/threadPins";
import {
  buildInboxSections,
  createInboxSectionStabilizer,
  resolveInboxEmptyState,
  type InboxEmptyState,
  type InboxThreadRow,
} from "../inbox/inboxModel";
import { buildChatsListing } from "../inbox/inboxDelegationModel";
import { CustomSnoozeSheetHost } from "../inbox/CustomSnoozeSheet";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { InboxScreen } from "../inbox/InboxScreen";
import { countArchivedThreads } from "../archive/archivedThreadsModel";
import { buildProjectRows, type ProjectListRow } from "../projects/projectsModel";
import { ProjectsScreen } from "../projects/ProjectsScreen";
import type { ChatsFilter } from "./chatsListModel";
import { chatsHasScope, chatsListKey, createChatsState, reduceChatsState } from "./chatsState";
import { createHomeScrollMemory } from "./homeScrollMemory";
import { useAutoSettleRuleHandOver } from "./useAutoSettleRuleHandOver";
import { useInboxSource } from "./useInboxSource";
import { useHostedWorkspaceDiscovery } from "./useHostedWorkspaceDiscovery";
import { useHomeThreadPrefetch } from "./useHomeThreadPrefetch";
import { NeedsVerificationSection } from "./NeedsVerificationSection";
import { QueuedTasksSection } from "../newTask/QueuedTasksSection";

const PROJECT_FILTER_PREFIX = "project:";
const CLEAR_FILTERS = "clear";

/**
 * Chats, the first tab: every machine's threads by what they need — Needs you,
 * Working, Recent — with status chips, the machine picker, search and a
 * project filter in the header, and New task floating above the tab bar.
 * "By project" lists projects instead. Rows keep their swipe actions, pins and
 * long-press menus; delegated tasks fold under the chat that started them.
 */
export function HomeScreen() {
  const navigation = useNavigation();
  const [chats, dispatch] = useReducer(reduceChatsState, undefined, createChatsState);
  // Stable per screen. Scroll offsets never enter React state, and the inbox
  // keeps row identity across rebuilds so memoized rows skip unchanged content.
  const [scrollMemory] = useState(createHomeScrollMemory);
  const [stabilizeInboxSections] = useState(createInboxSectionStabilizer);
  const isFocused = useIsFocused();
  useHostedWorkspaceDiscovery(isFocused);
  useDirectoryPresenceDemand(isFocused);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const clockStaleRef = useRef(false);
  // The clock only runs while Chats is the focused screen: a covered list would
  // otherwise rebuild its whole model every tick for content nobody sees. It is
  // read again on the way back, since it stood still in between.
  useEffect(() => {
    if (!isFocused) {
      clockStaleRef.current = true;
      return;
    }
    if (clockStaleRef.current) {
      clockStaleRef.current = false;
      setNowMs(Date.now());
    }
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNowMs(Date.now());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [isFocused]);
  // The same clock keeps cached Hub nodes' "last seen" text current.
  const {
    environments,
    projects,
    worktrees,
    threads,
    localQueuedThreadIds,
    wokeSeenAtByThreadKey: wokeSeen,
  } = useInboxSource(nowMs);
  const preferences = usePreferences();
  const pins = useThreadPins();
  const pinnedThreadKeys = useMemo(() => pinnedThreadKeyList(pins), [pins]);
  useAutoSettleRuleHandOver(environments, preferences.sidebarAutoSettleAfterDays);
  const groupingMode = resolveHomeGroupingMode(preferences.projectGroupingEnabled);
  const byProject = chats.filter === "by-project";

  // Every thread's lineage, so a delegated child finds its host through
  // ancestors the list does not show.
  const lineageByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          "lineage" in thread ? thread.lineage : null,
        ]),
      ),
    [threads],
  );
  const inboxSections = useMemo(
    () =>
      byProject
        ? []
        : stabilizeInboxSections(
            buildInboxSections({
              projects,
              worktrees,
              threads,
              environments,
              nodeScope: chats.nodeScope,
              projectScope: chats.projectScope,
              localQueuedThreadIds,
              autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
              nowMs,
              wokeSeenAtByThreadKey: wokeSeen,
              pinnedThreadKeys,
            }),
          ),
    [
      byProject,
      chats.nodeScope,
      chats.projectScope,
      environments,
      localQueuedThreadIds,
      nowMs,
      pinnedThreadKeys,
      preferences.sidebarAutoSettleAfterDays,
      projects,
      stabilizeInboxSections,
      threads,
      wokeSeen,
      worktrees,
    ],
  );
  // Chip counts and filtering read the unfolded rows; children fold after the filter.
  const { sections: listedSections, chips } = useMemo(
    () => buildChatsListing(inboxSections, chats.filter, lineageByKey),
    [chats.filter, inboxSections, lineageByKey],
  );
  const projectRows = useMemo(
    () =>
      byProject
        ? buildProjectRows({
            projects,
            worktrees,
            threads,
            environments,
            nodeScope: chats.nodeScope,
            groupingMode,
          })
        : [],
    [byProject, chats.nodeScope, environments, groupingMode, projects, threads, worktrees],
  );

  // Read when a list (re)mounts: on a chip switch or a changed scope. Each list
  // records under its own key, so a late scroll event from the list being
  // replaced can never land on the other one.
  const listKey = chatsListKey(chats);
  const initialScrollOffset = scrollMemory.offsetFor(chats.filter, listKey);
  const recordScrollOffset = useCallback(
    (offset: number) => scrollMemory.record(chats.filter, listKey, offset),
    [chats.filter, listKey, scrollMemory],
  );

  const openNewTask = useCallback(
    () => navigation.navigate("NewTask", { environmentId: chats.nodeScope ?? undefined }),
    [chats.nodeScope, navigation],
  );
  const openNewChat = useCallback(
    () =>
      navigation.navigate("NewTask", { environmentId: chats.nodeScope ?? undefined, chat: "1" }),
    [chats.nodeScope, navigation],
  );
  const openMachines = useCallback(() => navigation.navigate("Connections"), [navigation]);
  const openSearch = useCallback(() => navigation.navigate("Search"), [navigation]);

  // Command-F opens Search and Command-N New task while Chats is in front.
  useHardwareKeyboardCommand("focusSearch", isFocused ? openSearch : undefined);
  useHardwareKeyboardCommand("newTask", isFocused ? openNewTask : undefined);

  // Projects the filter menu offers: the machine in view's, without "No project" chats.
  const filterProjects = useMemo(
    () =>
      excludeChatProjects(projects).filter(
        (project) => chats.nodeScope === null || project.environmentId === chats.nodeScope,
      ),
    [chats.nodeScope, projects],
  );
  const projectFilterActive = chats.projectScope !== null;
  const { collapsed, onScroll } = useLargeTitleCollapse();
  const contentInsets = useTabContentInsets();
  useTabStackHeader({
    title: collapsed ? MAIN_TABS.Chats.title : "",
    // A custom item without the shared glass, so the picker draws its own avatar and pill.
    unstable_headerLeftItems: () => [
      {
        type: "custom",
        hidesSharedBackground: true,
        element: (
          <MachinePickerButton
            environments={environments}
            selected={chats.nodeScope}
            onSelect={(environmentId) => dispatch({ type: "set-node-scope", environmentId })}
            onManage={openMachines}
          />
        ),
      },
    ],
    headerRight: () => (
      <View className="flex-row items-center gap-1">
        <HeaderIconButton icon="magnifyingglass" accessibilityLabel="Search" onPress={openSearch} />
        <MenuView
          title="Show chats from"
          actions={[
            {
              id: CLEAR_FILTERS,
              title: "All projects",
              state: projectFilterActive ? "off" : "on",
            },
            ...filterProjects.map((project) => {
              const key = scopedProjectKey({
                environmentId: project.environmentId,
                projectId: project.id,
              });
              return {
                id: `${PROJECT_FILTER_PREFIX}${key}`,
                title: project.name,
                state: key === chats.projectScope ? ("on" as const) : ("off" as const),
              };
            }),
          ]}
          onPressAction={({ nativeEvent }) => {
            const projectKey = nativeEvent.event.startsWith(PROJECT_FILTER_PREFIX)
              ? nativeEvent.event.slice(PROJECT_FILTER_PREFIX.length)
              : null;
            dispatch({ type: "set-project-scope", projectKey });
          }}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={projectFilterActive ? "Filter, one project" : "Filter by project"}
          >
            <HeaderIconButton
              icon={
                projectFilterActive
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle"
              }
              accessibilityLabel="Filter"
              active={projectFilterActive}
            />
          </View>
        </MenuView>
      </View>
    ),
  });

  // A row tap pushes the thread; a thread jump (Command-1…9) can come while a
  // sheet covers Chats or a thread is open, and closes or replaces those.
  const openThread = useCallback(
    (thread: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly messageId?: string | undefined;
    }) => openThreadOverSheets(navigation, thread),
    [navigation],
  );
  // Opening a recent thread shows its whole conversation at once: the top rows are fetched
  // once Home is still, and a row as soon as a finger goes down on it.
  const prefetchRows = useMemo(
    () => (byProject ? [] : listedSections.flatMap((section) => section.rows)),
    [byProject, listedSections],
  );
  const prefetchReadinessKey = environments
    .map((environment) => `${environment.environmentId}:${environment.mutationReady ? 1 : 0}`)
    .join(",");
  const pressInThread = useHomeThreadPrefetch({
    rows: prefetchRows,
    focused: isFocused,
    readinessKey: prefetchReadinessKey,
  });
  const prefetchInboxThread = useCallback(
    (row: InboxThreadRow) => pressInThread(scopeThreadRef(row.environmentId, row.threadId)),
    [pressInThread],
  );
  const openInboxThread = useCallback(
    (row: InboxThreadRow) => {
      // Opening a woken thread clears its "Woke" mark.
      if (row.wokeAt) markSnoozeWokeSeen(row.key, row.wokeAt);
      openThread({ environmentId: row.environmentId, threadId: row.threadId });
    },
    [openThread],
  );
  const selectFilter = useCallback(
    (filter: ChatsFilter) => dispatch({ type: "select-filter", filter }),
    [],
  );

  const handleInboxEmptyAction = useCallback(
    (state: Exclude<InboxEmptyState, null>) => {
      if (state === "connect-node") openMachines();
      else if (state === "clear-filter") dispatch({ type: "clear-filters" });
      else selectFilter("by-project");
    },
    [openMachines, selectFilter],
  );
  const addProject = useCallback(() => navigation.navigate("AddProject"), [navigation]);
  const openProject = useCallback(
    (row: ProjectListRow) =>
      navigation.navigate("Project", {
        environmentId: row.open.environmentId,
        projectId: row.open.projectId,
      }),
    [navigation],
  );

  // "No project" chats are not somewhere to start a task, so they do not count as projects here.
  const projectCount = useMemo(() => excludeChatProjects(projects).length, [projects]);
  const unarchivedThreadCount = useMemo(
    () => threads.filter((thread) => thread.archivedAt === null).length,
    [threads],
  );
  const archivedCount = useMemo(
    () => countArchivedThreads(threads, chats.nodeScope),
    [chats.nodeScope, threads],
  );
  const openArchived = useCallback(() => navigation.navigate("SettingsArchived"), [navigation]);
  const inboxEmptyState = resolveInboxEmptyState({
    environmentCount: environments.length,
    projectCount,
    threadCount: unarchivedThreadCount,
    hasFilter: chatsHasScope(chats) || chats.filter !== "all",
  });

  const listHeader = (
    <View>
      <TabLargeTitle title={MAIN_TABS.Chats.title}>
        <ChipBar
          accessibilityLabel="Show chats"
          items={chips.map((chip) => ({
            key: chip.filter,
            label: chip.label,
            count: chip.count,
            selected: chip.selected,
            accessibilityLabel: chip.accessibilityLabel,
          }))}
          onSelect={(key) => selectFilter(key as ChatsFilter)}
        />
      </TabLargeTitle>
      <NeedsVerificationSection />
      <QueuedTasksSection machines={environments} />
    </View>
  );

  return (
    <View className="flex-1 bg-screen">
      <CustomSnoozeSheetHost />
      {byProject ? (
        <ProjectsScreen
          filterKey={listKey}
          rows={projectRows}
          hasMachines={environments.length > 0}
          initialScrollOffset={initialScrollOffset}
          onScrollOffset={recordScrollOffset}
          onScroll={onScroll}
          listHeader={listHeader}
          contentInsets={contentInsets}
          onAddProject={addProject}
          onOpenProject={openProject}
          onAddMachine={openMachines}
        />
      ) : (
        <InboxScreen
          // A fresh list per chip and scope: its shelves start as that chip wants (Done open).
          key={listKey}
          filterKey={listKey}
          sections={listedSections}
          emptyState={inboxEmptyState}
          nowMs={nowMs}
          initialScrollOffset={initialScrollOffset}
          onScrollOffset={recordScrollOffset}
          onScroll={onScroll}
          listHeader={listHeader}
          contentInsets={contentInsets}
          settledStartsOpen={chats.filter === "done"}
          onOpenThread={openInboxThread}
          onPressInThread={prefetchInboxThread}
          onEmptyAction={handleInboxEmptyAction}
          archivedCount={archivedCount}
          onOpenArchived={openArchived}
        />
      )}
      <FloatingActionButton
        icon="plus"
        accessibilityLabel="New task"
        onPress={openNewTask}
        bottom={contentInsets.bottom + 16}
        longPressMenu={{
          actions: NEW_CHAT_MENU_ACTIONS,
          onPressAction: (id) => (id === "new-chat" ? openNewChat() : openNewTask()),
        }}
      />
    </View>
  );
}

/** The + button's touch-and-hold menu: a task in a project, or a chat without one. */
const NEW_CHAT_MENU_ACTIONS = [
  { id: "new-task", title: "New task", subtitle: "In a project", image: "folder" },
  { id: "new-chat", title: "New chat", subtitle: "No project", image: "bubble.left" },
] as const;
