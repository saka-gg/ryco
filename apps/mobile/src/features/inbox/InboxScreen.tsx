import { MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  useWindowDimensions,
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
  inboxThreadAtPosition,
  MOBILE_SETTLED_PAGE_SIZE,
  type InboxListItem,
} from "./inboxListModel";
import { InboxThreadRow as ThreadRow } from "./InboxThreadRow";
import {
  buildInboxRowMenuActions,
  buildInboxSnoozeMenuActions,
  resolveSnoozeMenuPresets,
  snoozeMenuPresetsFromKey,
  snoozeMenuPresetsKey,
  type InboxSnoozeMenuPreset,
} from "./inboxRowActions";
import { HOME_LIST_PADDING_BOTTOM } from "../home/homeChromeModel";
import {
  THREAD_JUMP_COMMANDS,
  threadJumpIndex,
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceConnectionStatus } from "../home/WorkspaceConnectionStatus";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  SwipeableScrollGateProvider,
  ThreadSwipeable,
  useSwipeableScrollGate,
  type ThreadSwipeAction,
} from "../threadList/ThreadSwipeable";
import { archiveInboxRow, runInboxRowAction, setInboxRowPinned } from "./inboxRowCommands";

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

/**
 * One inbox row with its long-press menu and swipe actions: swipe left to
 * archive (a full swipe archives at once) or snooze, right to pin or unpin.
 * Memoized on the row object, which `stabilizeInboxSections` keeps identical
 * while its content is unchanged, so a live event re-renders only the rows it
 * actually touched.
 */
export const InboxThreadMenuRow = memo(function InboxThreadMenuRow(props: {
  readonly row: InboxThreadRow;
  readonly snoozeMenuPresets: ReadonlyArray<InboxSnoozeMenuPreset>;
  readonly onOpenThread: (row: InboxThreadRow) => void;
}) {
  const { row, snoozeMenuPresets, onOpenThread } = props;
  const { width } = useWindowDimensions();
  const background = useThemeColor("--color-screen");
  const actions = useMemo(
    () => buildInboxRowMenuActions(row, snoozeMenuPresets),
    [row, snoozeMenuPresets],
  );
  const onPressAction = useCallback(
    ({ nativeEvent }: NativeActionEvent) => runInboxRowAction(row, nativeEvent.event),
    [row],
  );
  const onPress = useCallback(() => onOpenThread(row), [onOpenThread, row]);
  const swipe = useMemo(
    () => buildInboxSwipeActions(row, snoozeMenuPresets),
    [row, snoozeMenuPresets],
  );
  return (
    <ThreadSwipeable
      backgroundColor={background}
      containerStyle={INBOX_ROW_CONTAINER_STYLE}
      fullSwipeWidth={width - 32}
      threadKey={row.key}
      resetKey={`${row.key}:${row.attentionState}:${row.snoozedUntil ?? ""}:${row.pinned}`}
      leadingAction={swipe.leading}
      primaryAction={swipe.primary}
      secondaryAction={swipe.secondary}
    >
      <MenuView shouldOpenOnLongPress actions={actions} onPressAction={onPressAction}>
        <ThreadRow row={row} onPress={onPress} />
      </MenuView>
    </ThreadSwipeable>
  );
});

const INBOX_ROW_CONTAINER_STYLE = { marginHorizontal: 16, marginBottom: 8, borderRadius: 16 };

