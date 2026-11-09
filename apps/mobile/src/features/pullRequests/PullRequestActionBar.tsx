import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import {
  EMPTY_REVIEW_DRAFT,
  selectReviewDraft,
} from "@ryco/client-runtime/state/pull-request-review";
import type { SourceControlChangeRequestMergeMethod } from "@ryco/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { MergeSheet, ReviewSheet } from "./PullRequestActionsPanel";
import { pullRequestActionBarModel } from "./pullRequestActionBarModel";
import {
  describeOutdatedDraftComments,
  splitDraftCommentsByHead,
} from "./pullRequestFileReviewModel";
import { usePullRequestReviewDrafts } from "./pullRequestReviewDrafts";
import {
  shownPullRequestActionSheet,
  type PullRequestActionSheet,
} from "./pullRequestActionsModel";
import type { PullRequestActionsControl } from "./usePullRequestActions";

/** The bar's height above the safe area, so the list can leave room for it. */
export const PULL_REQUEST_ACTION_BAR_HEIGHT = 72;

function BarButton(props: {
  readonly label: string;
  readonly symbol?: string;
  readonly tone: "primary" | "secondary" | "success";
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly flex?: number;
}) {
  const primaryForeground = useThemeColor("--color-primary-foreground") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const tint = props.tone === "secondary" ? foreground : primaryForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ flex: props.flex ?? 1 }}
      className={cn(
        "h-12 flex-row items-center justify-center gap-1.5 rounded-full px-4 active:opacity-80 disabled:opacity-40",
        props.tone === "primary" && "bg-primary",
        props.tone === "success" && "bg-success",
        props.tone === "secondary" && "bg-subtle",
      )}
    >
      {props.symbol ? <SymbolView name={props.symbol as never} size={15} tintColor={tint} /> : null}
      <Text
        className={cn(
          "text-sm font-ryco-bold",
          props.tone === "secondary" ? "text-foreground" : "text-primary-foreground",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * The pull request's actions, pinned to the bottom like the host's own app:
 * Review (the full sheet), a one-tap Approve where the viewer may approve,
 * and Merge with its method in a menu. Update branch sits in that menu too.
 * Nothing shows when no action applies.
 */
export function PullRequestActionBar(props: {
  readonly control: PullRequestActionsControl;
  readonly number: number;
}) {
  const { control } = props;
  const insets = useSafeAreaInsets();
  const icon = useThemeColor("--color-primary-foreground") as string;
  const barTint = useThemeColor("--color-glass-surface") as string;
  const warning = useThemeColor("--color-warning") as string;
  const [openedSheet, setSheet] = useState<PullRequestActionSheet | null>(null);
  const draftKey = control.draftKey;
  const draftComments = usePullRequestReviewDrafts(
    useShallow((state) => {
      const comments = draftKey === null ? [] : selectReviewDraft(state, draftKey).comments;
      const byHead = splitDraftCommentsByHead(comments, control.headSha);
      return {
        current: byHead.current,
        outdatedNote: describeOutdatedDraftComments(byHead.outdated),
      };
    }),
  );
  const sheet = shownPullRequestActionSheet(openedSheet, control);
  if (sheet !== openedSheet) setSheet(sheet);
  const bar = pullRequestActionBarModel(control);
  if (bar === null) return null;
  const busy = control.pending !== null;
  const blocked = control.blockedReason !== null;

  // The draft is read on press: approving sends its line comments and summary too.
  const approve = () =>
    Alert.alert(
      `Approve #${props.number}?`,
      [
        draftComments.current > 0
          ? `Sends an approving review with your ${draftComments.current} line ${draftComments.current === 1 ? "comment" : "comments"}.`
          : "Sends an approving review.",
        draftComments.outdatedNote,
      ]
        .filter((line) => line !== null)
        .join(" "),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve",
          onPress: () => {
            const draft =
              draftKey === null
                ? EMPTY_REVIEW_DRAFT
                : selectReviewDraft(usePullRequestReviewDrafts.getState(), draftKey);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            control.submitReview({ ...draft, event: "approve" }, () => undefined);
          },
        },
      ],
    );
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
  const onMenuAction = (event: NativeActionEvent) => {
    const id = event.nativeEvent.event;
    if (id === "update-branch") {
      confirmUpdate();
      return;
    }
    if (id.startsWith("method:")) {
      void Haptics.selectionAsync();
      control.setMethod(id.slice("method:".length) as SourceControlChangeRequestMergeMethod);
    }
  };

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 bottom-0 px-3"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      {control.newCommits ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New commits since you opened this. Show them."
          onPress={() => {
            void Haptics.selectionAsync();
            control.showNewCommits();
          }}
          className="mb-2 flex-row items-center gap-2 self-center rounded-full bg-warning-bg px-4 py-2 active:opacity-70"
        >
          <SymbolView name="arrow.triangle.2.circlepath" size={12} tintColor={warning} />
          <Text className="text-xs font-ryco-bold text-warning">
            New commits since you opened this · Show
          </Text>
        </Pressable>
      ) : control.error && sheet === null ? (
        <View className="mb-2 rounded-2xl bg-danger px-4 py-2.5">
          <Text className="text-xs text-danger-foreground">{control.error}</Text>
        </View>
      ) : control.notice ? (
        <View className="mb-2 self-center rounded-full bg-success-bg px-4 py-2">
          <Text className="text-xs font-ryco-bold text-success">{control.notice}</Text>
        </View>
      ) : blocked ? (
        <Text className="mb-2 px-2 text-center text-xs text-foreground-muted">
          {control.blockedReason}
        </Text>
      ) : null}
      <GlassSurface radius={30} tintColor={barTint} style={{ padding: 6 }}>
        <View className="flex-row items-center gap-1.5">
          {bar.review ? (
            <BarButton
              label={
                control.pending === "review"
                  ? "Sending…"
                  : draftComments.current > 0
                    ? `Review · ${draftComments.current}`
                    : "Review"
              }
              tone="secondary"
              disabled={blocked || busy}
              onPress={() => setSheet("review")}
              flex={bar.merge ? 0.8 : 1}
            />
          ) : null}
          {bar.approve ? (
            <BarButton
              label="Approve"
              symbol="checkmark"
              tone={bar.merge ? "secondary" : "success"}
              disabled={blocked || busy}
              onPress={approve}
              flex={bar.merge ? 0.9 : 1}
            />
          ) : null}
          {bar.merge ? (
            <View className="flex-row" style={{ flex: 1.6 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={bar.merge.label}
                disabled={blocked || busy}
                onPress={() => (control.merge ? setSheet("merge") : confirmUpdate())}
                className={cn(
                  "h-12 flex-1 items-center justify-center bg-primary pl-4 pr-2 active:opacity-80 disabled:opacity-40",
                  bar.merge.menu.length > 0 ? "rounded-l-full" : "rounded-full",
                )}
              >
                <Text className="text-sm font-ryco-bold text-primary-foreground" numberOfLines={1}>
                  {control.pending === "merge"
                    ? "Merging…"
                    : control.pending === "update-branch"
                      ? "Updating…"
                      : bar.merge.label}
                </Text>
              </Pressable>
              {bar.merge.menu.length > 0 ? (
                <MenuView
                  title="Merge method"
                  actions={bar.merge.menu.map((item): MenuAction => ({
                    id: item.id,
                    title: item.title,
                    subtitle: item.subtitle,
                    state: item.checked ? "on" : "off",
                    attributes: { disabled: item.disabled },
                  }))}
                  onPressAction={onMenuAction}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Merge options"
                    disabled={busy}
                    className="h-12 w-11 items-center justify-center rounded-r-full border-l border-primary-foreground/20 bg-primary active:opacity-80 disabled:opacity-40"
                  >
                    <SymbolView name="chevron.down" size={13} tintColor={icon} />
                  </Pressable>
                </MenuView>
              ) : null}
            </View>
          ) : null}
        </View>
      </GlassSurface>
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
