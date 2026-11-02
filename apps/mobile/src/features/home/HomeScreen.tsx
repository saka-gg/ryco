import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AppState, Pressable, View, type TextInput } from "react-native";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";

import { HomeModeControl } from "../../components/HomeModeControl";
import { HomeBottomToolbar } from "../../components/HomeBottomToolbar";
import { RycoWordmark } from "../../components/RycoWordmark";
import { SymbolView } from "../../components/AppSymbol";
import { useDirectoryPresenceDemand } from "../../hostedHub/directoryDemand";
import { useThemeColor } from "../../lib/useThemeColor";
import { openThread as openThreadOverSheets } from "../../navigation/openThread";
import { resolveHomeGroupingMode } from "../../state/homeGrouping";
import { usePreferences } from "../../state/preferencesStore";
import { markSnoozeWokeSeen } from "../../state/snoozeWokeSeen";
import { useStore } from "../../state/threadsRuntime";
import {
  buildInboxSections,
  createInboxSectionStabilizer,
  resolveInboxEmptyState,
  type InboxEmptyState,
  type InboxSection,
  type InboxThreadRow,
} from "../inbox/inboxModel";
import { CustomSnoozeSheetHost } from "../inbox/CustomSnoozeSheet";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { InboxScreen } from "../inbox/InboxScreen";
import { buildProjectRows, type ProjectListRow } from "../projects/projectsModel";
import { ProjectsScreen } from "../projects/ProjectsScreen";
import { buildHomeChromeModel } from "./homeChromeModel";
import { createHomeModeState, reduceHomeModeState, type HomeMode } from "./homeMode";
import { createHomeScrollMemory, homeListFilterKey } from "./homeScrollMemory";
import { useAutoSettleRuleHandOver } from "./useAutoSettleRuleHandOver";
import { useInboxSource } from "./useInboxSource";
import { NeedsVerificationSection } from "./NeedsVerificationSection";
import { QueuedTasksSection } from "../newTask/QueuedTasksSection";

const NO_INBOX_SECTIONS: ReadonlyArray<InboxSection> = [];
const NO_PROJECT_ROWS: ReadonlyArray<ProjectListRow> = [];

