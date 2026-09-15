import {
  hasRetiredProjectMemory,
  REMOVED_PROJECT_MEMORY_MESSAGE,
} from "@ryco/shared/retiredFeatures";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { QueuedThreadMessage } from "../../state/threadOutboxModel";

function summary(message: QueuedThreadMessage): string {
  const text = message.text.trim();
  if (text.length > 0) return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  if (message.attachments.length === 1) return "1 image";
  if (message.attachments.length > 1) return `${message.attachments.length} images`;
  return "Queued message";
}

export function ThreadQueuedMessages(props: {
  readonly messages: ReadonlyArray<QueuedThreadMessage>;
  readonly steeringIds: ReadonlySet<string>;
  readonly getSteerUnavailableReason: (message: QueuedThreadMessage) => string | null;
  readonly onSteer: (message: QueuedThreadMessage) => void;
  readonly onRemove: (messageId: string) => void;
}) {
  const iconColor = String(useThemeColor("--color-icon"));
  const mutedColor = String(useThemeColor("--color-icon-subtle"));
  if (props.messages.length === 0) return null;

  return (
    <View className="mx-4 mb-1 rounded-2xl border border-border bg-subtle/70 px-3 py-2">
      <Text className="mb-1 text-2xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
        Queued · {props.messages.length}
      </Text>
      {props.messages.map((message) => {
        const unavailableReason = props.getSteerUnavailableReason(message);
        const steering = props.steeringIds.has(message.messageId);
        return (
          <View key={message.messageId} className="flex-row items-center gap-2 py-1">
            <Text className="flex-1 text-sm text-foreground">
              {hasRetiredProjectMemory(message) ? REMOVED_PROJECT_MEMORY_MESSAGE : summary(message)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                unavailableReason ??
                (steering ? "Steering queued message" : "Steer queued message into active turn")
              }
              disabled={unavailableReason !== null || steering}
              onPress={() => props.onSteer(message)}
              className="h-9 flex-row items-center justify-center gap-1 rounded-full bg-subtle-strong px-3 active:opacity-70 disabled:opacity-40"
            >
              <SymbolView
                name="arrow.turn.left.up"
                size={14}
                tintColor={steering ? mutedColor : iconColor}
                type="monochrome"
              />
              <Text className="text-xs font-ryco-bold text-foreground">
                {steering ? "Steering…" : "Steer"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Remove queued message"
              onPress={() => props.onRemove(message.messageId)}
              className="h-9 w-9 items-center justify-center rounded-full active:bg-subtle-strong"
            >
              <SymbolView name="xmark" size={15} tintColor={mutedColor} type="monochrome" />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
