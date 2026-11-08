import type { SFSymbol } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  TASK_CHAT_WORDS,
  type TaskChatWord,
  type TaskChipKind,
  type TaskDueTone,
  type TaskRowModel,
} from "./tasksListModel";

/** The check pops a little past full size and settles, like the system's own checkmarks. */
const CHECK_SPRING = {
  damping: 14,
  stiffness: 420,
  mass: 0.6,
  reduceMotion: ReduceMotion.System,
} as const;

/** The round checkbox: an outline when open, filled with a check when done. */
export function TaskCheckbox(props: {
  readonly checked: boolean;
  readonly title: string;
  readonly onToggle: () => void;
  readonly size?: number;
}) {
  const size = props.size ?? 22;
  const success = useThemeColor("--color-success") as string;
  const outline = useThemeColor("--color-foreground-tertiary") as string;
  const fill = useSharedValue(props.checked ? 1 : 0);
  const scale = useSharedValue(1);
  useEffect(() => {
    fill.set(withTiming(props.checked ? 1 : 0, { duration: 160 }));
  }, [fill, props.checked]);
  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    backgroundColor: fill.value > 0.5 ? success : "transparent",
    borderColor: fill.value > 0.5 ? success : outline,
  }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: fill.value,
    transform: [{ scale: 0.6 + fill.value * 0.4 }],
  }));
  const toggle = () => {
    scale.set(withSequence(withTiming(0.82, { duration: 90 }), withSpring(1, CHECK_SPRING)));
    if (props.checked) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    props.onToggle();
  };
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.checked }}
      accessibilityLabel={props.checked ? `Reopen ${props.title}` : `Complete ${props.title}`}
      hitSlop={10}
      onPress={toggle}
    >
      <Animated.View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.75,
            alignItems: "center",
            justifyContent: "center",
          },
          ringStyle,
        ]}
      >
        <Animated.View style={checkStyle}>
          <SymbolView name="checkmark" size={size * 0.5} weight="bold" tintColor="#ffffff" />
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const CHIP_SYMBOLS: Readonly<Record<TaskChipKind, SFSymbol>> = {
  pr: "arrow.triangle.pull",
  issue: "smallcircle.filled.circle",
  workItem: "ticket",
  branch: "arrow.triangle.branch",
  url: "link",
  chats: "bubble.left.and.bubble.right",
  files: "paperclip",
};