export function HomeScreen() {
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const [home, dispatch] = useReducer(reduceHomeModeState, undefined, () => createHomeModeState());
  // Stable per screen. Scroll offsets never enter React state, and the inbox
  // keeps row identity across rebuilds so memoized rows skip unchanged content.
  const [scrollMemory] = useState(createHomeScrollMemory);
  const [stabilizeInboxSections] = useState(createInboxSectionStabilizer);
  const iconColor = useThemeColor("--color-icon");
  const isFocused = useIsFocused();
  useDirectoryPresenceDemand(isFocused);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const clockStaleRef = useRef(false);
  // The clock only runs while Home is the focused screen: a covered Home would
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
  useAutoSettleRuleHandOver(environments, preferences.sidebarAutoSettleAfterDays);
  const groupingMode = resolveHomeGroupingMode(preferences.projectGroupingEnabled);

  const currentQuery = home.queryByMode[home.mode];
  const currentNodeScope = home.nodeScopeByMode[home.mode];
  const inboxFilterKey = homeListFilterKey(home.queryByMode.inbox, home.nodeScopeByMode.inbox);
  const projectsFilterKey = homeListFilterKey(
    home.queryByMode.projects,
    home.nodeScopeByMode.projects,
  );
  // Only the visible mode's model is built; the other is rebuilt on switch.
  const inboxSections = useMemo(
    () =>
      home.mode === "inbox"
        ? stabilizeInboxSections(
            buildInboxSections({
              projects,
              worktrees,
              threads,
              environments,
              query: home.queryByMode.inbox,
              nodeScope: home.nodeScopeByMode.inbox,
              localQueuedThreadIds,
              autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
              nowMs,
              wokeSeenAtByThreadKey: wokeSeen,
            }),
          )
        : NO_INBOX_SECTIONS,
    [
      wokeSeen,
      environments,
      home.mode,
      home.nodeScopeByMode.inbox,
      home.queryByMode.inbox,
      localQueuedThreadIds,
      nowMs,
      preferences.sidebarAutoSettleAfterDays,
      projects,
      stabilizeInboxSections,
      threads,
      worktrees,
    ],
  );
  const projectRows = useMemo(
    () =>
      home.mode === "projects"
        ? buildProjectRows({
            projects,
            worktrees,
            threads,
            environments,
            query: home.queryByMode.projects,
            nodeScope: home.nodeScopeByMode.projects,
            groupingMode,
          })
        : NO_PROJECT_ROWS,
    [
      environments,
      groupingMode,
      home.mode,
      home.nodeScopeByMode.projects,
      home.queryByMode.projects,
      projects,
      threads,
      worktrees,
    ],
  );
  // Read when a list (re)mounts: on a mode switch or a changed filter key. Each
  // list records under its own mode and key, so a late scroll event from the
  // list being replaced can never land on the other one.
  const initialScrollOffset = useMemo(
    () =>
      home.mode === "inbox"
        ? scrollMemory.offsetFor("inbox", inboxFilterKey)
        : scrollMemory.offsetFor("projects", projectsFilterKey),
    [home.mode, inboxFilterKey, projectsFilterKey, scrollMemory],
  );
  const recordInboxScrollOffset = useCallback(
    (offset: number) => scrollMemory.record("inbox", inboxFilterKey, offset),
    [inboxFilterKey, scrollMemory],
  );
  const recordProjectsScrollOffset = useCallback(
    (offset: number) => scrollMemory.record("projects", projectsFilterKey, offset),
    [projectsFilterKey, scrollMemory],
  );

  const chrome = useMemo(() => buildHomeChromeModel({ mode: home.mode }), [home.mode]);

  const openNewTask = useCallback(
    () =>
      navigation.navigate("NewTask", {
        environmentId: currentNodeScope ?? undefined,
      }),
    [currentNodeScope, navigation],
  );

  const openMachines = useCallback(() => navigation.navigate("Connections"), [navigation]);

  // Command-F and Command-N do what the toolbar's search field and New Task
  // button do, while Home is the screen in front.
  const searchInputRef = useRef<TextInput>(null);
  const focusSearch = useCallback(() => searchInputRef.current?.focus(), []);
  useHardwareKeyboardCommand("focusSearch", isFocused ? focusSearch : undefined);
  useHardwareKeyboardCommand("newTask", isFocused ? openNewTask : undefined);

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

  const selectMode = useCallback((mode: HomeMode) => {
    dispatch({ type: "select-mode", mode });
  }, []);

  // A row tap pushes the thread; a thread jump (Command-1…9) can come while a
  // sheet covers Home or a thread is open, and closes or replaces those.
  const openThread = useCallback(
    (thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) =>
      openThreadOverSheets(navigation, thread),
    [navigation],
  );
  const openInboxThread = useCallback(
    (row: InboxThreadRow) => {
      // Opening a woken thread clears its "Woke" mark.
      if (row.wokeAt) markSnoozeWokeSeen(row.key, row.wokeAt);
      openThread(row);
    },
    [openThread],
  );

  const handleInboxEmptyAction = useCallback(
    (state: Exclude<InboxEmptyState, null>) => {
      if (state === "connect-node") {
        openMachines();
      } else if (state === "clear-filter") {
        dispatch({ type: "set-query", mode: "inbox", query: "" });
        dispatch({ type: "set-node-scope", mode: "inbox", environmentId: null });
      } else {
        selectMode("projects");
      }
    },
    [openMachines, selectMode],
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
  const inboxEmptyState = resolveInboxEmptyState({
    environmentCount: environments.length,
    projectCount,
    threadCount: unarchivedThreadCount,
    hasFilter: home.queryByMode.inbox.length > 0 || home.nodeScopeByMode.inbox !== null,
  });

  return (
    <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
      <View className="flex-1 bg-screen" style={{ paddingTop: headerHeight }}>
        <HomeModeControl mode={home.mode} onSelect={selectMode} />
        <View className="min-h-0 flex-1">
          <NeedsVerificationSection />
          <QueuedTasksSection machines={environments} />
          <CustomSnoozeSheetHost />
          {home.mode === "inbox" ? (
            <InboxScreen
              filterKey={inboxFilterKey}
              sections={inboxSections}
              emptyState={inboxEmptyState}
              nowMs={nowMs}
              initialScrollOffset={initialScrollOffset}
              onScrollOffset={recordInboxScrollOffset}
              onOpenThread={openInboxThread}
              onEmptyAction={handleInboxEmptyAction}
            />
          ) : (
            <ProjectsScreen
              filterKey={projectsFilterKey}
              rows={projectRows}
              hasMachines={environments.length > 0}
              initialScrollOffset={initialScrollOffset}
              onScrollOffset={recordProjectsScrollOffset}
              onAddProject={addProject}
              onOpenProject={openProject}
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
          searchInputRef={searchInputRef}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
