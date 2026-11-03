import type { FollowUpQueueBadge } from "@ryco/client-runtime/state/message-queue/queueBadge";
import { View } from "react-native";

import { AppText as Text } from "./AppText";

/**
 * A thread row's mark for follow-ups its node queue holds: "2 queued", or "2 held" in the warning
 * color when nothing goes out without the person. The words carry the state, not the color alone.
 * The row puts the queue's sentence (`badge.title`, "1 queued follow-up: Paused after an error")
 * in its own spoken label, since a pressable row reads as one element.
 */
export function FollowUpQueueMark(props: { readonly badge: FollowUpQueueBadge }) {
  return (
    <View
      className={`rounded-full border px-1.5 ${props.badge.held ? "border-warning" : "border-border"}`}
    >
      <Text
        className={`text-2xs font-ryco-medium ${
          props.badge.held ? "text-warning" : "text-foreground-tertiary"
        }`}
      >
        {props.badge.label}
      </Text>
    </View>
  );
}