/** What a row's swipes offer: Pin or Unpin, Archive, and Snooze's presets. */
export function buildInboxSwipeActions(
  row: InboxThreadRow,
  presets: ReadonlyArray<InboxSnoozeMenuPreset>,
): {
  readonly leading: ThreadSwipeAction;
  readonly primary: ThreadSwipeAction | null;
  readonly secondary: ThreadSwipeAction | null;
} {
  return {
    leading: row.pinned
      ? {
          accessibilityLabel: `Unpin ${row.title}`,
          icon: "pin.slash",
          label: "Unpin",
          tone: "accent",
          onPress: () => setInboxRowPinned(row, false),
        }
      : {
          accessibilityLabel: `Pin ${row.title}`,
          icon: "pin",
          label: "Pin",
          tone: "accent",
          onPress: () => setInboxRowPinned(row, true),
        },
    primary: row.canArchive
      ? {
          accessibilityLabel: `Archive ${row.title}`,
          icon: "archivebox",
          label: "Archive",
          tone: "primary",
          onPress: () => archiveInboxRow(row),
        }
      : null,
    // A snoozed row wakes from its long-press menu; the swipe only snoozes.
    secondary:
      row.canSnooze === true && !row.snoozedUntil
        ? {
            accessibilityLabel: `Choose when to snooze ${row.title}`,
            icon: "clock",
            label: "Snooze",
            tone: "secondary",
            menu: {
              actions: buildInboxSnoozeMenuActions(row, presets),
              onPressAction: (event) => runInboxRowAction(row, event),
              title: "Snooze until",
            },
            onPress: () => undefined,
          }
        : null,
  };
}

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
  /** Archived tasks on the machines in view; the list ends with a link to them. */
  readonly archivedCount?: number;
  readonly onOpenArchived?: () => void;
}) {
  const { nowMs, onOpenThread, onScrollOffset } = props;
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [settledVisibleCount, setSettledVisibleCount] = useState(MOBILE_SETTLED_PAGE_SIZE);
  const data = useMemo(
    () =>
      flattenInboxSections({
        sections: props.sections,
        settledOpen,
        snoozedOpen,
        hiddenOpen,
        settledVisibleCount,
      }),
    [props.sections, settledOpen, settledVisibleCount, snoozedOpen, hiddenOpen],
  );
  // Command-1…9 open the first nine thread rows as this list shows them now.
  const jumpToThread = useCallback(
    (command: HardwareKeyboardCommand) => {
      const row = inboxThreadAtPosition(data, threadJumpIndex(command));
      if (row) onOpenThread(row);
    },
    [data, onOpenThread],
  );
  useHardwareKeyboardCommand(THREAD_JUMP_COMMANDS, jumpToThread);
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

  const mutedColor = useThemeColor("--color-icon-muted");
  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<InboxListItem>) => {
      if (item.kind === "section") {
        if (
          item.sectionKey === "settled" ||
          item.sectionKey === "snoozed" ||
          item.sectionKey === "hidden"
        ) {
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.title}, ${item.count} tasks`}
              accessibilityState={{ expanded: item.expanded }}
              className="min-h-11 flex-row items-center gap-2 px-5 pt-4 pb-2 active:opacity-70"
              onPress={() =>
                item.sectionKey === "snoozed"
                  ? setSnoozedOpen((open) => !open)
                  : item.sectionKey === "hidden"
                    ? setHiddenOpen((open) => !open)
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
          <View className="flex-row items-center gap-1.5 px-5 pt-5 pb-2">
            {item.sectionKey === "pinned" ? (
              <SymbolView name="pin.fill" size={11} tintColor={mutedColor} type="monochrome" />
            ) : null}
            <Text className="text-sm font-ryco-medium text-foreground-muted">
              {item.title} · {item.count}
            </Text>
          </View>
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
    [mutedColor, onOpenThread, snoozeMenuPresets],
  );
  const listRef = useRef<LegendListRef>(null);
  const offsetRef = useRef(props.initialScrollOffset ?? 0);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offsetRef.current = event.nativeEvent.contentOffset.y;
      onScrollOffset?.(event.nativeEvent.contentOffset.y);
    },
    [onScrollOffset],
  );
  // A newly pinned thread lands above the rows in view; from the top of the list, show it.
  const pinnedCount = props.sections.find((section) => section.key === "pinned")?.rows.length ?? 0;
  const previousPinnedCount = useRef(pinnedCount);
  useEffect(() => {
    const grew = pinnedCount > previousPinnedCount.current;
    previousPinnedCount.current = pinnedCount;
    if (grew && offsetRef.current < 160) {
      void listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [pinnedCount]);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({ onScroll });

  return (
    <SwipeableScrollGateProvider enabled={swipeEnabled}>
      <LegendList
        ref={listRef}
        key={props.filterKey}
        data={data}
        renderItem={renderItem}
        keyExtractor={inboxListItemKey}
        recycleItems
        maintainVisibleContentPosition
        initialScrollOffset={props.initialScrollOffset}
        {...scrollGateHandlers}
        scrollEventThrottle={32}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: HOME_LIST_PADDING_BOTTOM }}
        ListHeaderComponent={<WorkspaceConnectionStatus />}
        ListFooterComponent={
          props.archivedCount && props.onOpenArchived && data.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Archived, ${props.archivedCount} tasks`}
              className="min-h-11 flex-row items-center gap-2 px-5 pt-4 pb-2 active:opacity-70"
              onPress={props.onOpenArchived}
            >
              <SymbolView name="archivebox" size={13} tintColor={mutedColor} type="monochrome" />
              <Text className="text-sm font-ryco-medium text-foreground-muted">Archived</Text>
              <Text className="ml-auto rounded-full bg-subtle px-2 py-0.5 font-mono text-2xs text-foreground-tertiary">
                {props.archivedCount}
              </Text>
            </Pressable>
          ) : null
        }
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
    </SwipeableScrollGateProvider>
  );
});
