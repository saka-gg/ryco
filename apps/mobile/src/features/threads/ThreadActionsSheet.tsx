import type { EnvironmentId } from "@ryco/contracts";
import { DeviceIcon } from "../../components/DeviceIcon";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ThreadHeaderModel } from "./threadHeaderModel";

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

export function ThreadActionsSheet(props: {
  readonly visible: boolean;
  readonly model: ThreadHeaderModel;
  readonly environmentId: EnvironmentId;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onRename: (title: string) => void;
  readonly onStop: () => void;
  readonly onToggleSettlement: () => void;
  readonly onToggleArchive: () => void;
  readonly onReview: () => void;
}) {
  const [title, setTitle] = useState(props.model.title);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");

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
              Project · Worktree
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
      </ScrollView>
    </Modal>
  );
}
