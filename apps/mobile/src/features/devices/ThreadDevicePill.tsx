import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadDevice } from "./useThreadDevice";

/**
 * Above the composer while the thread's agent has a simulator or emulator attached: names it and
 * opens the full-screen viewer (T3's device preview button).
 */
export function ThreadDevicePill(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpen: () => void;
}) {
  const { preview } = useThreadDevice(props.environmentId, props.threadId);
  const iconColor = useThemeColor("--color-foreground-secondary");
  if (preview === null) return null;
  const detail = preview.attaching
    ? "Starting…"
    : preview.agentActive
      ? "Agent is using it"
      : "Watch";
  return (
    <View className="flex-row px-4 pb-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Watch ${preview.name}`}
        onPress={props.onOpen}
        className="flex-row items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 active:opacity-70"
      >
        <SymbolView name="iphone" size={13} tintColor={iconColor as string} />
        <Text className="text-[13px] font-medium text-foreground" numberOfLines={1}>
          {preview.name}
        </Text>
        <Text className="text-[13px] text-foreground-tertiary">· {detail}</Text>
      </Pressable>
    </View>
  );
}
