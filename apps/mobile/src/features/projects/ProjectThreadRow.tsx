import { followUpQueueBadgeOf } from "@ryco/client-runtime/state/message-queue/queueBadge";
import type { SidebarThreadSummary } from "@ryco/client-runtime/state/threads";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { FollowUpQueueMark } from "../../components/FollowUpQueueMark";
import { useThemeColor } from "../../lib/useThemeColor";

/**
 * A task on the project screen. It marks follow-ups the node queues for the thread as the
 * inbox row does, and reads the queue's sentence to a screen reader.
 */
export function ProjectThreadRow(props: {
  readonly thread: SidebarThreadSummary;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const followUpQueue = followUpQueueBadgeOf(props.thread.followUpQueueSummary);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[`Open task ${props.thread.title}`, followUpQueue?.title]
        .filter(Boolean)
        .join(", ")}
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 rounded-xl bg-subtle px-4 py-3 active:bg-subtle-strong"
    >
      <Text className="min-w-0 flex-1 text-sm font-ryco-medium text-foreground" numberOfLines={1}>
        {props.thread.title}
      </Text>
      {followUpQueue ? <FollowUpQueueMark badge={followUpQueue} /> : null}
      <SymbolView
        name="chevron.right"
        size={14}
        tintColor={iconColor as string}
        type="monochrome"
      />
    </Pressable>
  );
}
