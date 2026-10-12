import { sidebarUndo } from "../../state/sidebarUndo";
import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";
import { newCommandId } from "../../lib/ids";
import { MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { memo, useCallback, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import type { InboxEmptyState, InboxSection, InboxThreadRow } from "./inboxModel";
import {
  flattenInboxSections,
  MOBILE_SETTLED_PAGE_SIZE,
  type InboxListItem,
} from "./inboxListModel";
import { InboxThreadRow as ThreadRow } from "./InboxThreadRow";
import {
  buildInboxRowMenuActions,
  resolveSnoozeMenuPresets,
  snoozeMenuPresetsFromKey,
  snoozeMenuPresetsKey,
  type InboxSnoozeMenuPreset,
} from "./inboxRowActions";
import { HOME_LIST_PADDING_BOTTOM } from "../home/homeChromeModel";
import { WorkspaceConnectionStatus } from "../home/WorkspaceConnectionStatus";

const EMPTY_COPY: Readonly<
  Record<
    Exclude<InboxEmptyState, null>,
    { readonly title: string; readonly detail: string; readonly actionLabel: string }
  >
> = {
  // The internal id stays `connect-node`; only the copy moves off the noun.
  "connect-node": {
    title: "Add a machine",
    detail: "Use your Hub or pair a machine directly to bring its work into Ryco.",
    actionLabel: "Add a machine",
  },
  "add-project": {
    title: "No projects yet",
    detail: "Add a remote workspace on a connected machine to start working.",
    actionLabel: "Open Projects",
  },
  "new-task": {
    title: "No tasks yet",
    detail: "Start a task inside one of your projects.",
    actionLabel: "Open Projects",
  },
  "clear-filter": {
    title: "Nothing matches",
    detail: "Change the search or return to all machines.",
    actionLabel: "Clear filters",
  },
};

function dispatchRowMenuAction(row: InboxThreadRow, event: string): void {
  if (event === "settle" || event === "unsettle") {
    if (!row.mutationEnabled || !row.canSettle) return;
    void (async () => {
      try {
        const command =
          event === "settle"
            ? {
                type: "thread.settle" as const,
                threadId: row.threadId,
                commandId: newCommandId(),
              }
            : {
                type: "thread.unsettle" as const,
                threadId: row.threadId,
                commandId: newCommandId(),
                reason: "user" as const,
              };
        await sidebarUndo.dispatch(
          { environmentId: row.environmentId, threadId: row.threadId },
          command,
        );
      } catch (error) {
        Alert.alert(
          "Could not update task",
          error instanceof Error ? error.message : "The request failed.",
        );
      }
    })();
    return;
  }
  // The snooze instant is resolved at press time, not from the rendered list.
  const until =
    event === "unsnooze"
      ? null
      : resolveSnoozePresets(new Date()).find((preset) => preset.id === event)?.snoozedUntil;
  if (until === undefined || !(until ? row.canSnooze : row.canUnsnooze)) return;
  void (async () => {
    try {
      await sidebarUndo.dispatch(
        { environmentId: row.environmentId, threadId: row.threadId },
        until
          ? {
              type: "thread.snooze",
              threadId: row.threadId,
              commandId: newCommandId(),
              snoozedUntil: until,
            }
          : { type: "thread.unsnooze", threadId: row.threadId, commandId: newCommandId() },
      );
    } catch (error) {
      Alert.alert(
        "Could not update snooze",
        error instanceof Error ? error.message : "The request failed.",
      );
    }
  })();
}

/**
 * One inbox row with its long-press menu. Memoized on the row object, which
 * `stabilizeInboxSections` keeps identical while its content is unchanged, so
 * a live event re-renders only the rows it actually touched.
 */
export const InboxThreadMenuRow = memo(function InboxThreadMenuRow(props: {
  readonly row: InboxThreadRow;
  readonly snoozeMenuPresets: ReadonlyArray<InboxSnoozeMenuPreset>;
  readonly onOpenThread: (row: InboxThreadRow) => void;
}) {
  const { row, snoozeMenuPresets, onOpenThread } = props;
  const actions = useMemo(
    () => buildInboxRowMenuActions(row, snoozeMenuPresets),
    [row, snoozeMenuPresets],
  );
  const onPressAction = useCallback(
    ({ nativeEvent }: NativeActionEvent) => dispatchRowMenuAction(row, nativeEvent.event),
    [row],
  );
  const onPress = useCallback(() => onOpenThread(row), [onOpenThread, row]);
  return (
    <MenuView shouldOpenOnLongPress actions={actions} onPressAction={onPressAction}>
      <ThreadRow row={row} onPress={onPress} />
    </MenuView>
  );
});

function inboxListItemKey(item: InboxListItem): string {
  return item.key;
}

/**
 * The Inbox list. Memoized, with a stable `renderItem`: Home re-renders for
 * reasons that do not concern this list (its other mode, the toolbar), and
 * scroll position is reported to a ref rather than to React state.
 */
export const InboxScreen = memo(function InboxScreen(props: {
  readonly filterKey?: string;
  readonly sections: ReadonlyArray<InboxSection>;
  readonly emptyState: InboxEmptyState;
  /** Home's coarse clock; snooze presets are resolved against it. */
  readonly nowMs: number;
  readonly initialScrollOffset?: number;
  readonly onOpenThread: (row: InboxThreadRow) => void;
  readonly onEmptyAction: (state: Exclude<InboxEmptyState, null>) => void;
  readonly onScrollOffset?: (offset: number) => void;
}) {
  const { nowMs, onOpenThread, onScrollOffset } = props;
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledVisibleCount, setSettledVisibleCount] = useState(MOBILE_SETTLED_PAGE_SIZE);
  const data = useMemo(
    () =>
      flattenInboxSections({
        sections: props.sections,
        settledOpen,
        snoozedOpen,
        settledVisibleCount,
      }),
    [props.sections, settledOpen, settledVisibleCount, snoozedOpen],
  );
  const empty = props.emptyState ? EMPTY_COPY[props.emptyState] : null;
  // Resolved per clock tick rather than per row and render, and kept by value
  // so rows keep their menus until a preset actually appears or lapses.
  const snoozePresetsKey = useMemo(
    () => snoozeMenuPresetsKey(resolveSnoozeMenuPresets(new Date(nowMs))),
    [nowMs],
  );
  const snoozeMenuPresets = useMemo(
    () => snoozeMenuPresetsFromKey(snoozePresetsKey),
    [snoozePresetsKey],
  );

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<InboxListItem>) => {
      if (item.kind === "section") {
        if (item.sectionKey === "settled" || item.sectionKey === "snoozed") {
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.title}, ${item.count} tasks`}
              accessibilityState={{ expanded: item.expanded }}
              className="min-h-11 flex-row items-center gap-2 px-5 pt-4 pb-2 active:opacity-70"
              onPress={() =>
                item.sectionKey === "snoozed"
                  ? setSnoozedOpen((open) => !open)
                  : setSettledOpen((open) => !open)
              }
            >
              <SymbolView
                name={item.expanded ? "chevron.down" : "chevron.right"}
                size={13}
                type="monochrome"
              />
              <Text className="text-sm font-ryco-medium text-foreground-muted">{item.title}</Text>
              <Text className="ml-auto rounded-full bg-subtle px-2 py-0.5 font-mono text-2xs text-foreground-tertiary">
                {item.count}
              </Text>
            </Pressable>
          );
        }
        return (
          <Text className="px-5 pt-5 pb-2 text-sm font-ryco-medium text-foreground-muted">
            {item.title} · {item.count}
          </Text>
        );
      }
      if (item.kind === "show-more") {
        return (
          <Pressable
            accessibilityRole="button"
            className="mx-4 mb-2 min-h-11 items-center justify-center rounded-2xl bg-subtle active:bg-subtle-strong"
            onPress={() => setSettledVisibleCount((count) => count + MOBILE_SETTLED_PAGE_SIZE)}
          >
            <Text className="text-sm font-ryco-medium text-foreground-muted">
              Show {Math.min(MOBILE_SETTLED_PAGE_SIZE, item.remaining)} more
            </Text>
          </Pressable>
        );
      }
      return (
        <InboxThreadMenuRow
          row={item.row}
          snoozeMenuPresets={snoozeMenuPresets}
          onOpenThread={onOpenThread}
        />
      );
    },
    [onOpenThread, snoozeMenuPresets],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) =>
      onScrollOffset?.(event.nativeEvent.contentOffset.y),
    [onScrollOffset],
  );

  return (
    <LegendList
      key={props.filterKey}
      data={data}
      renderItem={renderItem}
      keyExtractor={inboxListItemKey}
      recycleItems
      maintainVisibleContentPosition
      initialScrollOffset={props.initialScrollOffset}
      onScroll={onScroll}
      scrollEventThrottle={32}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingBottom: HOME_LIST_PADDING_BOTTOM }}
      ListHeaderComponent={<WorkspaceConnectionStatus />}
      ListEmptyComponent={
        empty ? (
          <View className="px-2 py-12">
            <EmptyState
              variant="plain"
              title={empty.title}
              detail={empty.detail}
              actionLabel={empty.actionLabel}
              onAction={() => props.onEmptyAction(props.emptyState!)}
            />
          </View>
        ) : null
      }
    />
  );
});
