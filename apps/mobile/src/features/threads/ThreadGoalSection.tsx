import {
  formatThreadGoalElapsed,
  THREAD_GOAL_REMINDER_NOTE,
  threadGoalCanResume,
  threadGoalElapsedSeconds,
  threadGoalHeading,
  threadGoalUsageLabel,
} from "@ryco/client-runtime/state/threads";
import type { ThreadGoal } from "@ryco/contracts";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { secondClock } from "../../lib/secondClock";
import { useThemeColor } from "../../lib/useThemeColor";

const subscribeToNothing = () => () => {};
const readNoClock = () => 0;

export interface ThreadGoalActions {
  /** Puts `/goal <objective>` in the composer to change it. */
  readonly edit: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly clear: () => void;
  /** Sends the goal's last change again (pending too long, or failed). */
  readonly retry: () => void;
}

function GoalButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled: boolean;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      className="h-8 flex-row items-center gap-1.5 rounded-full bg-subtle px-3 active:opacity-70 disabled:opacity-40"
    >
      <SymbolView name={props.icon} size={12} tintColor={iconColor} type="monochrome" />
      <Text className="text-xs font-ryco-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/**
 * The chat's goal in its context sheet: what the agent keeps pursuing, how long and how many
 * tokens it took, and Pause / Resume / Clear. Set it with `/goal` in the composer.
 */
export function ThreadGoalSection(props: {
  readonly goal: ThreadGoal;
  /** When this client saw the running turn start, or null while the thread is idle. */
  readonly runningSince: string | null;
  readonly busy: boolean;
  readonly actions: ThreadGoalActions;
}) {
  const { goal } = props;
  const [expanded, setExpanded] = useState(false);
  const iconColor = useThemeColor("--color-icon-subtle");
  const running = props.runningSince !== null;
  const ticking = running && goal.status === "active";
  const nowMs = useSyncExternalStore(
    ticking ? secondClock.subscribe : subscribeToNothing,
    ticking ? secondClock.read : readNoClock,
  );
  const runningSinceMs = props.runningSince === null ? 0 : Date.parse(props.runningSince);
  const elapsed = formatThreadGoalElapsed(
    threadGoalElapsedSeconds(goal, nowMs, runningSinceMs, ticking),
  );
  const usage = threadGoalUsageLabel(goal);
  const synchronization = goal.synchronization;
  const pending = synchronization?.state === "pending";
  const complete = goal.status === "complete";
  const disabled = props.busy || pending;

  return (
    <View className="gap-2.5 rounded-2xl bg-card px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${threadGoalHeading(goal)}: ${goal.objective}`}
        onPress={() => setExpanded((value) => !value)}
        className="gap-1 active:opacity-70"
      >
        <View className="flex-row items-center gap-1.5">
          <SymbolView
            name={complete ? "checkmark.circle" : "scope"}
            size={12}
            tintColor={iconColor}
            type="monochrome"
          />
          <Text className="text-xs font-ryco-medium text-foreground-muted">
            {threadGoalHeading(goal)}
          </Text>
          <Text
            className="text-xs text-foreground-tertiary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {usage ? `${elapsed} · ${usage}` : elapsed}
          </Text>
        </View>
        <Text
          className="text-sm text-foreground"
          numberOfLines={expanded ? undefined : 3}
          selectable={expanded}
        >
          {goal.objective}
        </Text>
      </Pressable>
      {pending ? (
        <Text className="text-xs text-foreground-muted">Waiting for the provider to confirm.</Text>
      ) : null}
      {synchronization?.state === "failed" ? (
        <Text className="text-xs text-danger-foreground">
          {synchronization.error ?? "The goal change did not go through."}
        </Text>
      ) : null}
      {synchronization?.state === "unsupported" ? (
        <Text className="text-xs text-foreground-muted">{THREAD_GOAL_REMINDER_NOTE}</Text>
      ) : null}
      <View className={cn("flex-row flex-wrap gap-2")}>
        {goal.status === "active" ? (
          <GoalButton
            icon="pause"
            label="Pause"
            onPress={props.actions.pause}
            disabled={disabled}
          />
        ) : threadGoalCanResume(goal.status) ? (
          <GoalButton
            icon="play"
            label="Resume"
            onPress={props.actions.resume}
            disabled={disabled}
          />
        ) : null}
        {pending || synchronization?.state === "failed" ? (
          <GoalButton
            icon="arrow.clockwise"
            label="Retry"
            onPress={props.actions.retry}
            disabled={props.busy}
          />
        ) : null}
        <GoalButton icon="pencil" label="Edit" onPress={props.actions.edit} disabled={disabled} />
        <GoalButton icon="trash" label="Clear" onPress={props.actions.clear} disabled={disabled} />
      </View>
    </View>
  );
}
