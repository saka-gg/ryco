import type { PullRequestWatchTone } from "@ryco/client-runtime/state/threads";
import { Pressable, Switch, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ThreadPullRequestWatchChip } from "./threadHeaderModel";
import type { PullRequestWatchControl } from "./usePullRequestWatchControl";

// The node's watch of a thread's pull request, as the thread's context sheet shows it: the
// compact chip beside the pull request's badge, and the Auto-fix CI section under it.

const WATCH_CHIP_CLASS: Readonly<Record<ThreadPullRequestWatchChip["tone"], string>> = {
  muted: "border-border",
  active: "border-accent-border bg-accent-bg",
  warning: "border-warning-border bg-warning-bg",
};

const WATCH_TEXT_CLASS: Readonly<Record<ThreadPullRequestWatchChip["tone"], string>> = {
  muted: "text-foreground-tertiary",
  active: "text-accent-strong",
  warning: "text-warning",
};

const WATCH_DOT_CLASS: Readonly<Record<ThreadPullRequestWatchChip["tone"], string>> = {
  muted: "bg-foreground-tertiary",
  active: "bg-accent",
  warning: "bg-warning",
};

/**
 * The node's watch of the pull request beside its badge: live state from the
 * thread's shell (unlike the badge's last known one), so it may look live.
 */
export function PullRequestWatchChip(props: { readonly chip: ThreadPullRequestWatchChip }) {
  const { chip } = props;
  return (
    <View
      accessible
      accessibilityLabel={chip.accessibilityLabel}
      className={cn(
        "shrink-0 flex-row items-center gap-1 rounded-full border px-2 py-0.5",
        WATCH_CHIP_CLASS[chip.tone],
      )}
    >
      <View className={cn("h-1.5 w-1.5 rounded-full", WATCH_DOT_CLASS[chip.tone])} />
      <Text
        className={cn("text-2xs font-ryco-medium", WATCH_TEXT_CLASS[chip.tone])}
        numberOfLines={1}
      >
        {chip.label}
      </Text>
    </View>
  );
}

function ActionRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly detail?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor(
    props.destructive ? "--color-danger-foreground" : "--color-icon-muted",
  );
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-14 flex-row items-center gap-3 border-t border-border px-4 py-3 active:bg-subtle disabled:opacity-40"
    >
      <View className="h-9 w-9 items-center justify-center rounded-xl bg-subtle">
        <SymbolView name={props.icon} size={17} tintColor={iconColor as string} type="monochrome" />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          className={`text-base font-ryco-medium ${
            props.destructive ? "text-danger-foreground" : "text-foreground"
          }`}
        >
          {props.label}
        </Text>
        {props.detail ? (
          <Text className="mt-0.5 text-xs text-foreground-muted">{props.detail}</Text>
        ) : null}
      </View>
      <SymbolView
        name="chevron.right"
        size={13}
        tintColor={iconColor as string}
        type="monochrome"
      />
    </Pressable>
  );
}

const WATCH_TONE_CLASS: Readonly<Record<PullRequestWatchTone, string>> = {
  muted: "text-foreground-muted",
  active: "text-accent-strong",
  warning: "text-warning",
};

/**
 * The node's watch of the thread's pull request: the Auto-fix CI switch, what
 * the watch is doing, Resume while Auto-fix CI is paused and Stop watching while
 * one is on, or why the last one ended. Nothing for a merged or closed pull
 * request that had no watch.
 */
export function PullRequestWatchSection(props: { readonly control: PullRequestWatchControl }) {
  const { control } = props;
  const { view } = control;
  if (view === null && !control.switchOffered && control.endedLabel === null) return null;
  const disabled = !control.ready || control.pending;
  const status = view
    ? { text: view.label, tone: view.tone }
    : control.endedLabel
      ? { text: control.endedLabel, tone: "muted" as const }
      : {
          text: "Starts a fix turn in this task when checks fail. Never merges.",
          tone: "muted" as const,
        };
  return (
    <View className="gap-2">
      <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
        Pull request #{control.number}
      </Text>
      <View className="overflow-hidden rounded-2xl bg-card">
        <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
          <View className="min-w-0 flex-1">
            {control.switchOffered ? (
              <Text className="text-base font-ryco-medium text-foreground">Auto-fix CI</Text>
            ) : null}
            <Text className={`mt-0.5 text-xs ${WATCH_TONE_CLASS[status.tone]}`}>{status.text}</Text>
            {view?.detail ? (
              <Text className="mt-0.5 text-xs text-foreground-muted">{view.detail}</Text>
            ) : null}
            {control.autoFixElsewhere ? (
              <Text className="mt-0.5 text-xs text-foreground-muted">
                Auto-fix CI runs in the task whose workspace has this pull request.
              </Text>
            ) : null}
            {/* Offline, read-only access or a cached view: not only a lost connection. */}
            {(control.switchOffered || view !== null) && !control.ready ? (
              <Text className="mt-0.5 text-xs text-foreground-muted">
                This node can't take changes right now.
              </Text>
            ) : null}
          </View>
          {control.switchOffered ? (
            <Switch
              accessibilityLabel="Auto-fix CI"
              value={control.autoFixChecked}
              disabled={disabled}
              onValueChange={(on) => control.run(on ? "auto-fix-on" : "auto-fix-off")}
            />
          ) : null}
        </View>
        {view?.paused ? (
          <ActionRow
            icon="arrow.clockwise"
            label="Resume Auto-fix CI"
            detail="Starts over with a fresh set of fix attempts."
            disabled={disabled}
            onPress={() => control.run("resume")}
          />
        ) : null}
        {view ? (
          <ActionRow
            icon="xmark"
            label="Stop watching"
            detail="The agent is no longer woken for this pull request."
            disabled={disabled}
            onPress={() => control.run("stop")}
          />
        ) : null}
      </View>
      {control.error ? (
        <Text className="px-1 text-xs text-danger-foreground">{control.error}</Text>
      ) : null}
    </View>
  );
}