export function TaskChip(props: { readonly kind: TaskChipKind; readonly label: string }) {
  const icon = useThemeColor("--color-icon-subtle") as string;
  return (
    <View className="h-[22px] max-w-[180px] flex-row items-center gap-1 rounded-md bg-subtle px-1.5">
      <SymbolView name={CHIP_SYMBOLS[props.kind]} size={10} tintColor={icon} />
      <Text className="shrink text-[11px] text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

const DUE_TONE_CLASS: Readonly<Record<TaskDueTone, string>> = {
  overdue: "text-danger-foreground",
  soon: "text-warning",
  later: "text-foreground-muted",
};

const CHAT_WORD_CLASS: Readonly<Record<TaskChatWord, { bg: string; fg: string }>> = {
  "needs-you": { bg: "bg-warning-bg", fg: "text-warning" },
  starting: { bg: "bg-accent-bg", fg: "text-accent" },
  running: { bg: "bg-accent-bg", fg: "text-accent" },
  failed: { bg: "bg-danger", fg: "text-danger-foreground" },
  review: { bg: "bg-success-bg", fg: "text-success" },
};

/** The marks beside an urgent or high-priority title: two or one exclamation marks. */
export function PriorityMark(props: { readonly mark: "urgent" | "high" }) {
  return (
    <Text
      accessibilityLabel={props.mark === "urgent" ? "Urgent" : "High priority"}
      className={cn(
        "font-ryco-bold text-[15px] leading-[20px]",
        props.mark === "urgent" ? "text-danger-foreground" : "text-warning",
      )}
    >
      {props.mark === "urgent" ? "!!" : "!"}
    </Text>
  );
}

/** The row's meta line: the project, then the due day in its tone. */
function MetaLine(props: { readonly row: TaskRowModel }) {
  const { row } = props;
  if (row.projectName === null && row.dueLabel === null) return null;
  const due =
    row.dueLabel === null || row.done
      ? null
      : row.dueLabel === "Overdue"
        ? "Overdue"
        : row.dueLabel === "Today" || row.dueLabel === "Tomorrow"
          ? `Due ${row.dueLabel.toLowerCase()}`
          : `Due ${row.dueLabel}`;
  return (
    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
      {row.projectName}
      {row.projectName !== null && due !== null ? " · " : null}
      {due !== null && row.dueTone !== null ? (
        <Text className={DUE_TONE_CLASS[row.dueTone]}>{due}</Text>
      ) : null}
    </Text>
  );
}

export interface TaskRowProps {
  readonly row: TaskRowModel;
  /** Shown checked while the row waits to move to Done (or back). */
  readonly checked: boolean;
  readonly onToggle: (row: TaskRowModel) => void;
  readonly onOpen: (row: TaskRowModel) => void;
  readonly onChat: (row: TaskRowModel) => void;
  readonly first: boolean;
}

/** One task: checkbox, title with its priority, meta line, link chips and its chat button. */
export function TaskRow(props: TaskRowProps) {
  const { row } = props;
  const chatWord = row.chatWord;
  const label = [
    row.title,
    row.priorityMark === "urgent" ? "urgent" : row.priorityMark === "high" ? "high priority" : null,
    row.meta,
    chatWord ? TASK_CHAT_WORDS[chatWord] : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View className="flex-row items-start gap-3 bg-card pl-4">
      <View className="pt-[13px]">
        <TaskCheckbox
          checked={props.checked}
          title={row.title}
          onToggle={() => props.onToggle(row)}
        />
      </View>
      <View
        className={cn(
          "min-w-0 flex-1 flex-row items-center gap-2 py-3 pr-3",
          !props.first && "border-t border-border-subtle",
        )}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Opens the task"
          onPress={() => props.onOpen(row)}
          className="min-w-0 flex-1 gap-1 active:opacity-60"
        >
          <Text
            className={cn(
              "font-ryco-medium text-[15px] leading-[20px]",
              props.checked ? "text-foreground-tertiary line-through" : "text-foreground",
            )}
            numberOfLines={2}
          >
            {row.title}
            {row.priorityMark !== null && !props.checked ? (
              <>
                {"  "}
                <PriorityMark mark={row.priorityMark} />
              </>
            ) : null}
          </Text>
          {props.checked ? null : <MetaLine row={row} />}
          {row.chips.length > 0 && !props.checked ? (
            <View className="mt-0.5 flex-row flex-wrap gap-1">
              {row.chips.slice(0, 4).map((chip) => (
                <TaskChip key={chip.key} kind={chip.kind} label={chip.label} />
              ))}
              {row.chips.length > 4 ? (
                <Text className="self-center text-[11px] text-foreground-tertiary">
                  +{row.chips.length - 4}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Pressable>
        {chatWord !== null && !props.checked ? (
          <View className={cn("rounded-full px-2 py-0.5", CHAT_WORD_CLASS[chatWord].bg)}>
            <Text className={cn("text-[11px] font-ryco-bold", CHAT_WORD_CLASS[chatWord].fg)}>
              {TASK_CHAT_WORDS[chatWord]}
            </Text>
          </View>
        ) : null}
        {row.chatAction !== null && !props.checked ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              row.chatAction.kind === "open"
                ? `Open the chat of ${row.title}`
                : `Start a chat for ${row.title}`
            }
            hitSlop={6}
            onPress={() => props.onChat(row)}
            className="h-8 items-center justify-center rounded-full bg-subtle px-3 active:bg-subtle-strong"
          >
            <Text className="text-[13px] font-ryco-bold text-foreground">
              {row.chatAction.kind === "open" ? "Chat" : "Start"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
