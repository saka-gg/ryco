import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import { getQueuedThreadKeys } from "@ryco/client-runtime/state/message-queue";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AppState, Pressable, View } from "react-native";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";

import { HomeModeControl } from "../../components/HomeModeControl";
import { HomeBottomToolbar } from "../../components/HomeBottomToolbar";
import { RycoWordmark } from "../../components/RycoWordmark";
import { SymbolView } from "../../components/AppSymbol";
import { useDirectoryPresenceDemand } from "../../hostedHub/directoryDemand";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useMessageQueueStore } from "../../state/messageQueueStore";
import { resolveHomeGroupingMode } from "../../state/homeGrouping";
import { usePreferences } from "../../state/preferencesStore";
import { useStore } from "../../state/threadsRuntime";
import {
  buildInboxSections,
  createInboxSectionStabilizer,
  resolveInboxEmptyState,
  type InboxEmptyState,
  type InboxSection,
  type InboxThreadRow,
} from "../inbox/inboxModel";
import { InboxScreen } from "../inbox/InboxScreen";
import { buildProjectRows, type ProjectListRow } from "../projects/projectsModel";
import { ProjectsScreen } from "../projects/ProjectsScreen";
import { buildHomeChromeModel } from "./homeChromeModel";
import { createHomeModeState, reduceHomeModeState, type HomeMode } from "./homeMode";
import { createHomeScrollMemory, homeListFilterKey } from "./homeScrollMemory";
import { useHomeEnvironments } from "./useHomeEnvironments";
import { NeedsVerificationSection } from "./NeedsVerificationSection";

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
  const environments = useHomeEnvironments({ nowMs });
  // Keyed by the ids alone: a list rebuilt for a clock tick or a status change
  // keeps the same eligible set, so the workspace rows are not refiltered.
  const eligibleEnvironmentKey = environments
    .map((environment) => environment.environmentId)
    .join("\u0000");
  const eligibleEnvironmentIds = useMemo(
    () => new Set(eligibleEnvironmentKey === "" ? [] : eligibleEnvironmentKey.split("\u0000")),
    [eligibleEnvironmentKey],
  );
  const { projects, worktrees, threads } = useHomeWorkspaceData(eligibleEnvironmentIds);
  const queuesByThreadKey = useMessageQueueStore((state) => state.queuesByThreadKey);
  const localQueuedThreadIds = useMemo(
    () => getQueuedThreadKeys(queuesByThreadKey),
    [queuesByThreadKey],
  );
  const preferences = usePreferences();
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
              aiFocusEnabled: preferences.aiFocusEnabled ?? false,
              autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
              nowMs,
            }),
          )
        : NO_INBOX_SECTIONS,
    [
      environments,
      home.mode,
      home.nodeScopeByMode.inbox,
      home.queryByMode.inbox,
      localQueuedThreadIds,
      nowMs,
      preferences.aiFocusEnabled,
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

  const openNewTask = () =>
    navigation.navigate("NewTask", {
      environmentId: currentNodeScope ?? undefined,
    });

  const openMachines = useCallback(() => navigation.navigate("Connections"), [navigation]);

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

  const openThread = useCallback(
    (thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) => {
      useStore.getState().setActiveEnvironmentId(thread.environmentId);
      navigation.navigate("Thread", {
        environmentId: thread.environmentId,
        threadId: thread.threadId,
      });
    },
    [navigation],
  );
  const openInboxThread = useCallback((row: InboxThreadRow) => openThread(row), [openThread]);

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
        />
      </View>
    </KeyboardAvoidingView>
  );
}
