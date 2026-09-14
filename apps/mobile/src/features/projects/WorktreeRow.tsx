import { IconGitBranch, IconGitFork } from "@tabler/icons-react-native";
import { ChangeRequestBadge } from "../../components/ChangeRequestBadge";
import { buildChangeRequestBadge } from "../../lib/changeRequestBadge";
import { Pressable, View } from "react-native";

import type { SidebarWorktreeSummary } from "@ryco/client-runtime/state/threads";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

function SmallAction(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className={`h-11 items-center justify-center rounded-full px-4 active:bg-subtle-strong ${
        props.destructive ? "bg-danger" : "bg-subtle"
      }`}
    >
      <Text
        className={`text-sm font-ryco-bold ${
          props.destructive ? "text-danger-foreground" : "text-foreground"
        }`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function WorktreeRow(props: {
  readonly worktree: SidebarWorktreeSummary;
  readonly threadCount: number;
  readonly onNewTask?: () => void;
  readonly onRename?: () => void;
  readonly onArchive?: () => void;
  readonly onRestore?: () => void;
  readonly onSourceControl?: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const title = props.worktree.title?.trim() || props.worktree.branch;
  const WorkspaceIcon = props.worktree.worktreePath ? IconGitFork : IconGitBranch;
  const badge = buildChangeRequestBadge(props.worktree);
  const archived = props.worktree.archivedAt !== null;

  return (
    <View className="rounded-2xl bg-card p-4">
      <View className="flex-row items-start gap-2">
        <View className="pt-0.5">
          <WorkspaceIcon size={18} strokeWidth={1.75} color={iconColor as string} />
        </View>
        <Text
          className="min-w-0 flex-1 text-[16px] leading-[21px] font-ryco-medium text-foreground"
          numberOfLines={2}
        >
          {title}
        </Text>
        {badge ? <ChangeRequestBadge badge={badge} /> : null}
      </View>
      {title !== props.worktree.branch ? (
        <Text
          className="mt-2 font-mono text-xs text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {props.worktree.branch}
        </Text>
      ) : null}
      <View className="mt-2 flex-row flex-wrap items-center gap-2">
        <Text className="text-xs text-foreground-tertiary">
          {props.worktree.worktreePath ? "Worktree" : "Original directory"}
        </Text>
        <Text className="text-xs text-foreground-tertiary">
          · {props.threadCount} task{props.threadCount === 1 ? "" : "s"}
        </Text>
      </View>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {archived && props.onRestore ? (
          <SmallAction label="Restore" onPress={props.onRestore} />
        ) : (
          <>
            {props.onNewTask ? <SmallAction label="New task" onPress={props.onNewTask} /> : null}
            {props.onSourceControl ? (
              <SmallAction label="Source Control" onPress={props.onSourceControl} />
            ) : null}
            {props.onRename ? <SmallAction label="Rename" onPress={props.onRename} /> : null}
            {props.onArchive ? (
              <SmallAction label="Archive" destructive onPress={props.onArchive} />
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
