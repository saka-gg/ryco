import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@ryco/contracts";
import { memo, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { DeviceIcon } from "../../components/DeviceIcon";
import { EmptyState } from "../../components/EmptyState";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { newCommandId } from "../../lib/ids";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { openThread } from "../../navigation/openThread";
import { useInboxSource } from "../home/useInboxSource";
import { canChangeThreadsOn } from "../inbox/inboxModel";
import { dispatchThreadListCommand } from "../threadList/threadListCommands";
import {
  SwipeableScrollGateProvider,
  ThreadSwipeable,
  useSwipeableScrollGate,
  type ThreadSwipeAction,
} from "../threadList/ThreadSwipeable";
import {
  buildArchivedThreadSections,
  type ArchivedEnvironment,
  type ArchivedThreadRow,
} from "./archivedThreadsModel";

type ArchivedListItem =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly title: string;
      readonly detail: string;
    }
  | { readonly kind: "thread"; readonly key: string; readonly row: ArchivedThreadRow };

/** Brings an archived thread back to the Inbox; the row animates out first. */
export function restoreArchivedThread(row: ArchivedThreadRow): void {
  if (!row.canRestore) return;
  dispatchThreadListCommand(
    row,
    { type: "thread.unarchive", threadId: row.threadId, commandId: newCommandId() },
    { dismiss: true, failureTitle: "Could not restore task" },
  );
}

const ROW_MENU = [
  { id: "restore", title: "Restore to Inbox" },
  { id: "copy-id", title: "Copy task ID" },
];
const ROW_CONTAINER_STYLE = { marginHorizontal: 16, marginBottom: 8, borderRadius: 16 };

const ArchivedRow = memo(function ArchivedRow(props: {
  readonly row: ArchivedThreadRow;
  readonly onOpen: (row: ArchivedThreadRow) => void;
}) {
  const { row } = props;
  const { width } = useWindowDimensions();
  const background = useThemeColor("--color-screen");
  const restore: ThreadSwipeAction | null = row.canRestore
    ? {
        accessibilityLabel: `Restore ${row.title}`,
        icon: "arrow.uturn.backward",
        label: "Restore",
        tone: "primary",
        onPress: () => restoreArchivedThread(row),
      }
    : null;
  const menu = ROW_MENU.map((item) => ({
    ...item,
    attributes: { disabled: item.id === "restore" && !row.canRestore },
  }));
  return (
    <ThreadSwipeable
      backgroundColor={background}
      containerStyle={ROW_CONTAINER_STYLE}
      fullSwipeWidth={width - 32}
      threadKey={row.key}
      leadingAction={null}
      primaryAction={restore}
      secondaryAction={null}
    >
      <MenuView
        shouldOpenOnLongPress
        actions={menu}
        onPressAction={({ nativeEvent }: NativeActionEvent) => {
          if (nativeEvent.event === "restore") restoreArchivedThread(row);
          if (nativeEvent.event === "copy-id")
            copyTextWithHaptic(row.threadId, { target: "task ID" });
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.title}, archived ${relativeTime(row.archivedAt)}, ${row.nodeLabel}`}
          accessibilityHint={row.canRestore ? "Swipe left to restore it to the Inbox." : undefined}
          onPress={() => props.onOpen(row)}
          className="flex-row items-center gap-3 rounded-2xl bg-card px-3.5 py-3 active:bg-card-alt"
        >
          <View className="min-w-0 flex-1 gap-1">
            <Text className="font-ryco-medium text-[15px] leading-[20px]" numberOfLines={2}>
              {row.title}
            </Text>
            <Text className="text-2xs text-foreground-tertiary" numberOfLines={1}>
              Archived {relativeTime(row.archivedAt)}
            </Text>
          </View>
          {row.canRestore ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Restore ${row.title}`}
              hitSlop={8}
              onPress={() => restoreArchivedThread(row)}
              className="h-9 items-center justify-center rounded-full bg-subtle-strong px-3 active:opacity-70"
            >
              <Text className="font-ryco-medium text-xs">Restore</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </MenuView>
    </ThreadSwipeable>
  );
});

/**
 * Archived tasks across the listed machines, by project, newest archived
 * first. Search by title, project or machine; restore with the row's button,
 * a swipe left or its long-press menu. Opening one shows it read-only.
 */
