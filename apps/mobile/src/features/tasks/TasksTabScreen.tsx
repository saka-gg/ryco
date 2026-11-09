import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import {
  dueAtForDay,
  dueQuickPicks,
  refreshLocalTasks,
  type LocalTaskView,
} from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  LayoutAnimation,
  Pressable,
  RefreshControl,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  SwipeableScrollGateProvider,
  ThreadSwipeable,
  useSwipeableScrollGate,
  type ThreadSwipeAction,
} from "../threadList/ThreadSwipeable";
import {
  confirmDeleteTask,
  openTaskChat,
  openTaskDetail,
  setTaskDone,
  setTaskDue,
  startTaskChat,
} from "./taskActions";
import { openTaskCapture } from "./taskCaptureStore";
import { TaskRow } from "./TaskRow";
import {
  buildTaskSections,
  DONE_PREVIEW_COUNT,
  type TaskEntry,
  type TaskRowContext,
  type TaskRowModel,
  type TaskSectionKey,
} from "./tasksListModel";
import {
  resolveTaskMachineFilter,
  resolveTaskProjectFilter,
  selectTaskMachine,
  selectTaskProject,
  type TaskMachine,
} from "./tasksMachinesModel";
import { TaskUndoToast } from "./TaskUndoToast";
import { rereadTaskMachines } from "./taskConnectionDemand";
import { useTaskMachines, useTasksAcrossMachines } from "./useMachineTasks";
import { updateTasksTabState, useTasksTabState, useTasksTabStateLoaded } from "./useTasksTabState";

/** How long a checked row stays in place, checked, before it moves to Done (or back). */
const CHECK_SETTLE_MS = 420;

type ListItem =
  | {
      readonly kind: "heading";
      readonly key: string;
      readonly section: TaskSectionKey;
      readonly title: string;
      readonly count: number;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly row: TaskRowModel;
      readonly first: boolean;
      readonly last: boolean;
    }
  | {
      readonly kind: "more";
      readonly key: string;
      readonly hidden: number;
      readonly expanded: boolean;
    };

function HeaderIconButton(props: {
  readonly symbol: string;
  readonly label: string;
  readonly onPress: () => void;
}) {
  const icon = useThemeColor("--color-icon") as string;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={6}
      onPress={props.onPress}
      className="h-10 w-10 items-center justify-center rounded-full bg-subtle active:bg-subtle-strong"
    >
      <SymbolView name={props.symbol as never} size={17} tintColor={icon} />
    </Pressable>
  );
}

interface PickerProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly name: string;
  readonly machineLabel: string;
}

/**
 * Top-left: every machine's tasks or one machine's (when there are several),
 * and one project's. A project belongs to a machine: picking one picks it.
 */
