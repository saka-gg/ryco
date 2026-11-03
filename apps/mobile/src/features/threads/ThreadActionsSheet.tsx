import type { PullRequestWatchTone } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { DeviceIcon } from "../../components/DeviceIcon";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Switch, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ThreadHeaderModel } from "./threadHeaderModel";
import {
  usePullRequestWatchControl,
  type PullRequestWatchControl,
} from "./usePullRequestWatchControl";

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

export function ThreadActionsSheet(props: {
  readonly visible: boolean;
  readonly model: ThreadHeaderModel;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The node takes changes now: the pull request watch controls send only then. */
  readonly mutationReady: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onRename: (title: string) => void;
  readonly onStop: () => void;
  readonly onCompact: () => void;
  readonly onToggleSettlement: () => void;
  readonly onToggleArchive: () => void;
  readonly onReview: () => void;
  /** Opens the worktree's pull request; absent where the thread has no project to read it through. */
  readonly onOpenPullRequest?: (() => void) | undefined;
}) {
  const [title, setTitle] = useState(props.model.title);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  // Here, outside the Modal, so a change in flight outlives closing the sheet.
  const pullRequestWatch = usePullRequestWatchControl({
    environmentId: props.environmentId,
    threadId: props.threadId,
    watch: props.model.pullRequestWatch,
    ready: props.mutationReady,
  });

  useEffect(() => {
    if (props.visible) setTitle(props.model.title);
  }, [props.model.title, props.visible]);

  const archiveAction = props.model.moreActions.includes("archive") ? "archive" : "unarchive";
  const turnRunning = props.model.moreActions.includes("stop");
  const canRename = title.trim().length > 0 && title.trim() !== props.model.title && !props.busy;

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-screen"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: 40,
          gap: 18,
        }}
      >
        <View className="flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close task details"
            onPress={props.onClose}
            className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle"
          >
            <Text className="text-base font-ryco-medium text-foreground">Done</Text>
          </Pressable>
          <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
            Task details
          </Text>
          <View className="h-11 min-w-11" />
        </View>

        {props.error ? <ErrorBanner message={props.error} /> : null}

        <View className="overflow-hidden rounded-2xl bg-card">
          <View className="gap-1 px-4 py-4">
            <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
              Node
            </Text>
            <View className="flex-row items-center gap-2">
              <DeviceIcon environmentId={props.environmentId} label={props.model.nodeLabel} />
              <Text className="text-base font-ryco-medium text-foreground">
                {props.model.nodeLabel}
              </Text>
            </View>
          </View>
          <View className="border-t border-border px-4 py-4">
            <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
              {props.model.contextHeading}
            </Text>
            <Text className="mt-1 text-base font-ryco-medium text-foreground">
              {props.model.projectLabel} · {props.model.worktreeLabel}
            </Text>
          </View>
        </View>

        <View className="gap-2">
          <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Task title</Text>
          <View className="flex-row items-center gap-2">
            <TextInput
              value={title}
              onChangeText={setTitle}
              editable={!props.busy}
              placeholder="Task title"
              placeholderTextColor={placeholderColor as string}
              returnKeyType="done"
              className="min-h-12 flex-1 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
              style={{ color: textColor as string }}
              onSubmitEditing={() => {
                if (canRename) props.onRename(title);
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save task title"
              disabled={!canRename}
              onPress={() => props.onRename(title)}
              className="h-12 items-center justify-center rounded-full bg-primary px-4 active:opacity-80 disabled:opacity-40"
            >
              <Text className="text-sm font-ryco-bold text-primary-foreground">Save</Text>
            </Pressable>
          </View>
        </View>

        <View className="overflow-hidden rounded-2xl bg-card">
          {props.model.pullRequestNumber !== null && props.onOpenPullRequest ? (
            <ActionRow
              icon="arrow.triangle.pull"
              label={`Open pull request #${props.model.pullRequestNumber}`}
              detail="Read its conversation, checks and files."
              onPress={props.onOpenPullRequest}
            />
          ) : null}
          <ActionRow
            icon="doc.on.doc"
            label={
              props.model.copyReference.kind === "pull-request"
                ? "Copy link to pull request"
                : "Copy task ID"
            }
            detail={
              props.model.copyReference.kind === "pull-request"
                ? "The pull request this task works on."
                : "Find this task again, or hand it to an agent."
            }
            onPress={() =>
              copyTextWithHaptic(props.model.copyReference.value, {
                target:
                  props.model.copyReference.kind === "pull-request"
                    ? "pull request link"
                    : "task ID",
              })
            }
          />
          {props.model.copyReference.kind === "pull-request" ? (
            <ActionRow
              icon="doc.on.doc"
              label="Copy task ID"
              detail="Find this task again, or hand it to an agent."
              onPress={() => copyTextWithHaptic(props.model.taskId, { target: "task ID" })}
            />
          ) : null}
          {props.model.reviewVisible ? (
            <ActionRow
              icon="doc.text"
              label="Review changes"
              detail="Inspect the files changed by this task."
              disabled={props.busy}
              onPress={props.onReview}
            />
          ) : null}
          {props.model.moreActions.includes("stop") ? (
            <ActionRow
              icon="stop.fill"
              label="Stop current turn"
              detail="Keep the task and stop the agent's current work."
              destructive
              disabled={props.busy}
              onPress={props.onStop}
            />
          ) : null}
          {props.model.compactAction ? (
            <ActionRow
              icon="arrow.down.right.and.arrow.up.left"
              label={props.model.compactAction.label}
              detail={props.model.compactAction.detail}
              disabled={props.busy || props.model.compactAction.disabled}
              onPress={props.onCompact}
            />
          ) : null}
          {props.model.settlementAction ? (
            <ActionRow
              icon={
                props.model.settlementAction.kind === "settle"
                  ? "checkmark.circle"
                  : "arrow.uturn.backward"
              }
              label={props.model.settlementAction.label}
              detail={props.model.settlementAction.detail}
              disabled={props.busy || props.model.settlementAction.disabled}
              onPress={props.onToggleSettlement}
            />
          ) : null}
          <ActionRow
            icon={archiveAction === "archive" ? "archivebox" : "arrow.uturn.backward"}
            label={archiveAction === "archive" ? "Archive task" : "Restore task"}
            detail={
              turnRunning
                ? "Stop the current turn before archiving."
                : archiveAction === "archive"
                  ? "Move this task out of active workspace lists."
                  : "Restore this archived task to workspace lists."
            }
            destructive={archiveAction === "archive"}
            disabled={props.busy || turnRunning}
            onPress={props.onToggleArchive}
          />
        </View>

        {pullRequestWatch ? <PullRequestWatchSection control={pullRequestWatch} /> : null}
      </ScrollView>
    </Modal>
  );
}
