import { IconGitBranch, IconGitFork } from "@tabler/icons-react-native";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useThemeColor } from "../../lib/useThemeColor";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ChangeRequestBadge } from "../../components/ChangeRequestBadge";
import { ProviderIcon } from "../../components/ProviderIcon";
import { relativeTime } from "../../lib/time";
import type { InboxThreadRow as InboxThreadRowModel, InboxThreadState } from "./inboxModel";

function statusDotClassName(state: InboxThreadState): string {
  switch (state) {
    case "needs-input":
      return "bg-warning";
    case "delivery-unknown":
    case "error":
      return "bg-danger-foreground";
    case "working":
    case "connecting":
      return "bg-accent";
    case "reconnecting":
      return "border-2 border-warning";
    case "offline":
    case "idle":
      return "border border-foreground-tertiary";
    case "settled":
      return "bg-foreground-tertiary";
  }
}

function statusTextClassName(state: InboxThreadState): string {
  switch (state) {
    case "needs-input":
    case "reconnecting":
      return "text-warning";
    case "delivery-unknown":
    case "error":
      return "text-danger-foreground";
    case "working":
    case "connecting":
      return "text-accent-strong";
    case "offline":
    case "idle":
    case "settled":
      return "text-foreground-tertiary";
  }
}

export function InboxThreadRow(props: {
  readonly row: InboxThreadRowModel;
  readonly onPress: () => void;
  readonly onLongPress?: (() => void) | undefined;
}) {
  const row = props.row;
  const iconColor = useThemeColor("--color-icon-subtle");
  const WorkspaceIcon = row.isWorktree ? IconGitFork : IconGitBranch;
  const showStatus = row.state !== "idle" && row.state !== "settled";
  const accessibilityLabel = [
    row.title,
    row.contextLabel,
    row.isWorktree ? "Worktree" : "Original directory",
    row.statusLabel,
    row.roleLabel,
    row.changeRequest?.accessibilityLabel,
    row.providerLabel ? `Provider: ${row.providerLabel}` : null,
    row.focusTitle,
    row.focusDetail,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      className="mx-4 mb-2 gap-2 rounded-2xl bg-card px-3.5 py-3 active:bg-card-alt"
    >
      <View className="flex-row items-start gap-2">
        <View className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDotClassName(row.state)}`} />
        <Text
          className="min-w-0 flex-1 font-ryco-medium text-[15px] leading-[20px] text-foreground"
          numberOfLines={2}
        >
          {row.title}
        </Text>
        <Text
          className="pt-0.5 text-2xs text-foreground-tertiary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {relativeTime(row.updatedAt)}
        </Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <ProjectFavicon
          environmentId={row.environmentId}
          projectId={row.project?.id}
          projectTitle={row.projectLabel}
          customAvatarContentHash={row.project?.customAvatarContentHash}
          size={16}
        />
        <Text
          className="min-w-0 flex-1 font-ryco-medium text-xs text-foreground-muted"
          numberOfLines={1}
        >
          {row.projectLabel}
        </Text>
        {row.changeRequest ? <ChangeRequestBadge badge={row.changeRequest} /> : null}
        <View accessibilityElementsHidden className="ml-1 shrink-0">
          <ProviderIcon provider={row.providerDriver} size={15} />
        </View>
      </View>
      <View className="flex-row items-center gap-1.5">
        <WorkspaceIcon size={13} strokeWidth={1.75} color={iconColor as string} />
        <Text
          className="min-w-0 flex-1 text-2xs text-foreground-tertiary"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {row.worktreeLabel}
        </Text>
        <View className="max-w-[120px] flex-row items-center gap-1">
          <DeviceIcon environmentId={row.environmentId} size={12} />
          <Text className="shrink text-2xs text-foreground-tertiary" numberOfLines={1}>
            {row.nodeLabel}
          </Text>
        </View>
      </View>
      {row.focusTitle ? (
        <View className="gap-0.5">
          <Text className="font-ryco-medium text-xs text-foreground" numberOfLines={1}>
            {row.focusTitle}
            {row.focusAiGenerated ? " · AI" : ""}
          </Text>
          {row.focusDetail ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={2}>
              {row.focusDetail}
            </Text>
          ) : null}
        </View>
      ) : null}
      {(showStatus && !row.focusTitle) || row.roleLabel || row.snoozedUntil ? (
        <View className="flex-row flex-wrap items-center gap-2">
          {showStatus && !row.focusTitle ? (
            <Text className={`text-xs font-ryco-medium ${statusTextClassName(row.state)}`}>
              {row.statusLabel}
            </Text>
          ) : null}
          {row.roleLabel ? (
            <Text className="text-xs text-foreground-tertiary">{row.roleLabel}</Text>
          ) : null}
          {row.snoozedUntil ? (
            <Text className="text-xs text-foreground-tertiary">
              Until{" "}
              {new Date(row.snoozedUntil).toLocaleString(undefined, {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
