import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Switch, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  shownPullRequestActionSheet,
  type PullRequestActionSheet,
} from "./pullRequestActionsModel";
import { FilterChip } from "./PullRequestParts";
import { usePullRequestReviewDraft, type PullRequestActionsControl } from "./usePullRequestActions";

// The pull request screen's changes: review, merge and branch update. Layout
// only; what is offered and what is sent come from pullRequestActionsModel.

function PanelButton(props: {
  readonly label: string;
  readonly primary?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "h-11 flex-1 items-center justify-center rounded-full px-4 active:opacity-80 disabled:opacity-40",
        props.primary ? "bg-primary" : "border border-border bg-card",
      )}
    >
      <Text
        className={cn(
          "text-sm font-ryco-bold",
          props.primary ? "text-primary-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function SheetHeader(props: {
  readonly title: string;
  readonly actionLabel: string;
  readonly actionDisabled: boolean;
  readonly onCancel: () => void;
  readonly onAction: () => void;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        onPress={props.onCancel}
        className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle"
      >
        <Text className="text-base font-ryco-medium text-foreground">Cancel</Text>
      </Pressable>
      <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
        {props.title}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={props.actionDisabled}
        onPress={props.onAction}
        className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle disabled:opacity-40"
      >
        <Text className="text-base font-ryco-bold text-primary">{props.actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function ReviewSheet(props: {
  readonly control: PullRequestActionsControl;
  readonly onClose: () => void;
}) {
  const { control } = props;
  const review = control.review;
  // The draft is read here, not by the screen: a keystroke re-renders this sheet only.
  const draft = usePullRequestReviewDraft(control);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  if (review === null) return null;
  const busy = control.pending === "review";
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 40 }}
    >
      <SheetHeader
        title="Review"
        actionLabel={busy ? "Sending…" : "Submit"}
        actionDisabled={busy || control.blockedReason !== null}
        onCancel={props.onClose}
        onAction={() => draft.submit(props.onClose)}
      />
      {control.blockedReason ? (
        <Text className="text-sm text-foreground-muted">{control.blockedReason}</Text>
      ) : null}
      {control.error ? <ErrorBanner message={control.error} /> : null}
      <View className="flex-row flex-wrap gap-2">
        {review.options.map((option) => (
          <FilterChip
            key={option.event}
            label={option.label}
            selected={draft.event === option.event}
            onPress={() => {
              if (!option.disabled) draft.setEvent(option.event);
            }}
          />
        ))}
      </View>
      {review.authorNote ? (
        <Text className="text-xs text-foreground-muted">{review.authorNote}</Text>
      ) : null}
      <TextInput
        value={draft.summary}
        onChangeText={draft.setSummary}
        editable={!busy}
        multiline
        placeholder={draft.event === "approve" ? "Leave a comment (optional)" : "Leave a comment"}
        placeholderTextColor={placeholderColor as string}
        textAlignVertical="top"
        className="min-h-36 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
        style={{ color: textColor as string }}
      />
    </ScrollView>
  );
}

function MergeSheet(props: {
  readonly control: PullRequestActionsControl;
  readonly onClose: () => void;
}) {
  const { control } = props;
  const merge = control.merge;
  if (merge === null) return null;
  const busy = control.pending === "merge";
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 40 }}
    >
      <SheetHeader
        title="Merge"
        actionLabel={busy ? "Merging…" : "Merge"}
        actionDisabled={busy || control.blockedReason !== null}
        onCancel={props.onClose}
        onAction={() => control.runMerge(props.onClose)}
      />
      {control.blockedReason ? (
        <Text className="text-sm text-foreground-muted">{control.blockedReason}</Text>
      ) : null}
      {control.error ? <ErrorBanner message={control.error} /> : null}
      {merge.methods ? (
        <View className="overflow-hidden rounded-2xl bg-card">
          {merge.methods.map((option) => {
            const selected = option.method === merge.method;
            return (
              <Pressable
                key={option.method}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: option.disabledReason !== null }}
                disabled={option.disabledReason !== null || busy}
                onPress={() => control.setMethod(option.method)}
                className="min-h-14 flex-row items-center gap-3 border-t border-border px-4 py-3 active:bg-subtle disabled:opacity-40"
              >
                <View
                  className={cn(
                    "h-4 w-4 rounded-full border-2",
                    selected ? "border-primary bg-primary" : "border-border",
                  )}
                />
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-ryco-medium text-foreground">{option.label}</Text>
                  {option.disabledReason ? (
                    <Text className="text-xs text-foreground-muted">{option.disabledReason}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {control.deleteBranch !== null ? (
        <View className="flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3">
          <Text className="flex-1 text-base font-ryco-medium text-foreground">
            Delete the branch after merging
          </Text>
          <Switch
            value={control.deleteBranch}
            disabled={busy}
            onValueChange={control.setDeleteBranch}
          />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy || control.blockedReason !== null}
        onPress={() => control.runMerge(props.onClose)}
        className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-sm font-ryco-bold text-primary-foreground">
          {busy ? "Merging…" : merge.confirmLabel}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

/** Review, merge and update-branch for an open pull request; nothing when none applies. */
export function PullRequestActionsPanel(props: { readonly control: PullRequestActionsControl }) {
  const { control } = props;
  const [openedSheet, setSheet] = useState<PullRequestActionSheet | null>(null);
  // A sheet whose action went away (a refresh found the pull request merged)
  // closes instead of going blank, and stays closed if the action comes back.
  const sheet = shownPullRequestActionSheet(openedSheet, control);
  if (sheet !== openedSheet) setSheet(sheet);
  if (control.review === null && control.merge === null && control.updateBranch === null) {
    return control.notice ? (
      <Text className="px-5 text-sm font-ryco-medium text-success">{control.notice}</Text>
    ) : null;
  }
  const blocked = control.blockedReason !== null;
  const confirmUpdate = () =>
    Alert.alert(
      "Update the branch?",
      control.updateBranch?.method === "rebase"
        ? "Rebases the branch onto its base. Anyone else working on it will need to pull."
        : "Merges the base branch into this branch.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Update", onPress: control.runUpdateBranch },
      ],
    );
  return (
    <View className="gap-2 px-4">
      {control.notice ? (
        <Text className="px-1 text-sm font-ryco-medium text-success">{control.notice}</Text>
      ) : null}
      {control.error && sheet === null ? <ErrorBanner message={control.error} /> : null}
      {control.blockedReason ? (
        <Text className="px-1 text-xs text-foreground-muted">{control.blockedReason}</Text>
      ) : null}
      <View className="flex-row gap-2">
        {control.merge ? (
          <PanelButton
            label={control.pending === "merge" ? "Merging…" : control.merge.label}
            primary
            disabled={blocked || control.pending !== null}
            onPress={() => setSheet("merge")}
          />
        ) : null}
        {control.updateBranch ? (
          <PanelButton
            label={control.pending === "update-branch" ? "Updating…" : "Update branch"}
            primary={control.merge === null}
            disabled={blocked || control.pending !== null}
            onPress={confirmUpdate}
          />
        ) : null}
        {control.review ? (
          <PanelButton
            label={control.pending === "review" ? "Sending…" : "Review"}
            disabled={blocked || control.pending !== null}
            onPress={() => setSheet("review")}
          />
        ) : null}
      </View>
      <Modal
        visible={sheet !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheet(null)}
      >
        {sheet === "review" ? (
          <ReviewSheet control={control} onClose={() => setSheet(null)} />
        ) : sheet === "merge" ? (
          <MergeSheet control={control} onClose={() => setSheet(null)} />
        ) : null}
      </Modal>
    </View>
  );
}