function ScopePicker(props: {
  readonly machines: ReadonlyArray<TaskMachine>;
  readonly machine: TaskMachine | null;
  readonly projects: ReadonlyArray<PickerProject>;
  readonly projectId: ProjectId | null;
  readonly onMachine: (environmentId: EnvironmentId | null) => void;
  readonly onProject: (project: PickerProject | null) => void;
}) {
  const icon = useThemeColor("--color-icon-muted") as string;
  const several = props.machines.length > 1;
  const project = props.projects.find((candidate) => candidate.id === props.projectId) ?? null;
  const machineLabel = props.machine?.label ?? "All machines";
  const label = project
    ? several
      ? `${machineLabel} · ${project.name}`
      : project.name
    : several
      ? machineLabel
      : "All projects";
  const actions: MenuAction[] = [];
  if (several)
    actions.push({
      id: "machines",
      title: "Machine",
      displayInline: true,
      subactions: [
        { id: "machine:", title: "All machines", state: props.machine === null ? "on" : "off" },
        ...props.machines.map((machine) => ({
          id: `machine:${machine.environmentId}`,
          title: machine.label,
          ...(machine.reachable ? {} : { subtitle: "Offline" }),
          state:
            machine.environmentId === props.machine?.environmentId
              ? ("on" as const)
              : ("off" as const),
        })),
      ],
    });
  if (props.projects.length > 0)
    actions.push({
      id: "projects",
      title: "Project",
      displayInline: true,
      subactions: [
        { id: "project:", title: "All projects", state: props.projectId === null ? "on" : "off" },
        ...props.projects.map((candidate) => ({
          id: `project:${candidate.environmentId}:${candidate.id}`,
          title: candidate.name,
          // Every machine shows: say which machine a project is on.
          ...(several && props.machine === null ? { subtitle: candidate.machineLabel } : {}),
          state: candidate.id === props.projectId ? ("on" as const) : ("off" as const),
        })),
      ],
    });
  const onPressAction = (event: NativeActionEvent) => {
    const id = event.nativeEvent.event;
    void Haptics.selectionAsync();
    if (id.startsWith("machine:")) {
      const environmentId = id.slice("machine:".length);
      props.onMachine(environmentId.length > 0 ? (environmentId as EnvironmentId) : null);
    } else if (id.startsWith("project:")) {
      const rest = id.slice("project:".length);
      props.onProject(
        rest.length === 0
          ? null
          : (props.projects.find(
              (candidate) => `${candidate.environmentId}:${candidate.id}` === rest,
            ) ?? null),
      );
    }
  };
  return (
    <MenuView title="Show tasks of" actions={actions} onPressAction={onPressAction}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Showing ${label}. Change.`}
        className="h-10 max-w-64 flex-row items-center gap-1.5 rounded-full bg-subtle px-3.5 active:bg-subtle-strong"
      >
        <Text className="shrink text-sm font-ryco-bold text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <SymbolView name="chevron.down" size={11} tintColor={icon} />
      </Pressable>
    </MenuView>
  );
}

function SearchField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const icon = useThemeColor("--color-icon-muted") as string;
  const placeholder = useThemeColor("--color-placeholder") as string;
  const text = useThemeColor("--color-foreground") as string;
  return (
    <View className="flex-row items-center gap-3 px-4">
      <View className="h-10 flex-1 flex-row items-center gap-2 rounded-xl bg-subtle px-3">
        <SymbolView name="magnifyingglass" size={14} tintColor={icon} />
        <TextInput
          autoFocus
          value={props.value}
          onChangeText={props.onChange}
          placeholder="Title, notes, links"
          placeholderTextColor={placeholder}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
          className="h-10 flex-1 font-sans text-base"
          style={{ color: text }}
        />
      </View>
      <Pressable accessibilityRole="button" onPress={props.onCancel} className="active:opacity-60">
        <Text className="text-base text-primary">Cancel</Text>
      </Pressable>
    </View>
  );
}

function LoadingRows() {
  return (
    <View
      accessible
      accessibilityLabel="Loading tasks"
      className="mx-4 mt-3 overflow-hidden rounded-2xl bg-card"
    >
      {[0, 1, 2, 3].map((index) => (
        <View key={index} className="flex-row gap-3 px-4" style={{ opacity: 1 - index * 0.2 }}>
          <View className="mt-3.5 h-[22px] w-[22px] rounded-full bg-subtle" />
          <View className={cn("flex-1 gap-2 py-3.5", index > 0 && "border-t border-border-subtle")}>
            <View className="h-4 w-3/4 rounded bg-subtle" />
            <View className="h-3 w-1/3 rounded bg-subtle" />
          </View>
        </View>
      ))}
    </View>
  );
}

function listItems(
  sections: ReturnType<typeof buildTaskSections>,
  showAllDone: boolean,
): ReadonlyArray<ListItem> {
  const items: ListItem[] = [];
  for (const section of sections) {
    items.push({
      kind: "heading",
      key: `heading:${section.key}`,
      section: section.key,
      title: section.title,
      count: section.count,
    });
    const rows =
      section.key === "done" && !showAllDone
        ? section.rows.slice(0, DONE_PREVIEW_COUNT)
        : section.rows;
    rows.forEach((row, index) =>
      items.push({
        kind: "row",
        key: `row:${row.key}`,
        row,
        first: index === 0,
        last: index === rows.length - 1,
      }),
    );
    if (section.key === "done" && section.rows.length > DONE_PREVIEW_COUNT)
      items.push({
        kind: "more",
        key: "more:done",
        hidden: section.rows.length - DONE_PREVIEW_COUNT,
        expanded: showAllDone,
      });
  }
  return items;
}

function dueSwipeMenu(nowMs: number): ThreadSwipeAction["menu"] {
  return {
    title: "Due",
    actions: [
      // Keyed by label: on a Sunday, Tomorrow and Next week are the same day.
      ...dueQuickPicks(nowMs).map((pick) => ({ id: pick.label, title: pick.label })),
      { id: "none", title: "No date" },
    ],
    onPressAction: () => undefined,
  };
}

/**
 * The Tasks tab's root: the tasks of every machine the phone reaches, paired
 * directly or through the Hub (the same tasks as the desktop and web Tasks
 * page), merged and grouped by due day, with fast capture, check-off with
 * Undo and swipe actions. An offline machine's tasks show as last read,
 * greyed and read-only. Mount it without a navigation header.
 */
export function TasksTabScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tabState = useTasksTabState();
  const tabStateLoaded = useTasksTabStateLoaded();
  const machines = useTaskMachines();
  // Hub machines are asked for only while the tab is in front.
  const focused = useIsFocused();
  const filterMachine = resolveTaskMachineFilter(machines, tabState.environmentId);
  const slices = useTasksAcrossMachines(machines, {
    demand: focused,
    priority: filterMachine === null ? [] : [filterMachine.environmentId],
  });
  const filterSlice =
    filterMachine === null
      ? null
      : (slices.find((slice) => slice.machine.environmentId === filterMachine.environmentId) ??
        null);
  const projectFilter =
    filterSlice === null ? null : resolveTaskProjectFilter(tabState, filterSlice.projects);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // Rows checked (or unchecked) that have not moved yet: row key -> shown checked.
  const [settling, setSettling] = useState<ReadonlyMap<string, boolean>>(new Map());
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The writes of checks still settling: leaving the screen sends them at once.
  const settleWrites = useRef(new Map<string, () => void>());
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate();
  const card = useThemeColor("--color-card") as string;
  const mutedIcon = useThemeColor("--color-icon-muted") as string;
  const primary = useThemeColor("--color-primary") as string;
  const primaryForeground = useThemeColor("--color-primary-foreground") as string;
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Due labels count calendar days: re-read "now" each minute so midnight moves them.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    const timers = settleTimers.current;
    const writes = settleWrites.current;
    return () => {
      clearInterval(timer);
      for (const pending of timers.values()) clearTimeout(pending);
      for (const write of writes.values()) write();
      writes.clear();
    };
  }, []);

  const showMachine = machines.length > 1 && filterMachine === null;
  const contexts = new Map<string, TaskRowContext>(
    slices.map((slice) => [
      slice.machine.environmentId,
      {
        environmentId: slice.machine.environmentId,
        machineLabel: showMachine ? slice.machine.label : null,
        offline: !slice.machine.reachable,
        nowMs,
        // Filtered to one project, its name on every row says nothing.
        projectNames: new Map(
          projectFilter === null
            ? slice.projects.map((project) => [project.id as string, project.name] as const)
            : [],
        ),
        getSummary: slice.getSummary,
        canStart: slice.projects.length > 0,
      },
    ]),
  );
  const entries: TaskEntry[] = slices.flatMap((slice) =>
    slice.tasks.map((task) => ({ environmentId: slice.machine.environmentId, task })),
  );
  const sections = buildTaskSections(
    entries,
    {
      environmentId: filterMachine?.environmentId ?? null,
      projectId: projectFilter,
      query: searching ? query : "",
    },
    (environmentId) => contexts.get(environmentId)!,
  );
  const items = listItems(sections, tabState.showAllDone);
  const taskByKey = new Map<string, LocalTaskView>(
    entries.map((entry) => [`${entry.environmentId}:${entry.task.taskId}`, entry.task]),
  );
  const pickerProjects: PickerProject[] = slices.flatMap((slice) =>
    filterMachine !== null && slice.machine.environmentId !== filterMachine.environmentId
      ? []
      : slice.projects.map((project) => ({
          environmentId: slice.machine.environmentId,
          id: project.id,
          name: project.name,
          machineLabel: slice.machine.label,
        })),
  );

  const toggle = (row: TaskRowModel) => {
    if (row.offline) return;
    const shown = settling.get(row.key) ?? row.done;
    const next = !shown;
    setSettling((current) => new Map(current).set(row.key, next));
    const pending = settleTimers.current.get(row.key);
    if (pending) clearTimeout(pending);
    const write = () => {
      settleWrites.current.delete(row.key);
      if (next !== row.done) setTaskDone(row.environmentId, row, next);
    };
    settleWrites.current.set(row.key, write);
    settleTimers.current.set(
      row.key,
      setTimeout(() => {
        settleTimers.current.delete(row.key);
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setSettling((current) => {
          const copy = new Map(current);
          copy.delete(row.key);
          return copy;
        });
        write();
      }, CHECK_SETTLE_MS),
    );
  };
  const openRow = (row: TaskRowModel) => openTaskDetail(navigation, row.environmentId, row.taskId);
  const chat = (row: TaskRowModel) => {
    if (row.chatAction === null) return;
    if (row.chatAction.kind === "open")
      openTaskChat(navigation, row.environmentId, row.chatAction.threadId);
    else startTaskChat(navigation, row.environmentId, row);
  };
  const capture = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    openTaskCapture({
      environmentId: filterMachine?.environmentId ?? null,
      projectId: projectFilter,
      openDetails: (environmentId, taskId) => openTaskDetail(navigation, environmentId, taskId),
    });
  };
  const refresh = () => {
    setRefreshing(true);
    // Hub machines not connected now are read once more, one at a time.
    rereadTaskMachines();
    void Promise.all(
      slices
        .filter((slice) => slice.machine.connected)
        .map((slice) => refreshLocalTasks(slice.machine.environmentId)),
    ).finally(() => setRefreshing(false));
  };

  const renderRow = (item: Extract<ListItem, { kind: "row" }>) => {
    const { row } = item;
    const checked = settling.get(row.key) ?? row.done;
    const task = taskByKey.get(row.key);
    const leading: ThreadSwipeAction = row.done
      ? {
          accessibilityLabel: `Reopen ${row.title}`,
          icon: "arrow.uturn.backward",
          label: "Reopen",
          tone: "secondary",
          onPress: () => toggle(row),
        }
      : {
          accessibilityLabel: `Complete ${row.title}`,
          icon: "checkmark",
          label: "Done",
          tone: "accent",
          onPress: () => toggle(row),
        };
    const remove: ThreadSwipeAction = {
      accessibilityLabel: `Delete ${row.title}`,
      icon: "trash",
      label: "Delete",
      tone: "danger",
      onPress: () => void confirmDeleteTask(row.environmentId, row),
    };
    const menu = dueSwipeMenu(nowMs);
    const due: ThreadSwipeAction | null =
      row.done || menu === undefined
        ? null
        : {
            accessibilityLabel: `Change the due date of ${row.title}`,
            icon: "calendar",
            label: "Due",
            tone: "secondary",
            menu: {
              ...menu,
              onPressAction: (event) => {
                if (task === undefined) return;
                const pick = dueQuickPicks(Date.now()).find((quick) => quick.label === event);
                setTaskDue(row.environmentId, task, pick ? dueAtForDay(pick.dayMs) : null);
              },
            },
            onPress: () => undefined,
          };
    return (
      <View
        className={cn(
          "mx-4 overflow-hidden",
          item.first && "rounded-t-2xl",
          item.last && "rounded-b-2xl",
        )}
      >
        <ThreadSwipeable
          backgroundColor={card}
          fullSwipeWidth={width - 32}
          threadKey={`task:${row.key}`}
          // An offline machine's task can't change: no swipe actions.
          enabled={swipeEnabled && !row.offline}
          leadingAction={leading}
          primaryAction={remove}
          secondaryAction={due}
        >
          <TaskRow
            row={row}
            checked={checked}
            first={item.first}
            onToggle={toggle}
            onOpen={openRow}
            onChat={chat}
          />
        </ThreadSwipeable>
      </View>
    );
  };

  const visibleSlices = filterSlice === null ? slices : [filterSlice];
  const offlineMachines = visibleSlices.filter((slice) => !slice.machine.reachable);
  const anyConnected = machines.some((machine) => machine.reachable);
  const firstRead = visibleSlices.every((slice) => slice.environment.readAt === null);
  const readError =
    visibleSlices.find((slice) => slice.environment.status === "error" && slice.environment.error)
      ?.environment.error ?? null;
  const offlineNotice =
    offlineMachines.length === 0
      ? null
      : `${offlineMachines.map((slice) => slice.machine.label).join(", ")} ${
          offlineMachines.length === 1 ? "is" : "are"
        } offline. ${
          offlineMachines.some((slice) => slice.environment.readAt !== null)
            ? "Their tasks show as last read and can't change until they're back."
            : "Their tasks show once they're back."
        }`;
  const header = (
    <View className="gap-3 pb-1" style={{ paddingTop: insets.top + 6 }}>
      {searching ? (
        <SearchField
          value={query}
          onChange={setQuery}
          onCancel={() => {
            setSearching(false);
            setQuery("");
          }}
        />
      ) : (
        <View className="flex-row items-center gap-2 px-4">
          {machines.length > 0 ? (
            <ScopePicker
              machines={machines}
              machine={filterMachine}
              projects={pickerProjects}
              projectId={projectFilter}
              onMachine={(id) => updateTasksTabState((state) => selectTaskMachine(state, id))}
              onProject={(project) =>
                updateTasksTabState((state) =>
                  selectTaskProject(
                    state,
                    project === null
                      ? null
                      : { environmentId: project.environmentId, projectId: project.id },
                  ),
                )
              }
            />
          ) : null}
          <View className="flex-1" />
          {machines.length > 0 ? (
            <HeaderIconButton
              symbol="magnifyingglass"
              label="Search tasks"
              onPress={() => setSearching(true)}
            />
          ) : null}
        </View>
      )}
      {searching ? null : (
        <Text
          accessibilityRole="header"
          className="px-4 text-[32px] leading-[38px] font-ryco-bold text-foreground"
        >
          Tasks
        </Text>
      )}
      {offlineNotice !== null ? (
        <View className="mx-4 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5">
          <SymbolView name="wifi.slash" size={14} tintColor={mutedIcon} />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">{offlineNotice}</Text>
        </View>
      ) : null}
      {readError !== null && !firstRead ? (
        <Text className="px-5 text-xs text-danger-foreground">{readError.message}</Text>
      ) : null}
    </View>
  );

  const loading = firstRead && visibleSlices.some((slice) => slice.machine.reachable);
  const empty =
    machines.length === 0 ? (
      <EmptyState
        variant="plain"
        title={tabStateLoaded ? "No machine with tasks" : "Loading…"}
        detail={
          tabStateLoaded
            ? "Tasks live on your machines. Pair a machine you own, or sign in to your Hub, to see their tasks here."
            : ""
        }
      />
    ) : readError !== null && firstRead ? (
      <EmptyState
        variant="card"
        title="Tasks could not be read"
        detail={readError.message || "Pull to try again."}
      />
    ) : loading ? (
      <LoadingRows />
    ) : firstRead ? (
      <EmptyState
        variant="plain"
        title="Machine offline"
        detail="Reconnect it to read its tasks."
      />
    ) : searching && query.trim().length > 0 ? (
      <EmptyState variant="plain" title="No results" detail="No task matches the search." />
    ) : (
      <EmptyState
        variant="plain"
        title={projectFilter === null ? "No tasks yet" : "No tasks in this project"}
        detail="Jot down what needs doing; start an agent chat from any task when you are ready."
        {...(anyConnected ? { actionLabel: "Add a task", onAction: capture } : {})}
      />
    );

  return (
    <View className="flex-1 bg-screen">
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <FlatList<ListItem>
          className="flex-1"
          contentInsetAdjustmentBehavior="never"
          data={items}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={header}
          {...scrollGateHandlers}
          scrollEventThrottle={16}
          renderItem={({ item }) => {
            switch (item.kind) {
              case "heading":
                return (
                  <View className="flex-row items-baseline justify-between px-5 pb-1.5 pt-5">
                    <Text
                      accessibilityRole="header"
                      className={cn(
                        "text-[13px] font-ryco-bold uppercase tracking-wide",
                        item.section === "today" ? "text-foreground" : "text-foreground-muted",
                      )}
                    >
                      {item.title}
                    </Text>
                    <Text className="text-[13px] text-foreground-tertiary">{item.count}</Text>
                  </View>
                );
              case "row":
                return renderRow(item);
              case "more":
                return (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                      updateTasksTabState((state) => ({
                        ...state,
                        showAllDone: !state.showAllDone,
                      }));
                    }}
                    className="mx-4 mt-1 items-center py-2.5 active:opacity-60"
                  >
                    <Text className="text-[13px] font-ryco-medium text-foreground-muted">
                      {item.expanded ? "Show fewer" : `Show ${item.hidden} more`}
                    </Text>
                  </Pressable>
                );
            }
          }}
          ListEmptyComponent={loading ? empty : <View className="px-6 py-14">{empty}</View>}
          refreshControl={
            machines.length === 0 ? undefined : (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={refresh}
                progressViewOffset={insets.top}
              />
            )
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 120 }}
        />
      </SwipeableScrollGateProvider>
      {anyConnected ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New task"
          onPress={capture}
          className="absolute h-14 w-14 items-center justify-center rounded-full active:opacity-80"
          style={{
            right: 20,
            bottom: insets.bottom + 20,
            backgroundColor: primary,
            shadowColor: "#000",
            shadowOpacity: 0.35,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
          }}
        >
          <SymbolView name="plus" size={22} weight="semibold" tintColor={primaryForeground} />
        </Pressable>
      ) : null}
      <TaskUndoToast bottom={insets.bottom + 88} />
    </View>
  );
}