export function ArchivedThreadsRouteScreen() {
  const navigation = useNavigation();
  const [nowMs] = useState(() => Date.now());
  const { environments, projects, threads } = useInboxSource(nowMs);
  const [query, setQuery] = useState("");
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const placeholderColor = useThemeColor("--color-foreground-tertiary");
  const iconColor = useThemeColor("--color-icon-subtle");
  const archivedEnvironments = useMemo(
    () =>
      environments.map((environment): ArchivedEnvironment => ({
        environmentId: environment.environmentId,
        label: environment.label,
        canMutate:
          environment.connectionState === "connected" &&
          environment.stale !== true &&
          environment.mutationReady === true &&
          environment.shellCurrent === true &&
          environment.role !== "viewer",
      })),
    [environments],
  );
  const sections = useMemo(
    () =>
      buildArchivedThreadSections({
        projects,
        threads,
        environments: archivedEnvironments,
        environmentId,
        query,
      }),
    [archivedEnvironments, environmentId, projects, query, threads],
  );
  const showMachines = archivedEnvironments.length > 1;
  const data = useMemo(
    () =>
      sections.flatMap((section): ArchivedListItem[] => [
        {
          kind: "section",
          key: `section:${section.key}`,
          title: section.title,
          detail: showMachines ? section.nodeLabel : `${section.rows.length}`,
        },
        ...section.rows.map((row) => ({ kind: "thread" as const, key: row.key, row })),
      ]),
    [sections, showMachines],
  );
  const openArchived = (row: ArchivedThreadRow) =>
    openThread(navigation as Parameters<typeof openThread>[0], row);
  const renderItem = ({ item }: LegendListRenderItemProps<ArchivedListItem>) =>
    item.kind === "section" ? (
      <View className="flex-row items-baseline gap-2 px-5 pt-5 pb-2">
        <Text
          className="min-w-0 flex-1 text-sm font-ryco-medium text-foreground-muted"
          numberOfLines={1}
        >
          {item.title}
        </Text>
        <Text className="text-2xs text-foreground-tertiary" numberOfLines={1}>
          {item.detail}
        </Text>
      </View>
    ) : (
      <ArchivedRow row={item.row} onOpen={openArchived} />
    );
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate();
  const filtered = query.trim().length > 0 || environmentId !== null;

  const header = (
    <View className="gap-2 px-4 pt-3 pb-1">
      <View className="h-11 flex-row items-center gap-2 rounded-xl bg-card px-3">
        <SymbolView name="magnifyingglass" size={15} tintColor={iconColor} type="monochrome" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search archived tasks"
          placeholderTextColor={placeholderColor as string}
          accessibilityLabel="Search archived tasks"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          className="min-w-0 flex-1 font-sans text-[16px] text-foreground"
        />
      </View>
      {showMachines ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2 py-1">
            {[null, ...archivedEnvironments.map((environment) => environment.environmentId)].map(
              (id) => {
                const selected = environmentId === id;
                const label =
                  id === null
                    ? "All machines"
                    : (archivedEnvironments.find((environment) => environment.environmentId === id)
                        ?.label ?? "Machine");
                return (
                  <Pressable
                    key={id ?? "all"}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setEnvironmentId(id)}
                    className={`h-8 flex-row items-center gap-1.5 rounded-full px-3 ${selected ? "bg-primary" : "bg-card"}`}
                  >
                    {id === null ? null : <DeviceIcon environmentId={id} size={12} />}
                    <Text
                      className={`text-xs font-ryco-medium ${selected ? "text-primary-foreground" : "text-foreground-muted"}`}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              },
            )}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );

  return (
    <View className="flex-1 bg-screen">
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <LegendList
          data={data}
          renderItem={renderItem}
          keyExtractor={(item) => item.key}
          recycleItems
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          scrollEventThrottle={32}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <View className="px-2 py-12">
              <EmptyState
                variant="plain"
                title={filtered ? "Nothing matches" : "No archived tasks"}
                detail={
                  filtered
                    ? "Change the search or show all machines."
                    : "Tasks you archive appear here, and can be restored to the Inbox."
                }
              />
            </View>
          }
        />
      </SwipeableScrollGateProvider>
    </View>
  );
}
